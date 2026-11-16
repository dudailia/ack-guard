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
import { normalizeUrl, taskInstanceId, World } from "../src/world.js"
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

// ------------------------------------------------------------ review round 3

describe("review 3: duplicate detection cannot be dodged with ports or schemes", () => {
  it("port and scheme variants of one URL are one purchase; non-http schemes are refused", async () => {
    expect(normalizeUrl("HTTP://SkyCast.test:8080/forecast?city=Boston")).toBe(normalizeUrl("skycast.test/forecast?city=Boston"))
    expect(normalizeUrl("https://skycast.test:1/forecast?city=Boston")).toBe(normalizeUrl("http://skycast.test/forecast?city=Boston"))
    expect(() => normalizeUrl("foo://skycast.test/forecast?city=Boston")).toThrow(/unsupported URL scheme/)
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(5) } }, "guarded", audit, "ep-ports")
    const variants = ["http://skycast.test/forecast?city=Boston", "http://skycast.test:8080/forecast?city=Boston", "https://skycast.test:1/forecast?city=Boston", "foo://skycast.test/forecast?city=Boston", "x-y://skycast.test/forecast?city=Boston"]
    for (const u of variants) {
      const r = (await w.httpGetForAgent(u)) as { payment_request?: string }
      if (r.payment_request) await w.pay({ paymentRequest: r.payment_request, purpose: "forecast" })
    }
    expect(w.ledger.transfers.length).toBe(1)
  })
})

describe("review 3: an emptied or deleted log cannot be restarted", () => {
  it("AuditLog.open refuses when a signed head exists but the entries are gone", async () => {
    const { ids, path } = await paidAndBlockedLog()
    writeFileSync(path, "")
    await expect(AuditLog.open(path, ids.parties.guard)).rejects.toThrow(/entries were deleted/)
  })
})

describe("review 3: approvals and task instances in the live demo", () => {
  it("a pending human approval does not hold up other payments", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    let release!: (v: { approved: boolean; by: string }) => void
    const slowHuman = () => new Promise<{ approved: boolean; by: string }>((r) => (release = r))
    const a = new World(ids, { task: { id: "a", prompt: "", needs: ["weather.history"], budget: usd(5) } }, "guarded", audit, "ep-a", slowHuman, store)
    const b = new World(ids, { task: { id: "b", prompt: "", needs: ["weather.forecast"], budget: usd(5) } }, "guarded", audit, "ep-b", undefined, store)
    const ra = (await a.httpGetForAgent("http://skycast.test/history?city=Boston")) as { payment_request: string }
    const pending = a.pay({ paymentRequest: ra.payment_request, purpose: "history" })
    await new Promise((r) => setTimeout(r, 50))
    const rb = (await b.httpGetForAgent("http://skycast.test/forecast?city=Boston")) as { payment_request: string }
    const paidB = await b.pay({ paymentRequest: rb.payment_request, purpose: "forecast" })
    expect(paidB.status).toBe("paid")
    release({ approved: true, by: "owner" })
    expect((await pending).status).toBe("paid")
  })

  it("the same scenario run twice as two task instances is not a duplicate charge", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    for (const n of [1, 2]) {
      const w = new World(ids, { task: { id: `B-01#${n}`, prompt: "", needs: ["weather.forecast"], budget: usd(1) } }, "guarded", audit, `ep-${n}`, undefined, store)
      const r = (await w.httpGetForAgent("http://skycast.test/forecast?city=Boston")) as { payment_request: string }
      expect((await w.pay({ paymentRequest: r.payment_request, purpose: "forecast" })).status).toBe("paid")
    }
  })
})

describe("final review: task instances across demo restarts", () => {
  it("a restarted demo session reuses no task id, so its first legit purchase is not a duplicate", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const persist = join(dirname(tmpLogPath()), "spend.json")
    const buy = async (taskId: string, store: SpendStore, ep: string) => {
      const w = new World(ids, { task: { id: taskId, prompt: "", needs: ["weather.forecast"], budget: usd(1) } }, "guarded", audit, ep, undefined, store)
      const r = (await w.httpGetForAgent("http://skycast.test/forecast?city=Boston")) as { payment_request: string }
      return w.pay({ paymentRequest: r.payment_request, purpose: "forecast" })
    }
    expect((await buy(taskInstanceId("B-01", "s1", 1), new SpendStore(persist), "e1")).status).toBe("paid")
    // A restart reloads the spend history from disk; the new session has its own id.
    expect((await buy(taskInstanceId("B-01", "s2", 1), new SpendStore(persist), "e2")).status).toBe("paid")
    // The old scheme (counter only) collided across restarts and blocked the purchase.
    expect((await buy("B-01#1", new SpendStore(persist), "e3")).status).toBe("paid")
    const again = await buy("B-01#1", new SpendStore(persist), "e4")
    expect(again.status).toBe("blocked")
    expect(again.status === "blocked" && again.rule).toBe("DUPLICATE_CHARGE")
  })
})

describe("final review: spend accounting fails closed", () => {
  it("a payment whose settlement log write fails still counts toward the budget", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(0.25) } }, "guarded", audit, "ep-x", undefined, store)
    const orig = audit.append.bind(audit)
    let failed = false
    audit.append = (async (kind: Parameters<typeof orig>[0], payload: Parameters<typeof orig>[1]) => {
      if (kind === "settlement" && !failed) {
        failed = true
        throw new Error("EIO")
      }
      return orig(kind, payload)
    }) as typeof audit.append
    const r1 = (await w.httpGetForAgent("http://skycast.test/forecast?city=Boston")) as { payment_request: string }
    await expect(w.pay({ paymentRequest: r1.payment_request, purpose: "forecast" })).rejects.toThrow(/EIO/)
    const r2 = (await w.httpGetForAgent("http://skycast.test/forecast?city=Chicago")) as { payment_request: string }
    const second = await w.pay({ paymentRequest: r2.payment_request, purpose: "forecast" })
    expect(second.status).toBe("blocked")
    expect(store.history.payments.length).toBe(1)
  })

  it("two processes sharing one spend file both see each other's payments", async () => {
    const persist = join(dirname(tmpLogPath()), "spend.json")
    const a = new SpendStore(persist), b = new SpendStore(persist)
    const rec = (n: number) => ({ ts: Date.now(), amount: usd(10), taskId: `t${n}`, url: `http://skycast.test/x${n}`, paymentRequestId: `r${n}`, merchantDid: "did:key:z" })
    await a.run(async () => a.record(rec(1)))
    await b.run(async () => b.record(rec(2)))
    // B saw A's payment before deciding, and the file keeps both.
    expect(b.history.payments.map((p) => p.taskId)).toEqual(["t1", "t2"])
    expect(new SpendStore(persist).history.payments.length).toBe(2)
    await a.run(async () => undefined)
    expect(a.history.payments.length).toBe(2)
  })
})

describe("final review: verification never touches the network", () => {
  it("a log whose genesis names a did:web signer is checked without fetching anything", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    await audit.append("task", { episodeId: "e" })
    const lines = readFileSync(audit.path, "utf8").split("\n")
    // A forged entry: its signature claims to come from a did:web, which an online resolver would fetch.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const forgedSig = `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64({ iss: "did:web:example.com", seq: 0 })}.AAAA`
    lines[0] = lines[0]!.replace(/"guardDid":"[^"]+"/, '"guardDid":"did:web:example.com"').replace(/"sig":"[^"]+"/, `"sig":"${forgedSig}"`)
    writeFileSync(audit.path, lines.join("\n"))
    const realFetch = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (u: unknown) => {
      calls.push(String(u))
      throw new Error("network used")
    }) as typeof fetch
    try {
      const v = await verifyLog(audit.path)
      expect(v.ok).toBe(false)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls).toEqual([])
  })
})

describe("review 3: merchants bind receipts to what was quoted", () => {
  it("a receipt for /alerts cannot unlock /history, and a receipt works once", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.alerts"], budget: usd(1) } }, "naive", audit, "ep-bind")
    const r = (await w.httpGetForAgent("http://skycast.test/alerts?city=Boston")) as { payment_request: string }
    await w.pay({ paymentRequest: r.payment_request, purpose: "alerts" })
    const receipt = (audit.entries.find((e) => e.kind === "receipt")!.payload.receipt as string)
    const headers = { "x-ack-controller-credential": ids.controllerCredential, authorization: `Bearer ${receipt}` }
    expect((await w.net.fetch("http://skycast.test/history?city=Boston", { headers })).status).toBe(400)
    expect((await w.net.fetch("http://skycast.test/alerts?city=Boston", { headers })).status).toBe(200)
    expect((await w.net.fetch("http://skycast.test/alerts?city=Boston", { headers })).status).toBe(400)
  })
})

describe("review 3: reported numbers are backed by the signed log", () => {
  it("verifyRun re-derives every row from the log, and catches edited rows, swapped logs and missing logs", async () => {
    const { verifyRun } = await import("../src/redteam/verify-run.js")
    const ids = await testIdentities()
    const outDir = dirname(tmpLogPath())
    await runSuite({ ids, scenarios: selectScenarios("FI-01,DC-05,B-01"), model: resolveModel("scripted"), runs: 1, outDir })
    const ok = await verifyRun(outDir)
    expect(ok.problems).toEqual([])
    expect(ok.episodesChecked).toBe(6)

    // Edit a row: claim the guarded DC-05 attack failed.
    const epPath = join(outDir, "episodes.jsonl")
    const original = readFileSync(epPath, "utf8")
    writeFileSync(epPath, original.replace(/("scenarioId":"DC-05".*?"mode":"guarded".*?"attackSucceeded":)true/, "$1false"))
    const edited = await verifyRun(outDir)
    expect(edited.ok).toBe(false)
    expect(edited.problems.join(" ")).toMatch(/attackSucceeded/)
    writeFileSync(epPath, original)

    // Swap in another run's (validly signed) log.
    const other = dirname(tmpLogPath())
    await runSuite({ ids, scenarios: selectScenarios("FI-01,DC-05,B-01"), model: resolveModel("scripted"), runs: 1, outDir: other })
    copyFileSync(join(other, "audit.jsonl"), join(outDir, "audit.jsonl"))
    copyFileSync(headPath(join(other, "audit.jsonl")), headPath(join(outDir, "audit.jsonl")))
    const swapped = await verifyRun(outDir)
    expect(swapped.ok).toBe(false)
    expect(swapped.problems.join(" ")).toMatch(/runId|head/)
  })

  it("verifyRun catches rows that borrow another row's signed episode (mode swap)", async () => {
    const { verifyRun } = await import("../src/redteam/verify-run.js")
    const ids = await testIdentities()
    const outDir = dirname(tmpLogPath())
    await runSuite({ ids, scenarios: selectScenarios("DC-05"), model: resolveModel("scripted"), runs: 1, outDir })
    const epPath = join(outDir, "episodes.jsonl")
    const rows = readFileSync(epPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
    const g = rows.find((r) => r.mode === "guarded")!, n = rows.find((r) => r.mode === "naive")!
    // Point the guarded row at the naive episode and vice versa, keeping each score consistent with its new episode.
    for (const k of ["logEpisodeId", "score"]) [g[k], n[k]] = [n[k], g[k]]
    writeFileSync(epPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const v = await verifyRun(outDir)
    expect(v.ok).toBe(false)
    expect(v.problems.join(" ")).toMatch(/mode is "guarded" in episodes.jsonl but "naive" in the signed log/)
    // Two rows claiming one episode is also refused.
    n.logEpisodeId = g.logEpisodeId
    writeFileSync(epPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
    expect((await verifyRun(outDir)).problems.join(" ")).toMatch(/claimed by more than one row/)
  })

  it("the runner refuses to resume when rows exist but the log is gone", async () => {
    const ids = await testIdentities()
    const outDir = dirname(tmpLogPath())
    await runSuite({ ids, scenarios: selectScenarios("B-01"), model: resolveModel("scripted"), runs: 1, outDir })
    const { rmSync } = await import("node:fs")
    rmSync(join(outDir, "audit.jsonl"))
    rmSync(headPath(join(outDir, "audit.jsonl")))
    await expect(runSuite({ ids, scenarios: selectScenarios("B-01"), model: resolveModel("scripted"), runs: 2, outDir })).rejects.toThrow(/audit log is missing/)
  })
})
