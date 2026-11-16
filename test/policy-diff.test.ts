// Policy diff and signed approvals.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { resolveModel } from "../src/agent/model.js"
import { approvePolicyChange, activePolicyPath, loadActivePolicy, policyLogPath } from "../src/policy/approvals.js"
import { policyDiff } from "../src/policy/diff.js"
import { loadPolicyFile, parsePolicy, type LoadedPolicy } from "../src/policy/policy-file.js"
import { selectScenarios } from "../src/redteam/index.js"
import { runSuite } from "../src/redteam/runner.js"
import type { Identities } from "../src/identity/identities.js"
import { testIdentities, tmpLogPath } from "./helpers.js"

let ids: Identities
let log: string
let current: LoadedPolicy
const variant = (f: (t: string) => string) => parsePolicy(f(current.text))

beforeAll(async () => {
  ids = await testIdentities()
  const out = dirname(tmpLogPath())
  // A legit forecast, two translations, a fake invoice, and a $1.50 purchase held for a human.
  await runSuite({ ids, scenarios: selectScenarios("B-01,B-05,FI-01,B-09"), model: resolveModel("scripted"), runs: 1, outDir: out, modes: ["guarded"] })
  log = join(out, "audit.jsonl")
  current = loadPolicyFile()
}, 60_000)

describe("policy diff", () => {
  it("the same policy changes nothing", async () => {
    const d = await policyDiff(log, current, current, { expectedSignerDid: ids.parties.guard.did })
    expect(d.logVerified).toBe(true)
    expect(d.decisionsReplayed).toBeGreaterThanOrEqual(5)
    expect(d.changes).toEqual([])
    expect(d.notReproduced).toEqual([])
  })

  it("a lower approval threshold sends past payments to a human, and says so in plain English", async () => {
    const p = variant((t) => t.replace('approval_threshold: "1.00"', 'approval_threshold: "0.40"'))
    const d = await policyDiff(log, current, p, { expectedSignerDid: ids.parties.guard.did })
    expect(d.policyChanges).toEqual(["Payments need a human above: $1.00 -> $0.40"])
    // The two $0.50 translations of B-05 would now wait for a human; the $0.25 forecast would not.
    const esc = d.changes.filter((c) => c.change === "now escalated")
    expect(esc.map((c) => c.scenarioId)).toEqual(["B-05", "B-05"])
    expect(esc.every((c) => c.amount === "$0.50" && c.proposed.rule === "HUMAN_APPROVAL")).toBe(true)
    expect(esc[1]!.afterEarlierChange).toBe(true)
  })

  it("removing a merchant blocks its past payments; a higher threshold lets the held one through", async () => {
    const noLingua = variant((t) => t.replace(/  - key: lingua[\s\S]*?(?=  - key: geopoint)/, ""))
    const d1 = await policyDiff(log, current, noLingua, { expectedSignerDid: ids.parties.guard.did })
    expect(d1.policyChanges).toContain("Merchant removed: LinguaBridge Translate")
    expect(d1.changes.filter((c) => c.change === "now blocked").map((c) => c.proposed.rule)).toEqual(["MERCHANT_ALLOWLIST", "MERCHANT_ALLOWLIST"])

    const higher = variant((t) => t.replace('approval_threshold: "1.00"', 'approval_threshold: "2.00"'))
    const d2 = await policyDiff(log, current, higher, { expectedSignerDid: ids.parties.guard.did })
    expect(d2.changes.map((c) => [c.scenarioId, c.change])).toEqual([["B-09", "now allowed"]])
  })

  it("switching off provenance does not let the fake invoice through: the next rule catches it", async () => {
    const p = variant((t) => t.replace("    plain: A bill only counts", "    enabled: false\n    plain: A bill only counts"))
    const d = await policyDiff(log, current, p, { expectedSignerDid: ids.parties.guard.did })
    const fi = d.changes.filter((c) => c.scenarioId === "FI-01")
    expect(fi.length).toBeGreaterThan(0)
    expect(fi.every((c) => c.change === "different rule" && c.proposed.outcome === "deny" && c.proposed.rule === "MERCHANT_ALLOWLIST")).toBe(true)
  })

  it("refuses to replay a log that does not verify", async () => {
    const bad = join(mkdtempSync(join(tmpdir(), "ack-guard-diff-")), "audit.jsonl")
    writeFileSync(bad, readFileSync(log, "utf8").replace('"outcome":"deny"', '"outcome":"allow"'))
    writeFileSync(bad.replace(/\.jsonl$/, ".head.json"), readFileSync(log.replace(/\.jsonl$/, ".head.json"), "utf8"))
    const d = await policyDiff(bad, current, current, { expectedSignerDid: ids.parties.guard.did })
    expect(d.logVerified).toBe(false)
    expect(d.decisionsReplayed).toBe(0)
  })
})

describe("policy approvals", () => {
  it("an approved change is owner-signed, logged, and becomes the active policy; nothing else can", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ack-guard-policy-"))
    expect((await loadActivePolicy(ids, dir)).source).toBe("repository")
    const p = variant((t) => t.replace('daily_cap: "20.00"', 'daily_cap: "15.00"'))
    const diff = await policyDiff(log, current, p, { expectedSignerDid: ids.parties.guard.did })
    const { entry } = await approvePolicyChange({ ids, current, proposed: p, diff, dir })
    expect(entry.kind).toBe("policy_change")
    const a = await loadActivePolicy(ids, dir)
    expect(a.source).toBe("approved")
    expect(a.policy.hash).toBe(p.hash)

    // Editing the active file without an approval is refused.
    writeFileSync(activePolicyPath(dir), p.text.replace('daily_cap: "15.00"', 'daily_cap: "99.00"'))
    await expect(loadActivePolicy(ids, dir)).rejects.toThrow(/not the last approved policy/)
    writeFileSync(activePolicyPath(dir), p.text)
    // Editing the policy log is refused.
    const lp = policyLogPath(dir)
    const orig = readFileSync(lp, "utf8")
    writeFileSync(lp, orig.replace('daily_cap: \\"15.00\\"', 'daily_cap: \\"99.00\\"'))
    await expect(loadActivePolicy(ids, dir)).rejects.toThrow(/does not verify/)
    writeFileSync(lp, orig)
    expect((await loadActivePolicy(ids, dir)).source).toBe("approved")
  })

  it("an approval must match the diff that was shown, and must come from the owner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ack-guard-policy-"))
    const p = variant((t) => t.replace('daily_cap: "20.00"', 'daily_cap: "15.00"'))
    const q = variant((t) => t.replace('daily_cap: "20.00"', 'daily_cap: "10.00"'))
    const diffForP = await policyDiff(log, current, p, { expectedSignerDid: ids.parties.guard.did })
    await expect(approvePolicyChange({ ids, current, proposed: q, diff: diffForP, dir })).rejects.toThrow(/different policy change/)
    // Signed by someone other than the owner: logged, but the guard will not load it.
    await approvePolicyChange({ ids, current, proposed: p, diff: diffForP, dir, approver: ids.parties.attacker })
    await expect(loadActivePolicy(ids, dir)).rejects.toThrow(/not approved by the configured owner/)
  })
})
