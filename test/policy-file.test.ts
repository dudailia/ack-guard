// policy.yaml is the guard's configuration. These tests pin it to the merchant
// catalog and limits the recorded benchmark ran with, and check the loader's
// validation and the per-rule switches.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { CURRENCY, DECIMALS, POLICY_LIMITS } from "../src/config.js"
import { LEGIT_MERCHANTS, merchantSpecs } from "../src/merchants/catalog.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { evaluatePayment } from "../src/policy/engine.js"
import { loadPolicyFile, parsePolicy, REPO_POLICY_PATH } from "../src/policy/policy-file.js"
import { testIdentities } from "./helpers.js"

describe("policy.yaml", () => {
  it("is exactly the configuration the benchmark was recorded with", async () => {
    const ids = await testIdentities()
    const specs = merchantSpecs(ids)
    const fromCatalog = LEGIT_MERCHANTS.map((k) => ({
      key: specs[k].key,
      displayName: specs[k].displayName,
      did: specs[k].identity.did,
      hosts: [specs[k].host],
      recipient: specs[k].identity.did,
      endpoints: specs[k].endpoints.map((e) => ({ path: e.path, capability: e.capability, price: e.price, currency: CURRENCY, decimals: DECIMALS })),
    }))
    const c = buildPolicyConfig(ids)
    expect(c.merchants).toEqual(fromCatalog)
    expect(c.limits).toEqual(POLICY_LIMITS)
    expect(Object.values(c.rules ?? {}).every((r) => r.enabled)).toBe(true)
    expect(c.rules?.HUMAN_APPROVAL?.onFail).toBe("needs_approval")
    expect(Object.entries(c.rules ?? {}).filter(([, r]) => r.onFail === "needs_approval").map(([k]) => k)).toEqual(["HUMAN_APPROVAL"])
  })

  it("has a version derived from its content", () => {
    const a = loadPolicyFile()
    const b = parsePolicy(readFileSync(REPO_POLICY_PATH, "utf8").replace('daily_cap: "20.00"', 'daily_cap: "15.00"'))
    expect(a.version).toMatch(/^v1-[0-9a-f]{12}$/)
    expect(b.hash).not.toBe(a.hash)
    // Comments and formatting do not change the version.
    expect(parsePolicy(`# a comment\n${a.text}`).hash).toBe(a.hash)
  })

  it("rejects malformed or unsafe policies with a plain reason", () => {
    const t = loadPolicyFile().text
    expect(() => parsePolicy(t.replace('per_payment_cap: "5.00"', "per_payment_cap: lots"))).toThrow(/per_payment_cap/)
    expect(() => parsePolicy(t.replace("  - id: TASK_BUDGET", "  - id: DAILY_CAP_X"))).toThrow(/rules must list exactly/)
    expect(() => parsePolicy(t.replace("plain: The bill must carry", "enabled: false\n    plain: The bill must carry"))).toThrow(/REQ_SIGNATURE cannot be switched off/)
    expect(() => parsePolicy(t.replace('price: "0.25"', 'price: "-1"'))).toThrow(/price/)
  })

  it("a switched-off rule is recorded but cannot decide; escalate sends a failure to a human", async () => {
    const ids = await testIdentities()
    const base = buildPolicyConfig(ids)
    const sky = base.merchants[0]!
    const facts = {
      requestSignature: { ok: true, issuer: sky.did, requestId: "r1" },
      option: { id: "o", amount: 25n, decimals: 2, currency: "USD", recipient: sky.recipient },
      identity: { ok: true, agentDid: base.agentDid, controller: base.ownerDid },
      provenance: { ok: true, url: "http://skycast.test/forecast?city=Boston", host: "skycast.test", path: "/forecast" },
    }
    const task = { id: "t", prompt: "", needs: ["weather.alerts"], budget: 500n }
    const history = { payments: [] }
    expect(evaluatePayment(facts as never, task, base, history, Date.now()).rule.id).toBe("PURPOSE_BINDING")
    const off = { ...base, rules: { ...base.rules, PURPOSE_BINDING: { enabled: false, onFail: "deny" as const } } }
    const d = evaluatePayment(facts as never, task, off, history, Date.now())
    expect(d.outcome).toBe("allow")
    expect(d.checks.find((c) => c.id === "PURPOSE_BINDING")).toMatchObject({ passed: false, disabled: true })
    expect(d.rule.detail).toMatch(/PURPOSE_BINDING switched off/)
    const esc = { ...base, rules: { ...base.rules, PURPOSE_BINDING: { enabled: true, onFail: "needs_approval" as const } } }
    expect(evaluatePayment(facts as never, task, esc, history, Date.now()).outcome).toBe("needs_approval")
  })
})
