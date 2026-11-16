import { readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { AuditLog } from "../src/audit/chain.js"
import { writeGenesis } from "../src/audit/genesis.js"
import { listAttempts, replayAttempt } from "../src/audit/replay.js"
import { usd } from "../src/config.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { World } from "../src/world.js"
import { testIdentities, tmpLogPath } from "./helpers.js"

describe("replay", () => {
  it("reconstructs a paid attempt and a blocked attempt, and flags tampering", async () => {
    const ids = await testIdentities()
    const path = tmpLogPath()
    const audit = new AuditLog(path, ids.parties.guard)
    await writeGenesis(audit, ids, buildPolicyConfig(ids))
    const task = { id: "t", prompt: "Get the Boston forecast", needs: ["weather.forecast"], budget: usd(1) }
    await audit.append("task", { episodeId: "ep", mode: "guarded", scenarioId: "TEST", task: { ...task, budget: "100" } })
    const w = new World(ids, { task }, "guarded", audit, "ep")
    await audit.append("agent_step", { episodeId: "ep", text: "I will call SkyCast.", toolCalls: [{ toolName: "http_get", input: { url: "skycast.test/forecast" } }] })
    const r = await w.httpGet("http://skycast.test/forecast?city=Boston")
    const token = (r.body as { paymentRequestToken: string }).paymentRequestToken
    await w.pay({ paymentRequestToken: token, paymentOptionId: "standard", purpose: "forecast" })
    const h = await w.httpGet("http://skycast.test/history?city=Boston")
    await w.pay({ paymentRequestToken: (h.body as { paymentRequestToken: string }).paymentRequestToken, paymentOptionId: "standard", purpose: "history" })

    const rows = listAttempts(path)
    expect(rows.map((x) => [x.outcome, x.rule])).toEqual([
      ["paid", "ALL_RULES_PASSED"],
      ["deny", "PURPOSE_BINDING"],
    ])

    const paid = await replayAttempt(path, rows[0]!.attemptId)
    expect(paid.finalOutcome).toBe("paid")
    expect(paid.identity.controllerCredentialValid).toBe(true)
    expect(paid.receipt?.verifiedNow.ok).toBe(true)
    expect(paid.reasoning[0]?.text).toBe("I will call SkyCast.")
    expect(paid.chain.ok).toBe(true)

    const blocked = await replayAttempt(path, rows[1]!.attemptId)
    expect(blocked.finalOutcome).toBe("deny")
    expect((blocked.decisions[0]!.rule as { id: string }).id).toBe("PURPOSE_BINDING")
    expect(blocked.settlement).toBeUndefined()

    // Tamper: flip the blocked decision to "allow" in the log.
    const lines = readFileSync(path, "utf8").trim().split("\n")
    const i = lines.findIndex((l) => l.includes('"kind":"decision"') && l.includes('"outcome":"deny"'))
    lines[i] = lines[i]!.replace('"outcome":"deny"', '"outcome":"allow"')
    writeFileSync(path, lines.join("\n") + "\n")
    const after = await replayAttempt(path, rows[1]!.attemptId)
    expect(after.chain.ok).toBe(false)
    expect(after.chain.relatedEntriesIntact).toBe(false)
    expect(after.chain.firstBadSeq).toBe(i)
  })
})
