import { readFileSync, writeFileSync } from "node:fs"
import { createJwt } from "agentcommercekit"
import { describe, expect, it } from "vitest"
import { AuditLog, entryHash, headPath, type AuditEntry } from "../src/audit/chain.js"
import { verifyLog } from "../src/audit/verify.js"
import { testIdentities, tmpLogPath } from "./helpers.js"

async function makeLog(n = 6) {
  const ids = await testIdentities()
  const path = tmpLogPath()
  const log = new AuditLog(path, ids.parties.guard)
  await log.append("genesis", { guardDid: ids.parties.guard.did })
  for (let i = 1; i < n; i++) await log.append("decision", { episodeId: "e", n: i, decision: { outcome: i % 2 ? "deny" : "allow" } })
  return { ids, path, log }
}

const lines = (p: string) => readFileSync(p, "utf8").trim().split("\n")
const write = (p: string, ls: string[]) => writeFileSync(p, ls.join("\n") + "\n")

describe("hash-chained signed audit log", () => {
  it("verifies an untouched log", async () => {
    const { ids, path } = await makeLog()
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(true)
    expect(r.entries).toBe(6)
  })

  it("detects an edited entry at the exact seq", async () => {
    const { ids, path } = await makeLog()
    const ls = lines(path)
    const e = JSON.parse(ls[3]!) as AuditEntry
    e.payload.decision = { outcome: "allow" }
    ls[3] = JSON.stringify(e)
    write(path, ls)
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.firstBadSeq).toBe(3)
    expect(r.problems.some((p) => p.kind === "hash_mismatch" && p.seq === 3)).toBe(true)
  })

  it("detects an edit where the attacker also recomputed the hash (signature breaks)", async () => {
    const { ids, path } = await makeLog()
    const ls = lines(path)
    const e = JSON.parse(ls[2]!) as AuditEntry
    e.payload.n = 999
    e.hash = entryHash(e)
    ls[2] = JSON.stringify(e)
    write(path, ls)
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.firstBadSeq).toBe(2)
    expect(r.problems.map((p) => p.kind)).toContain("bad_signature")
  })

  it("detects a deleted entry", async () => {
    const { ids, path } = await makeLog()
    const ls = lines(path)
    ls.splice(2, 1)
    write(path, ls)
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.kind)).toEqual(expect.arrayContaining(["seq_gap", "prev_mismatch"]))
  })

  it("detects reordered entries", async () => {
    const { ids, path } = await makeLog()
    const ls = lines(path)
    ;[ls[2], ls[3]] = [ls[3]!, ls[2]!]
    write(path, ls)
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.firstBadSeq).toBe(3)
  })

  it("detects tail truncation through the signed head checkpoint", async () => {
    const { ids, path } = await makeLog()
    const ls = lines(path)
    write(path, ls.slice(0, 4))
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.problems.map((p) => p.kind)).toContain("head_mismatch")
  })

  it("detects a fully re-forged chain signed with a different key", async () => {
    const { ids, path } = await makeLog()
    const attacker = ids.parties.attacker
    const forged: string[] = []
    let prev = "0".repeat(64)
    for (const l of lines(path)) {
      const e = JSON.parse(l) as AuditEntry
      e.prevHash = prev
      e.hash = entryHash(e)
      e.sig = await createJwt({ seq: e.seq, hash: e.hash }, { issuer: attacker.did, signer: attacker.signer }, { alg: attacker.alg })
      prev = e.hash
      forged.push(JSON.stringify(e))
    }
    write(path, forged)
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
    expect(r.firstBadSeq).toBe(0)
    expect(r.problems.every((p) => p.kind === "bad_signature" || p.kind === "bad_head_signature" || p.kind === "head_mismatch")).toBe(true)
  })

  it("detects a deleted head file", async () => {
    const { ids, path } = await makeLog()
    writeFileSync(headPath(path), "{}")
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(false)
  })

  it("keeps seq and links consistent under concurrent appends", async () => {
    const { ids, path, log } = await makeLog(1)
    await Promise.all(Array.from({ length: 20 }, (_, i) => log.append("agent_step", { i })))
    const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(true)
    expect(r.entries).toBe(21)
  })
})
