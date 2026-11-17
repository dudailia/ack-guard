import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AuditLog } from "../src/audit/chain.js"
import { writeGenesis } from "../src/audit/genesis.js"
import { createDashboard } from "../src/dashboard/server.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { testIdentities } from "./helpers.js"

const BASE = "http://localhost:4300"
const JSON_POST = { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: "{}" }

async function setup() {
  const ids = await testIdentities()
  const root = mkdtempSync(join(tmpdir(), "ack-guard-dash-"))
  mkdirSync(join(root, ".data"))
  const log = new AuditLog(join(root, ".data", "audit.jsonl"), ids.parties.guard)
  await writeGenesis(log, ids, buildPolicyConfig(ids))
  await log.append("decision", { episodeId: "e", attemptId: "e#1", decision: { outcome: "deny", rule: { id: "X", detail: "d" }, checks: [] } })
  return { ids, log, root }
}

describe("dashboard API", () => {
  it("serves only the tool's own logs and runs the tamper demo on a copy", async () => {
    const { ids, log, root } = await setup()
    const app = createDashboard({ liveLog: log, root, port: 4300, operatorGuardDid: ids.parties.guard.did })

    const ok = await (await app.request(`${BASE}/api/verify`)).json()
    expect(ok.ok).toBe(true)
    expect(ok.pinned).toBe(true)

    const traversal = await app.request(`${BASE}/api/attempts?log=${encodeURIComponent("../../../etc/passwd")}`)
    expect(traversal.status).toBe(404)

    const t = await (await app.request(`${BASE}/api/tamper-demo`, JSON_POST)).json()
    expect(t.before.ok).toBe(true)
    expect(t.after.ok).toBe(false)
    expect(t.tamperedSeq).toBe(1)
    expect((await (await app.request(`${BASE}/api/verify`)).json()).ok).toBe(true)

    expect(await (await app.request(`${BASE}/`)).text()).toContain("ACK Guard")

    // results/ may contain plain files (RESULTS.md) next to run directories
    mkdirSync(join(root, "results", "m", "run1"), { recursive: true })
    writeFileSync(join(root, "results", "RESULTS.md"), "# x")
    writeFileSync(join(root, "results", "m", "run1", "summary.json"), "{}")
    const runs = await app.request(`${BASE}/api/runs`)
    expect(runs.status).toBe(200)
    expect((await runs.json()).runs.length).toBe(1)
  })

  it("reports logs from another key as not pinned", async () => {
    const { log, root } = await setup()
    const app = createDashboard({ liveLog: log, root, port: 4300, operatorGuardDid: "did:key:z6MkSomeoneElse" })
    const v = await (await app.request(`${BASE}/api/verify`)).json()
    expect(v.ok).toBe(true)
    expect(v.pinned).toBe(false)
  })

  it("refuses cross-site writes, non-JSON posts and foreign Host headers", async () => {
    const { log, root } = await setup()
    const app = createDashboard({ liveLog: log, root, port: 4300 })
    const evil = await app.request(`${BASE}/api/approvals/ap_1`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: '{"approved":true}',
    })
    expect(evil.status).toBe(403)
    const textPlain = await app.request(`${BASE}/api/approvals/ap_1`, { method: "POST", headers: { origin: BASE, "content-type": "text/plain" }, body: "{}" })
    expect(textPlain.status).toBe(415)
    const rebind = await app.request("http://attacker.example:4300/api/approvals")
    expect(rebind.status).toBe(403)
  })

  it("an approval needs a real boolean: the string \"false\" does not approve", async () => {
    const { log, root } = await setup()
    const got: boolean[] = []
    const approvals = new Map([["ap_1", { id: "ap_1", episodeId: "e", createdAt: "", decision: {} as never, task: { id: "t", prompt: "" }, resolve: (r: { approved: boolean }) => got.push(r.approved) }]])
    const app = createDashboard({ liveLog: log, root, port: 4300, approvals })
    const post = (body: string) => app.request(`${BASE}/api/approvals/ap_1`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body })
    expect((await post('{"approved":"false"}')).status).toBe(400)
    expect(got).toEqual([])
    expect((await post('{"approved":false}')).status).toBe(200)
    expect(got).toEqual([false])
  })

  it("policy page: diff a proposed change against a signed log, approve only what was diffed", async () => {
    const { loadPolicyFile, parsePolicy } = await import("../src/policy/policy-file.js")
    const { ids, log, root } = await setup()
    // A real guarded decision to replay.
    const { resolveModel } = await import("../src/agent/model.js")
    const { runEpisode } = await import("../src/agent/run-episode.js")
    const { ALL_SCENARIOS } = await import("../src/redteam/index.js")
    const { makeBuildCtx } = await import("../src/redteam/types.js")
    const b05 = await ALL_SCENARIOS.find((x) => x.id === "B-05")!.build(makeBuildCtx(ids))
    await runEpisode({ ids, setup: b05, mode: "guarded", audit: log, episodeId: "B-05/guarded/r1", model: resolveModel("scripted"), meta: { scenarioId: "B-05" } })
    let active = { policy: loadPolicyFile(), source: "repository" as const }
    const approved: string[] = []
    const app = createDashboard({
      liveLog: log,
      root,
      port: 4300,
      operatorGuardDid: ids.parties.guard.did,
      policy: {
        active: () => active as never,
        history: () => [],
        approve: async (p) => {
          approved.push(p.hash)
          active = { policy: p, source: "repository" }
          return { version: p.version, seq: 1 }
        },
      },
    })
    const page = await (await app.request(`${BASE}/policy`)).text()
    expect(page).toContain("How each payment is checked")
    const cur = await (await app.request(`${BASE}/api/policy`)).json()
    expect(cur.doc.rules.length).toBe(14)
    const post = (path: string, body: unknown) => app.request(`${BASE}${path}`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) })

    expect((await post("/api/policy/approve", { id: "pd_nope" })).status).toBe(400)
    expect((await post("/api/policy/diff", { yaml: "rules: [" })).status).toBe(400)
    const proposedText = cur.text.replace('approval_threshold: "1.00"', 'approval_threshold: "0.40"')
    const d = await (await post("/api/policy/diff", { yaml: proposedText })).json()
    expect(d.logVerified).toBe(true)
    expect(d.counts["now escalated"]).toBe(2)
    expect(d.policyChanges).toEqual(["Payments need a human above: $1.00 -> $0.40"])
    const ok = await (await post("/api/policy/approve", { id: d.id })).json()
    expect(ok.ok).toBe(true)
    expect(approved).toEqual([parsePolicy(proposedText).hash])
    // The same diff cannot be approved twice, and a cross-site approval is refused.
    expect((await post("/api/policy/approve", { id: d.id })).status).toBe(400)
    const evil = await app.request(`${BASE}/api/policy/approve`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ id: d.id }) })
    expect(evil.status).toBe(403)
  })

  it("serves a signed dispute pack (JSON and PDF) for an attempt in its own logs", async () => {
    const { ids, log, root } = await setup()
    const { resolveModel } = await import("../src/agent/model.js")
    const { runEpisode } = await import("../src/agent/run-episode.js")
    const { ALL_SCENARIOS } = await import("../src/redteam/index.js")
    const { makeBuildCtx } = await import("../src/redteam/types.js")
    const { verifyDisputePack } = await import("../src/dispute/pack.js")
    const b01 = await ALL_SCENARIOS.find((x) => x.id === "B-01")!.build(makeBuildCtx(ids))
    await runEpisode({ ids, setup: b01, mode: "guarded", audit: log, episodeId: "B-01/guarded/r1", model: resolveModel("scripted"), meta: { scenarioId: "B-01" } })
    const app = createDashboard({ liveLog: log, root, port: 4300, operatorGuardDid: ids.parties.guard.did, dispute: { guard: ids.parties.guard, didDocuments: {} } })
    const j = await app.request(`${BASE}/api/dispute?id=${encodeURIComponent("B-01/guarded/r1#1")}`)
    expect(j.status).toBe(200)
    const pack = await j.json()
    expect((await verifyDisputePack(pack, { signer: ids.parties.guard.did })).ok).toBe(true)
    const pdf = await app.request(`${BASE}/api/dispute?id=${encodeURIComponent("B-01/guarded/r1#1")}&format=pdf`)
    expect(pdf.headers.get("content-type")).toBe("application/pdf")
    expect((await app.request(`${BASE}/api/dispute?id=nope`)).status).toBe(400)
  })
})
