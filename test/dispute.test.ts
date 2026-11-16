// Dispute evidence packs: built from a signed log, verifiable from the file
// alone, and every kind of tampering is caught.

import { dirname, join } from "node:path"
import type { DidDocument } from "agentcommercekit"
import { PDFDocument } from "pdf-lib"
import { beforeAll, describe, expect, it } from "vitest"
import { resolveModel } from "../src/agent/model.js"
import { listAttempts } from "../src/audit/replay.js"
import { buildDisputePack, verifyDisputePack, type DisputePack } from "../src/dispute/pack.js"
import { renderDisputePdf } from "../src/dispute/pdf.js"
import type { Identities } from "../src/identity/identities.js"
import { selectScenarios } from "../src/redteam/index.js"
import { runSuite } from "../src/redteam/runner.js"
import { testIdentities, tmpLogPath } from "./helpers.js"

let ids: Identities
let log: string
let paid: DisputePack
let blocked: DisputePack

beforeAll(async () => {
  ids = await testIdentities()
  const out = dirname(tmpLogPath())
  await runSuite({ ids, scenarios: selectScenarios("DL-04", "delegation"), model: resolveModel("scripted"), runs: 1, outDir: out, modes: ["guarded"] })
  log = join(out, "audit.jsonl")
  const docs: Record<string, DidDocument> = {}
  for (const p of [ids.parties.agent, ids.parties.subagent]) docs[p.did] = (await ids.resolver.resolve(p.did)).didDocument as DidDocument
  const attempts = listAttempts(log)
  const a = attempts.find((x) => x.outcome === "paid")!
  const b = attempts.find((x) => x.outcome === "deny")!
  paid = await buildDisputePack(log, a.attemptId, { guard: ids.parties.guard, didDocuments: docs })
  blocked = await buildDisputePack(log, b.attemptId, { guard: ids.parties.guard, didDocuments: docs })
}, 120_000)

const clone = (p: DisputePack): DisputePack => JSON.parse(JSON.stringify(p))

describe("dispute evidence pack", () => {
  it("covers task, delegation chain, policy and rule, reasoning, receipt and verification", () => {
    expect(paid.subject.outcome).toBe("paid")
    expect(paid.subject.decidingRule).toBe("ALL_RULES_PASSED")
    expect(paid.receipt?.ok).toBe(true)
    expect(paid.delegation.chain.length).toBe(2)
    expect(paid.delegation.ok).toBe(true)
    expect(paid.policy.version).toMatch(/^v1-/)
    expect(paid.agentReasoning.length).toBeGreaterThan(0)
    expect(blocked.subject.outcome).toBe("deny")
    expect(blocked.subject.decidingRule).toBe("DELEGATION_LIMITS")
    expect(blocked.receipt).toBeUndefined()
    for (const p of [paid, blocked]) expect(Object.values(p.verification).every((c) => c.ok)).toBe(true)
  })

  it("verifies from the file alone, pinned to the guard", async () => {
    for (const p of [paid, blocked]) {
      const v = await verifyDisputePack(JSON.parse(JSON.stringify(p)), { signer: ids.parties.guard.did })
      expect(v.ok, JSON.stringify(v.checks)).toBe(true)
      expect(v.pinned).toBe(true)
    }
  })

  it("catches a changed outcome, a changed log entry, a swapped receipt, a dropped entry and the wrong signer", async () => {
    const signer = ids.parties.guard.did
    const failing = async (p: DisputePack, s = signer) => Object.entries((await verifyDisputePack(p, { signer: s })).checks).filter(([, c]) => !c.ok).map(([k]) => k)

    const a = clone(blocked)
    a.subject.outcome = "paid"
    expect(await failing(a)).toEqual(expect.arrayContaining(["packSignature", "matchesLog"]))

    const b = clone(blocked)
    const d = b.evidence.entries.find((e) => e.kind === "decision")!
    ;(d.payload.decision as { outcome: string }).outcome = "allow"
    expect(await failing(b)).toEqual(expect.arrayContaining(["packSignature", "logEntries"]))

    const c = clone(paid)
    c.receipt!.jwt = c.receipt!.jwt.slice(0, -4) + "AAAA"
    expect(await failing(c)).toEqual(expect.arrayContaining(["packSignature", "matchesLog", "receipt"]))

    const e = clone(paid)
    e.evidence.entries = e.evidence.entries.filter((x) => x.kind !== "settlement")
    expect(await failing(e)).toEqual(expect.arrayContaining(["packSignature", "matchesLog"]))

    expect(await failing(clone(paid), ids.parties.attacker.did)).toEqual(expect.arrayContaining(["packSignature", "logEntries", "signedHead"]))
  })

  it("a forger cannot plant a DID document for the pinned guard key and re-sign the pack (review finding)", async () => {
    const { createDidDocumentFromKeypair, createJwt, createJwtSigner, generateKeypair } = await import("agentcommercekit")
    const { canonicalJson, entryHash } = await import("../src/audit/chain.js")
    const { createHash } = await import("node:crypto")
    const forged = clone(blocked)
    const guardDid = forged.signedBy
    const kp = await generateKeypair("Ed25519")
    const signer = createJwtSigner(kp)
    forged.evidence.didDocuments[guardDid] = createDidDocumentFromKeypair({ did: guardDid as `did:${string}:${string}`, keypair: kp }) as never
    const dec = forged.evidence.entries.find((e) => e.kind === "decision")!
    ;(dec.payload.decision as { outcome: string; rule: { id: string } }).outcome = "allow"
    ;(dec.payload.decision as { rule: { id: string } }).rule.id = "ALL_RULES_PASSED"
    forged.subject.outcome = "allow"
    forged.subject.decidingRule = "ALL_RULES_PASSED"
    const sign = (p: Record<string, unknown>) => createJwt(p, { issuer: guardDid as `did:${string}:${string}`, signer }, { alg: "EdDSA" })
    for (const e of forged.evidence.entries) {
      e.hash = entryHash(e)
      e.sig = await sign({ seq: e.seq, hash: e.hash })
    }
    forged.evidence.head.sig = await sign({ seq: forged.evidence.head.seq, hash: forged.evidence.head.hash, head: true })
    forged.packHash = createHash("sha256").update(canonicalJson({ ...forged, packHash: undefined, packSignature: undefined })).digest("hex")
    forged.packSignature = await sign({ format: forged.format, packHash: forged.packHash })
    const v = await verifyDisputePack(forged, { signer: guardDid })
    expect(v.ok).toBe(false)
    expect(Object.entries(v.checks).filter(([, c]) => !c.ok).map(([k]) => k)).toEqual(expect.arrayContaining(["packSignature", "logEntries", "signedHead"]))
  })

  it("every summary field is checked against the signed entries, not just the pack signature (review finding)", async () => {
    const edits: [string, (p: DisputePack) => void][] = [
      ["amount", (p) => (p.subject.amount = "$0.01")],
      ["payer", (p) => (p.subject.payer = ids.parties.agent.did)],
      ["time", (p) => (p.subject.attemptedAt = new Date(0).toISOString())],
      ["detail", (p) => (p.subject.decidingDetail = "fits every link")],
      ["checks", (p) => ((p.policy.checks[0] as { passed: boolean }).passed = false)],
      ["merchant", (p) => (p.subject.merchant = "Someone Else")],
      ["links", (p) => (p.delegation.links[1]!.scope = { budget: "99999", currency: "USD", capabilities: ["weather.history"] })],
    ]
    for (const [name, edit] of edits) {
      const p = clone(blocked)
      edit(p)
      const v = await verifyDisputePack(p, { signer: ids.parties.guard.did, skipPackSignature: true })
      const failed = Object.entries(v.checks).filter(([, c]) => !c.ok).map(([k]) => k)
      expect(failed.length, name).toBeGreaterThan(0)
      expect(failed.some((k) => k === "matchesLog" || k === "delegationChain"), `${name}: ${failed}`).toBe(true)
    }
  })

  it("a pack for an attempt refused on REQ_SIGNATURE verifies, reporting the request as invalid (second review)", async () => {
    const { tmpLogPath } = await import("./helpers.js")
    const { World } = await import("../src/world.js")
    const { usd } = await import("../src/config.js")
    const { AuditLog } = await import("../src/audit/chain.js")
    const { writeGenesis } = await import("../src/audit/genesis.js")
    const { buildPolicyConfig } = await import("../src/policy/config.js")
    const audit = await AuditLog.open(tmpLogPath(), ids.parties.guard)
    await writeGenesis(audit, ids, buildPolicyConfig(ids))
    await audit.append("task", { episodeId: "sig", mode: "guarded", task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: "100" } })
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(1) } }, "guarded", audit, "sig")
    const r = await w.pay({ paymentRequest: "eyJhbGciOiJFUzI1NksifQ.eyJub3QiOiJyZWFsIn0.AAAA", purpose: "x" })
    expect(r.status === "blocked" && r.rule).toBe("REQ_SIGNATURE")
    const pack = await buildDisputePack(audit.path, "sig#1", { guard: ids.parties.guard })
    expect(pack.paymentRequest.ok).toBe(false)
    const v = await verifyDisputePack(JSON.parse(JSON.stringify(pack)), { signer: ids.parties.guard.did })
    expect(v.ok, JSON.stringify(v.checks)).toBe(true)
  })

  it("the agent steps, head, settlement, receipt, mode and stored results are bound to the signed entries (second review)", async () => {
    const edits: [string, (p: DisputePack) => void, string][] = [
      ["agent steps", (p) => (p.agentReasoning = p.agentReasoning.slice(1)), "matchesLog"],
      ["head hash", (p) => (p.evidence.logHeadHash = "0".repeat(64)), "matchesLog"],
      ["settlement", (p) => ((p.settlement as { amount: string }).amount = "1"), "matchesLog"],
      ["receipt issuer", (p) => (p.receipt!.issuer = ids.parties.attacker.did), "matchesLog"],
      ["mode", (p) => (p.subject.mode = "naive"), "matchesLog"],
      ["request description", (p) => (p.paymentRequest.description = "something else"), "paymentRequest"],
      ["chain expiry", (p) => (p.delegation.links[1]!.expiresAt = "2099-01-01T00:00:00.000Z"), "delegationChain"],
      ["dropped settlement", (p) => (p.evidence.entries = p.evidence.entries.filter((e) => e.kind !== "settlement" && e.kind !== "receipt")), "matchesLog"],
    ]
    for (const [name, edit, check] of edits) {
      const p = clone(paid)
      edit(p)
      const v = await verifyDisputePack(p, { signer: ids.parties.guard.did, skipPackSignature: true })
      expect(v.checks[check]?.ok, name).toBe(false)
    }
    // Stored results that differ from a fresh run are caught even when the pack is re-signed by the guard.
    const { createJwt } = await import("agentcommercekit")
    const { canonicalJson } = await import("../src/audit/chain.js")
    const { createHash } = await import("node:crypto")
    const p = clone(blocked)
    p.verification.matchesLog = { ok: true, detail: "x" }
    p.subject.amount = "$0.01"
    p.packHash = createHash("sha256").update(canonicalJson({ ...p, packHash: undefined, packSignature: undefined })).digest("hex")
    p.packSignature = await createJwt({ format: p.format, packHash: p.packHash }, { issuer: ids.parties.guard.did, signer: ids.parties.guard.signer }, { alg: ids.parties.guard.alg })
    const v = await verifyDisputePack(p, { signer: ids.parties.guard.did })
    expect(v.checks.packSignature?.ok).toBe(true)
    expect(v.checks.matchesLog?.ok).toBe(false)
    expect(v.checks.storedResults?.ok).toBe(false)
  })

  it("renders a one-page PDF", async () => {
    const bytes = await renderDisputePdf(paid)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})
