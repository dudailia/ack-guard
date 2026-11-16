import { mkdirSync, mkdtempSync } from "node:fs"
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
})
