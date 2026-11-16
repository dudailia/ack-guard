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

const clone = (p: DisputePack) => structuredClone(p)

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

  it("renders a one-page PDF", async () => {
    const bytes = await renderDisputePdf(paid)
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-")
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1)
  })
})
