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

  it("renders a one-page PDF", async () => {
    const bytes = await renderDisputePdf(paid)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})
