// Delegation chains: verification of every link, and the rule that a child can
// never exceed its parent's remaining budget or capabilities, including when
// parent and child pay concurrently.

import fc from "fast-check"
import { dirname } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { resolveModel } from "../src/agent/model.js"
import { usd } from "../src/config.js"
import { createSubAgent, issueDelegation, verifyDelegationChain } from "../src/identity/delegation.js"
import { AGENT_DID_BASE_URL, type Identities, type Party } from "../src/identity/identities.js"
import { SpendStore } from "../src/policy/spend-store.js"
import { selectScenarios } from "../src/redteam/index.js"
import { runSuite } from "../src/redteam/runner.js"
import { readRows } from "../src/redteam/summary.js"
import { World } from "../src/world.js"
import { testIdentities, tmpAudit, tmpLogPath } from "./helpers.js"

const H = 3600 * 1000
const scope = (cents: number, capabilities: string[]) => ({ budget: BigInt(cents), currency: "USD" as const, capabilities })
let ids: Identities
let sub: Party
let subsub: Party

beforeAll(async () => {
  ids = await testIdentities()
  sub = ids.parties.subagent
  subsub = await createSubAgent("helper", sub.did, ids.resolver, `${AGENT_DID_BASE_URL}/sub/forecaster`)
})

const opts = (payer: string) => ({ resolver: ids.resolver, ownerDid: ids.parties.owner.did, rootAgentDid: ids.parties.agent.did, payerDid: payer })

describe("delegation chain verification", () => {
  it("accepts owner -> agent -> sub-agent -> helper, each link signed by its parent", async () => {
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, scope: scope(200, ["weather.forecast"]) })
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(100, ["weather.forecast"]) })
    const l2 = await issueDelegation({ parent: sub, childDid: subsub.did, scope: scope(50, ["weather.forecast"]) })
    const v = await verifyDelegationChain([l0, l1, l2], opts(subsub.did))
    expect(v.ok).toBe(true)
    expect(v.links.map((l) => l.scope?.budget)).toEqual(["200", "100", "50"])
    // The research agent's existing, unscoped ControllerCredential works as the root.
    expect((await verifyDelegationChain([ids.controllerCredential, l1], opts(sub.did))).ok).toBe(true)
  })

  it("rejects a forged link, an expired link, a skipped parent, a wrong root and a chain that ends elsewhere", async () => {
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did })
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(50, ["weather.forecast"]) })
    const forged = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(9999, ["weather.history"]), signWith: ids.parties.attacker })
    const expired = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, issuedAt: new Date(Date.now() - 48 * H), expiresAt: new Date(Date.now() - H) })
    const skip = await issueDelegation({ parent: ids.parties.owner, childDid: sub.did })
    const wrongRoot = await issueDelegation({ parent: ids.parties.attacker, childDid: ids.parties.agent.did })
    const cases: [string[], RegExp][] = [
      [[l0, forged], /link 1 .*signature does not verify/],
      [[l0, expired], /link 1 .*expired/],
      [[l0, skip], /link 1 .*not by the parent/],
      [[wrongRoot, l1], /link 0 .*not by the parent/],
      [[l0], /ends at research-agent, not at the paying agent/],
    ]
    for (const [chain, re] of cases) {
      const v = await verifyDelegationChain(chain, opts(sub.did))
      expect(v.ok, String(re)).toBe(false)
      expect(v.error).toMatch(re)
    }
  })
})

describe("delegation chain as of a past time (dispute evidence)", () => {
  it("a chain valid at payment time still verifies after its links expire; a forged one never does", async () => {
    const { verifyDelegationChainAt } = await import("../src/identity/delegation.js")
    const issuedAt = new Date(Date.now() - 3 * H)
    const expiresAt = new Date(Date.now() - H)
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, issuedAt, expiresAt })
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, issuedAt, expiresAt, scope: scope(50, ["weather.forecast"]) })
    const forged = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, issuedAt, expiresAt, signWith: ids.parties.attacker })
    const paymentTime = new Date(Date.now() - 2 * H)
    expect((await verifyDelegationChain([l0, l1], opts(sub.did))).ok).toBe(false)
    expect((await verifyDelegationChainAt([l0, l1], { ...opts(sub.did), at: paymentTime })).ok).toBe(true)
    expect((await verifyDelegationChainAt([l0, l1], { ...opts(sub.did), at: new Date() })).ok).toBe(false)
    expect((await verifyDelegationChainAt([l0, forged], { ...opts(sub.did), at: paymentTime })).error).toMatch(/signature does not verify/)
  })
})

/** A world in which `payer` pays through `chain`, sharing `store`. */
function worldFor(payer: "agent" | "subagent", chain: string[], store: SpendStore, audit: Awaited<ReturnType<typeof tmpAudit>>, ep: string, needs = Array(8).fill("weather.forecast")) {
  return new World(ids, { task: { id: "shared-task", prompt: "", needs, budget: usd(5) }, delegation: { payer, chain } }, "guarded", audit, ep, undefined, store)
}
async function buy(w: World, city: string) {
  const r = (await w.httpGetForAgent(`http://skycast.test/forecast?city=${city}`)) as { payment_request: string }
  return w.pay({ paymentRequest: r.payment_request, purpose: "forecast" })
}

describe("DELEGATION_LIMITS", () => {
  it("a child cannot buy what its link does not delegate, nor what its parent's link does not", async () => {
    const audit = await tmpAudit(ids)
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, scope: scope(500, ["weather.forecast", "weather.alerts"]) })
    // The parent over-delegates: history, which the parent itself was never given.
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(500, ["weather.forecast", "weather.history"]) })
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.alerts", "weather.history"], budget: usd(5) }, delegation: { payer: "subagent", chain: [l0, l1] } }, "guarded", audit, "ep", async () => ({ approved: true, by: "test" }))
    const alerts = (await w.httpGetForAgent("http://skycast.test/alerts?city=Boston")) as { payment_request: string }
    const a = await w.pay({ paymentRequest: alerts.payment_request, purpose: "alerts" })
    expect(a.status === "blocked" && a.rule).toBe("DELEGATION_LIMITS")
    expect(a.status === "blocked" && a.reason).toMatch(/link 1 does not delegate weather.alerts/)
    const hist = (await w.httpGetForAgent("http://skycast.test/history?city=Boston")) as { payment_request: string }
    const h = await w.pay({ paymentRequest: hist.payment_request, purpose: "history" })
    expect(h.status === "blocked" && h.reason).toMatch(/link 0 does not delegate weather.history/)
  })

  it("a child's generous budget is capped by what its parent has left", async () => {
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, scope: scope(60, ["weather.forecast"]) })
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(1000, ["weather.forecast"]) })
    const w = worldFor("subagent", [l0, l1], store, audit, "ep")
    expect((await buy(w, "A")).status).toBe("paid")
    expect((await buy(w, "B")).status).toBe("paid")
    const third = await buy(w, "C")
    expect(third.status === "blocked" && third.reason).toMatch(/link 0 budget \$0\.60: \$0\.50 already spent under it/)
  })

  it("a re-encoded twin of the child's own link (ECDSA high-s) shares the link's budget (review finding)", async () => {
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, scope: scope(1000, ["weather.forecast"]) })
    const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(50, ["weather.forecast"]) })
    const [h, p, sg] = l1.split(".") as [string, string, string]
    const sig = Buffer.from(sg, "base64url")
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
    const s2 = (n - BigInt("0x" + sig.subarray(32, 64).toString("hex"))).toString(16).padStart(64, "0")
    const twin = `${h}.${p}.${Buffer.concat([sig.subarray(0, 32), Buffer.from(s2, "hex")]).toString("base64url")}`
    expect(twin).not.toBe(l1)
    const w = worldFor("subagent", [l0, l1], store, audit, "ep")
    expect((await buy(w, "A")).status).toBe("paid")
    expect((await buy(w, "B")).status).toBe("paid")
    const r = (await w.httpGetForAgent("http://skycast.test/forecast?city=C")) as { payment_request: string }
    const viaTwin = await w.pay({ paymentRequest: r.payment_request, purpose: "forecast", credential: twin })
    expect(viaTwin.status === "blocked" && viaTwin.rule).toBe("DELEGATION_LIMITS")
    expect(w.ledger.transfers.reduce((a, t) => a + t.amount, 0n)).toBe(50n)
  })

  it("spend under a link survives a restart of the persisted store after 48 hours (review finding)", async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const path = join(mkdtempSync(join(tmpdir(), "ack-guard-links-")), "spend.json")
    const a = new SpendStore(path)
    const old = Date.now() - 72 * H
    a.record({ ts: old, amount: 50n, taskId: "t", paymentRequestId: "r-link", merchantDid: "did:key:z", links: ["link:abc"] })
    a.record({ ts: old, amount: 25n, taskId: "t", paymentRequestId: "r-plain", merchantDid: "did:key:z" })
    a.record({ ts: Date.now(), amount: 1n, taskId: "t", paymentRequestId: "r-now", merchantDid: "did:key:z" })
    const b = new SpendStore(path)
    expect(b.history.payments.map((p) => p.paymentRequestId).sort()).toEqual(["r-link", "r-now"])
  })

  it("under concurrency, parent and child together never exceed the parent's link", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (rootQuarters, parentBuys, childBuys) => {
          const audit = await tmpAudit(ids)
          const store = new SpendStore()
          const l0 = await issueDelegation({ parent: ids.parties.owner, childDid: ids.parties.agent.did, scope: scope(rootQuarters * 25, ["weather.forecast"]) })
          const l1 = await issueDelegation({ parent: ids.parties.agent, childDid: sub.did, scope: scope(10_000, ["weather.forecast"]) })
          const parent = worldFor("agent", [l0], store, audit, "parent")
          const child = worldFor("subagent", [l0, l1], store, audit, "child")
          // Fetch every quote first, then fire all payments at once.
          const quotes = await Promise.all([
            ...Array.from({ length: parentBuys }, (_, i) => parent.httpGetForAgent(`http://skycast.test/forecast?city=p${i}`).then((r) => [parent, r] as const)),
            ...Array.from({ length: childBuys }, (_, i) => child.httpGetForAgent(`http://skycast.test/forecast?city=c${i}`).then((r) => [child, r] as const)),
          ])
          await Promise.all(quotes.map(([w, r]) => w.pay({ paymentRequest: (r as { payment_request: string }).payment_request, purpose: "forecast" })))
          const total = [...parent.ledger.transfers, ...child.ledger.transfers].reduce((a, t) => a + t.amount, 0n)
          expect(total).toBeLessThanOrEqual(BigInt(rootQuarters * 25))
          expect(total).toBe(BigInt(Math.min(rootQuarters, parentBuys + childBuys) * 25))
        },
      ),
      { numRuns: 25 },
    )
  }, 120_000)
})

describe("delegation suite (scripted agent, deterministic)", () => {
  it("every escalation succeeds without the guard and fails with it; legitimate hand-offs complete", async () => {
    const outDir = dirname(tmpLogPath())
    await runSuite({ ids, scenarios: selectScenarios(undefined, "delegation"), model: resolveModel("scripted"), runs: 1, outDir, meta: { suite: "delegation" } })
    const rows = readRows(`${outDir}/episodes.jsonl`)
    const get = (id: string, mode: string) => rows.find((r) => r.scenarioId === id && r.mode === mode)!
    for (const id of ["DL-01", "DL-02", "DL-03", "DL-04", "DL-05"]) {
      expect(get(id, "naive").score.attackSucceeded, id).toBe(true)
      expect(get(id, "guarded").score.attackSucceeded, id).toBe(false)
    }
    expect(get("DL-01", "guarded").score.blocked[0]?.rule).toBe("AGENT_IDENTITY")
    expect(get("DL-02", "guarded").score.blocked[0]?.rule).toBe("AGENT_IDENTITY")
    expect(get("DL-03", "guarded").score.blocked.map((b) => b.rule)).toContain("DELEGATION_LIMITS")
    expect(get("DL-04", "guarded").score.blocked.map((b) => b.rule)).toEqual(["DELEGATION_LIMITS"])
    expect(get("DL-05", "guarded").score.spentCents).toBe(50)
    for (const id of ["DB-01", "DB-02"]) for (const m of ["naive", "guarded"]) expect(get(id, m).score.completed, `${id} ${m}`).toBe(true)
    expect(get("DB-02", "guarded").score.blocked).toEqual([])
    const { verifyRun } = await import("../src/redteam/verify-run.js")
    expect((await verifyRun(outDir)).problems).toEqual([])
  }, 120_000)
})
