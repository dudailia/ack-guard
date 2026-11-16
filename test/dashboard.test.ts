import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AuditLog } from "../src/audit/chain.js"
import { writeGenesis } from "../src/audit/genesis.js"
import { createDashboard } from "../src/dashboard/server.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { testIdentities } from "./helpers.js"

describe("dashboard API", () => {
  it("serves only the tool's own logs and runs the tamper demo on a copy", async () => {
    const ids = await testIdentities()
    const root = mkdtempSync(join(tmpdir(), "ack-guard-dash-"))
    mkdirSync(join(root, ".data"))
    const log = new AuditLog(join(root, ".data", "audit.jsonl"), ids.parties.guard)
    await writeGenesis(log, ids, buildPolicyConfig(ids))
    await log.append("decision", { episodeId: "e", attemptId: "e#1", decision: { outcome: "deny", rule: { id: "X", detail: "d" }, checks: [] } })
    const app = createDashboard({ liveLog: log, root })

    const ok = await app.request("/api/verify")
    expect((await ok.json()).ok).toBe(true)

    const traversal = await app.request(`/api/attempts?log=${encodeURIComponent("../../../etc/passwd")}`)
    expect(traversal.status).toBe(404)

    const t = await (await app.request("/api/tamper-demo", { method: "POST" })).json()
    expect(t.before.ok).toBe(true)
    expect(t.after.ok).toBe(false)
    expect(t.tamperedSeq).toBe(1)

    // the original is untouched
    expect((await (await app.request("/api/verify")).json()).ok).toBe(true)

    const page = await app.request("/")
    expect(await page.text()).toContain("ACK Guard")
  })
})
