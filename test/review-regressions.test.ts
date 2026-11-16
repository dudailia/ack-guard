// Regression tests for issues found by the independent reviews.

import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveModel } from "../src/agent/model.js"
import { AuditLog, headPath } from "../src/audit/chain.js"
import { writeGenesis } from "../src/audit/genesis.js"
import { listAttempts, replayAttempt } from "../src/audit/replay.js"
import { verifyLog } from "../src/audit/verify.js"
import { usd } from "../src/config.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { SpendStore } from "../src/policy/spend-store.js"
import { selectScenarios } from "../src/redteam/index.js"
import { runSuite } from "../src/redteam/runner.js"
import { normalizeUrl, World } from "../src/world.js"
import { testIdentities, tmpAudit, tmpLogPath } from "./helpers.js"

async function paidAndBlockedLog() {
  const ids = await testIdentities()
  const path = tmpLogPath()
  const audit = new AuditLog(path, ids.parties.guard)
  await writeGenesis(audit, ids, buildPolicyConfig(ids))
  const task = { id: "t", prompt: "forecast", needs: ["weather.forecast"], budget: usd(1) }
  await audit.append("task", { episodeId: "ep", mode: "guarded", task: { ...task, budget: "100" } })
  const w = new World(ids, { task }, "guarded", audit, "ep")
  const a = (await w.httpGetForAgent("http://skycast.test/forecast?city=Boston")) as { payment_request: string }
  await w.pay({ paymentRequest: a.payment_request, purpose: "forecast" })
  const h = (await w.httpGetForAgent("http://skycast.test/history?city=Boston")) as { payment_request: string }
  await w.pay({ paymentRequest: h.payment_request, purpose: "history" })
  return { ids, path, audit }
}

describe("audit: appending to a damaged log is refused", () => {
  it("AuditLog.open refuses a truncated log instead of writing a new valid head over the gap", async () => {
    const { ids, path } = await paidAndBlockedLog()
    const lines = readFileSync(path, "utf8").trim().split("\n")
    writeFileSync(path, lines.slice(0, lines.length - 2).join("\n") + "\n")
    await expect(AuditLog.open(path, ids.parties.guard)).rejects.toThrow(/refusing to append/)
    expect(() => new AuditLog(path, ids.parties.guard)).toThrow(/use AuditLog.open/)
  })

  it("AuditLog.open continues an intact log", async () => {
    const { ids, path } = await paidAndBlockedLog()
    const log = await AuditLog.open(path, ids.parties.guard)
    await log.append("agent_step", { episodeId: "ep", text: "more" })
    expect((await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })).ok).toBe(true)
  })
})

describe("audit: rollback with an old genuine head is caught by an external anchor", () => {
  it("verifies clean without an anchor (documented limit) and fails with one", async () => {
    const { ids, path, audit } = await paidAndBlockedLog()
    const dir = mkdtempSync(join(tmpdir(), "ack-guard-rollback-"))
    const oldLog = join(dir, "old.jsonl")
    copyFileSync(path, oldLog)
    copyFileSync(headPath(path), headPath(oldLog))
    await audit.append("agent_step", { episodeId: "ep", text: "later entry" })
    const anchored = (await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })).headHash!
    // Roll back: restore the older log and its older, genuine head.
    copyFileSync(oldLog, path)
    copyFileSync(headPath(oldLog), headPath(path))
    const plain = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(plain.ok).toBe(true)
    const withAnchor = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did, expectedHeadHash: anchored })
    expect(withAnchor.ok).toBe(false)
    expect(withAnchor.problems.map((p) => p.kind)).toContain("anchor_mismatch")
  })

  it("every log gets its own run id in the genesis entry", async () => {
    const a = await paidAndBlockedLog()
    const b = await paidAndBlockedLog()
    expect(a.audit.entries[0]!.payload.runId).toBeTruthy()
    expect(a.audit.entries[0]!.payload.runId).not.toBe(b.audit.entries[0]!.payload.runId)
  })
})

describe("replay: forged entries are never shown as verified", () => {
  it("unsigned entries with seq:null appended to a blocked attempt make the replay untrusted", async () => {
    const { ids, path } = await paidAndBlockedLog()
    const blocked = listAttempts(path).find((a) => a.outcome === "deny")!
    const lines = readFileSync(path, "utf8").trim().split("\n")
    const forgedDecision = { seq: null, ts: new Date().toISOString(), kind: "decision", payload: { episodeId: "ep", attemptId: blocked.attemptId, mode: "guarded", decision: { outcome: "allow", rule: { id: "ALL_RULES_PASSED", detail: "" }, checks: [] } }, prevHash: "x", hash: "x", sig: "x" }
    const forgedSettlement = { ...forgedDecision, kind: "settlement", payload: { episodeId: "ep", attemptId: blocked.attemptId, tx: { txId: "tx_99", amount: "150", to: "did:key:x" } } }
    writeFileSync(path, [...lines, JSON.stringify(forgedDecision), JSON.stringify(forgedSettlement)].join("\n") + "\n")
    const r = await replayAttempt(path, blocked.attemptId, { expectedSignerDid: ids.parties.guard.did })
    expect(r.chain.ok).toBe(false)
    expect(r.chain.relatedEntriesIntact).toBe(false)
    expect(r.trusted).toBe(false)
  })
})

describe("policy: the daily cap holds across episodes that share the agent's spend store", () => {
  it("three episodes cannot spend more than the daily cap together", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    let total = 0n
    for (let ep = 0; ep < 3; ep++) {
      // Each task has a big budget; history is $1.50 and needs approval, so approve it.
      const w = new World(
        ids,
        { task: { id: `t${ep}`, prompt: "", needs: ["weather.history"], budget: usd(20) } },
        "guarded",
        audit,
        `ep${ep}`,
        async () => ({ approved: true, by: "test owner" }),
        store,
      )
      for (let i = 0; i < 8; i++) {
        const r = (await w.httpGetForAgent(`http://skycast.test/history?city=c${ep}-${i}`)) as { payment_request: string }
        await w.pay({ paymentRequest: r.payment_request, purpose: "history" })
      }
      total += w.ledger.transfers.reduce((a, t) => a + t.amount, 0n)
    }
    expect(total).toBeLessThanOrEqual(usd(20))
    expect(total).toBe(usd(19.5))
  })

  it("the store persists across restarts", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ack-guard-spend-")), "spend.json")
    const a = new SpendStore(path)
    a.record({ ts: Date.now(), amount: usd(3), taskId: "t", paymentRequestId: "r", merchantDid: "did:key:m" })
    const b = new SpendStore(path)
    expect(b.history.payments[0]?.amount).toBe(usd(3))
  })
})

describe("policy: duplicate detection uses canonical URLs", () => {
  it("fragments and reordered query parameters are the same purchase", async () => {
    expect(normalizeUrl("http://LinguaBridge.test/translate?to=es&text=hi#again")).toBe(normalizeUrl("linguabridge.test/translate?text=hi&to=es"))
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["translation"], budget: usd(5) } }, "guarded", audit, "ep-canon")
    const urls = [
      "http://linguabridge.test/translate?text=hi&to=es",
      "http://linguabridge.test/translate?text=hi&to=es#again",
      "http://linguabridge.test/translate?to=es&text=hi",
    ]
    const statuses: string[] = []
    for (const u of urls) {
      const r = (await w.httpGetForAgent(u)) as { payment_request?: string; status: number }
      if (r.payment_request) statuses.push((await w.pay({ paymentRequest: r.payment_request, purpose: "translate" })).status)
    }
    expect(statuses[0]).toBe("paid")
    expect(statuses.slice(1).every((s) => s === "blocked")).toBe(true)
    expect(w.ledger.transfers.length).toBe(1)
  })
})

describe("runner: one run never mixes code versions", () => {
  it("refuses to resume a run started at a different commit", async () => {
    const ids = await testIdentities()
    const outDir = dirname(tmpLogPath())
    const scenarios = selectScenarios("B-01")
    await runSuite({ ids, scenarios, model: resolveModel("scripted"), runs: 1, outDir })
    const meta = JSON.parse(readFileSync(join(outDir, "meta.json"), "utf8"))
    expect(meta.headHash).toMatch(/^[0-9a-f]{64}$/)
    meta.gitCommit = "0000000"
    writeFileSync(join(outDir, "meta.json"), JSON.stringify(meta))
    await expect(runSuite({ ids, scenarios, model: resolveModel("scripted"), runs: 2, outDir })).rejects.toThrow(/refusing to resume/)
  })
})
