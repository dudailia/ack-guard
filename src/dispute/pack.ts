// Dispute evidence pack: everything a third party needs to judge one payment
// attempt, signed by the guard, checkable without trusting this tool's output.
//
// The pack carries the raw signed audit log entries the claims rest on (the
// genesis, the owner's task, the agent's steps, the payment attempt, every
// decision, approval, settlement and receipt), the signed log head, the ACK
// artifacts (payment request, receipt, delegation chain JWTs) and any did:web
// documents needed to resolve them offline. verifyDisputePack re-checks all of
// it from the pack alone:
//   - the pack signature (guard DID) and its content hash
//   - every included log entry's hash and signature, and the signed head
//   - that the pack's summary (outcome, rule, rule results, policy version,
//     amount, merchant, endpoint, payer, time, task, chain, transaction,
//     receipt, delegation links) matches the signed entries
//   - the ACK payment request, the ACK receipt, and the ACK-ID delegation
//     chain as of the payment time (links may have expired since)
// It proves what the guard recorded and signed. It does not prove the log has
// no other entries; for that, verify the full log against an externally
// published head hash (pnpm verify-log --expect-head).

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createJwt, verifyJwt, verifyPaymentRequestToken, type DidDocument, type DidUri, type JwtString } from "agentcommercekit"
import { canonicalJson, entryHash, GENESIS_PREV, headPath, type AuditEntry } from "../audit/chain.js"
import { replayAttempt } from "../audit/replay.js"
import { readEntries, verifyLog } from "../audit/verify.js"
import { verifyDelegationChainAt, type ChainVerification } from "../identity/delegation.js"
import type { Party } from "../identity/identities.js"
import { offlineDidResolver } from "../identity/offline-resolver.js"
import { formatAmount } from "../money.js"
import { checkReceipt } from "../receipts/receipt-service.js"

export const PACK_FORMAT = "ack-guard-dispute-pack/1"

export interface DisputePack {
  format: typeof PACK_FORMAT
  generatedAt: string
  signedBy: string
  subject: {
    attemptId: string
    episodeId: string
    mode: string
    outcome: string
    decidingRule?: string
    decidingDetail?: string
    amount?: string
    merchant?: string
    endpoint?: string
    payer: string
    txId?: string
    attemptedAt: string
  }
  task: Record<string, unknown>
  delegation: { chain: string[]; links: ChainVerification["links"]; ok: boolean; error?: string; verifiedAt: string }
  policy: { version?: string; source: "decision" | "genesis"; genesisPolicyHash: string; checks: unknown[] }
  agentReasoning: { seq: number; text?: string; toolCalls?: unknown[] }[]
  paymentRequest: { token: string; issuer?: string; id?: string; description?: string; options?: unknown[]; ok: boolean; error?: string }
  receipt?: { jwt: string; issuer: string; ok: boolean; error?: string; txId?: string }
  settlement?: Record<string, unknown>
  evidence: {
    log: string
    logEntries: number
    logHeadHash?: string
    entries: AuditEntry[]
    head: { seq: number; hash: string; sig: string }
    didDocuments: Record<string, DidDocument>
  }
  verification: Record<string, { ok: boolean; detail: string }>
  verifyCommand: string
  packHash?: string
  packSignature?: string
}

const hashOf = (p: DisputePack) => createHash("sha256").update(canonicalJson({ ...p, packHash: undefined, packSignature: undefined })).digest("hex")

/**
 * Resolver for the ACK artifacts (payment request, receipt, delegation chain).
 * did:key always resolves from the key itself; a pack can only supply did:web
 * documents (which would otherwise be fetched over HTTPS), and never one that
 * replaces the agent's document recorded in the guard-signed genesis entry.
 * Signatures on the pack, its entries and its head are checked with a plain
 * resolver that takes nothing from the pack (see verifyDisputePack).
 */
function resolverFor(genesis: AuditEntry, docs: Record<string, DidDocument>) {
  const r = offlineDidResolver()
  const g = genesis.payload as { agentDid?: string; agentDidDocument?: DidDocument }
  if (g.agentDid && g.agentDidDocument) r.addToCache(g.agentDid as DidUri, g.agentDidDocument)
  for (const [did, doc] of Object.entries(docs)) {
    if (!did.startsWith("did:web:") || did === g.agentDid) continue
    if ((doc as { id?: string }).id !== did) continue
    r.addToCache(did as DidUri, doc)
  }
  return r
}

export async function buildDisputePack(
  logPath: string,
  attemptId: string,
  opts: { guard: Party; didDocuments?: Record<string, DidDocument>; logLabel?: string },
): Promise<DisputePack> {
  const v = await verifyLog(logPath, { expectedSignerDid: opts.guard.did })
  if (!v.ok) throw new Error(`the log does not verify against this guard key (first bad entry ${v.firstBadSeq}); no evidence pack can rest on it`)
  const entries = readEntries(logPath).entries.filter((e): e is AuditEntry => !!e)
  const genesis = entries[0]!
  const attempt = entries.find((e) => e.kind === "payment_attempt" && e.payload.attemptId === attemptId)
  if (!attempt) throw new Error(`no payment attempt ${attemptId} in ${logPath}`)
  const episodeId = attempt.payload.episodeId as string
  const r = await replayAttempt(logPath, attemptId, { expectedSignerDid: opts.guard.did, resolver: resolverFor(genesis, opts.didDocuments ?? {}) })
  const task = entries.find((e) => e.kind === "task" && e.payload.episodeId === episodeId)
  if (!task) throw new Error(`no task entry for episode ${episodeId}; a pack needs the task the owner set`)
  const steps = entries.filter((e) => e.kind === "agent_step" && e.payload.episodeId === episodeId && e.seq < attempt.seq)
  const related = entries.filter((e) => e.payload.attemptId === attemptId)
  const evidenceEntries = [genesis, task, ...steps, ...related].sort((a, b) => a.seq - b.seq)
  const g = genesis.payload as { controllerCredential: string; ownerDid: string; agentDid: string; policy: unknown; receiptServiceDid: string }

  const chain = (attempt.payload.delegationChain as string[] | undefined) ?? (g.controllerCredential ? [g.controllerCredential] : [])
  const payer = (attempt.payload.payer as string | undefined) ?? g.agentDid
  const docs = opts.didDocuments ?? {}
  const at = new Date(attempt.ts)
  const dv = await verifyDelegationChainAt(chain, { resolver: resolverFor(genesis, docs), ownerDid: g.ownerDid, rootAgentDid: g.agentDid, payerDid: payer, at })
  const decisions = related.filter((e) => e.kind === "decision")
  const last = decisions[decisions.length - 1]
  const d = last?.payload.decision as { outcome: string; rule: { id: string; detail: string }; checks: unknown[]; merchant?: string; endpoint?: string } | undefined
  const opt = (r.proposed.request?.options as { id: string; amount: string; decimals: number; currency: string; recipient: string }[] | undefined)?.find(
    (o) => o.id === (r.proposed.paymentOptionId ?? undefined),
  ) ?? (r.proposed.request?.options as { amount: string; decimals: number; currency: string }[] | undefined)?.[0]
  const head = JSON.parse(readFileSync(headPath(logPath), "utf8")) as DisputePack["evidence"]["head"]
  const genesisPolicyHash = createHash("sha256").update(canonicalJson(g.policy)).digest("hex")

  const pack: DisputePack = {
    format: PACK_FORMAT,
    generatedAt: new Date().toISOString(),
    signedBy: opts.guard.did,
    subject: {
      attemptId,
      episodeId,
      mode: r.mode,
      outcome: r.finalOutcome,
      decidingRule: d?.rule.id,
      decidingDetail: d?.rule.detail,
      amount: opt ? formatAmount(BigInt(opt.amount), opt.decimals, opt.currency) : undefined,
      merchant: d?.merchant,
      endpoint: d?.endpoint ?? ((last?.payload.facts as { provenance?: { path?: string } } | undefined)?.provenance?.path),
      payer,
      txId: (r.settlement?.tx as { txId?: string } | undefined)?.txId,
      attemptedAt: attempt.ts,
    },
    task: task.payload,
    delegation: { chain, links: dv.links, ok: dv.ok, error: dv.error, verifiedAt: at.toISOString() },
    policy: {
      version: (last?.payload.policyVersion as string | undefined) ?? (genesis.payload.policyVersion as string | undefined),
      source: last?.payload.policyVersion ? "decision" : "genesis",
      genesisPolicyHash,
      checks: d?.checks ?? [],
    },
    agentReasoning: r.reasoning,
    paymentRequest: { token: attempt.payload.paymentRequestToken as string, ...(r.proposed.request ?? {}), ok: !r.proposed.request?.error },
    receipt: r.receipt ? { jwt: r.receipt.jwt, issuer: r.receipt.issuer, ok: r.receipt.verifiedNow.ok, error: r.receipt.verifiedNow.error, txId: r.receipt.verifiedNow.txId } : undefined,
    settlement: r.settlement?.tx,
    evidence: { log: opts.logLabel ?? logPath, logEntries: v.entries, logHeadHash: v.headHash, entries: evidenceEntries, head, didDocuments: docs },
    verification: {},
    verifyCommand: `pnpm dispute-verify <this file> --signer ${opts.guard.did}`,
  }
  pack.verification = (await verifyDisputePack(pack, { signer: opts.guard.did, skipPackSignature: true })).checks
  pack.packHash = hashOf(pack)
  pack.packSignature = await createJwt({ format: PACK_FORMAT, packHash: pack.packHash }, { issuer: opts.guard.did, signer: opts.guard.signer }, { alg: opts.guard.alg })
  return pack
}

export interface PackVerification {
  ok: boolean
  pinned: boolean
  checks: Record<string, { ok: boolean; detail: string }>
}

export async function verifyDisputePack(pack: DisputePack, opts: { signer?: string; skipPackSignature?: boolean } = {}): Promise<PackVerification> {
  const checks: PackVerification["checks"] = {}
  const put = (k: string, ok: boolean, detail: string) => (checks[k] = { ok, detail })
  const signer = opts.signer ?? pack.signedBy
  const ev = pack.evidence
  const byKind = (k: string) => ev.entries.filter((e) => e.kind === k)
  const genesis = ev.entries.find((e) => e.seq === 0 && e.kind === "genesis")
  // Guard signatures: did:key, resolved from the key alone. Nothing in the pack can change it.
  const sigResolver = offlineDidResolver()
  if (!signer.startsWith("did:key:")) put("signer", false, `the guard key must be a did:key, got ${signer}`)
  const resolver = genesis ? resolverFor(genesis, ev.didDocuments ?? {}) : offlineDidResolver()

  // 1. The pack itself.
  if (!opts.skipPackSignature) {
    const h = hashOf(pack)
    let sigOk = false
    try {
      const jv = await verifyJwt(pack.packSignature ?? "", { resolver: sigResolver, issuer: signer, policies: { aud: false } })
      sigOk = (jv.payload as { packHash?: string }).packHash === h
    } catch {
      sigOk = false
    }
    put("packSignature", sigOk && pack.packHash === h, sigOk ? `pack content hash ${h.slice(0, 16)}... signed by ${signer}` : "the pack was changed after it was signed, or not signed by this key")
  }

  // 2. Every included log entry, and the head.
  const bad: string[] = []
  for (const e of ev.entries) {
    if (entryHash(e) !== e.hash) bad.push(`entry ${e.seq}: content does not match its hash`)
    if (e.seq === 0 && e.prevHash !== GENESIS_PREV) bad.push("entry 0: not a genesis entry")
    try {
      const jv = await verifyJwt(e.sig, { resolver: sigResolver, issuer: signer, policies: { aud: false } })
      const p = jv.payload as { seq?: number; hash?: string }
      if (p.seq !== e.seq || p.hash !== e.hash) bad.push(`entry ${e.seq}: signature covers a different entry`)
    } catch {
      bad.push(`entry ${e.seq}: signature does not verify for ${signer}`)
    }
  }
  for (let i = 1; i < ev.entries.length; i++) {
    const a = ev.entries[i - 1]!, b = ev.entries[i]!
    if (b.seq === a.seq + 1 && b.prevHash !== a.hash) bad.push(`entries ${a.seq} and ${b.seq} do not link`)
  }
  put("logEntries", !bad.length, bad.length ? bad.slice(0, 3).join("; ") : `${ev.entries.length} signed log entries verify (hash and guard signature each)`)
  let headOk = false
  try {
    const hv = await verifyJwt(ev.head.sig, { resolver: sigResolver, issuer: signer, policies: { aud: false } })
    const hp = hv.payload as { seq?: number; hash?: string; head?: boolean }
    headOk = hp.head === true && hp.seq === ev.head.seq && hp.hash === ev.head.hash && ev.entries.every((e) => e.seq <= ev.head.seq)
  } catch {
    headOk = false
  }
  put("signedHead", headOk, headOk ? `signed head: the log had ${ev.head.seq + 1} entries, ending at ${ev.head.hash.slice(0, 16)}...` : "the signed head does not verify or does not cover these entries")

  // 3. The pack's summary matches the signed entries.
  const attempt = byKind("payment_attempt").find((e) => e.payload.attemptId === pack.subject.attemptId)
  const decisions = byKind("decision").filter((e) => e.payload.attemptId === pack.subject.attemptId)
  const last = decisions[decisions.length - 1]
  const st = byKind("settlement").find((e) => e.payload.attemptId === pack.subject.attemptId)
  const rc = byKind("receipt").find((e) => e.payload.attemptId === pack.subject.attemptId)
  const task = byKind("task").find((e) => e.payload.episodeId === pack.subject.episodeId)
  const g = (genesis?.payload ?? {}) as { controllerCredential?: string; ownerDid?: string; agentDid?: string; receiptServiceDid?: string }
  const mism: string[] = []
  if (!attempt || !genesis || !task) mism.push("the pack lacks the genesis, task or payment attempt entry")
  if (attempt && attempt.payload.paymentRequestToken !== pack.paymentRequest.token) mism.push("payment request differs from the signed attempt")
  if (attempt && JSON.stringify((attempt.payload.delegationChain as string[] | undefined) ?? (g.controllerCredential ? [g.controllerCredential] : [])) !== JSON.stringify(pack.delegation.chain)) mism.push("delegation chain differs from the signed attempt")
  if (task && canonicalJson(task.payload) !== canonicalJson(pack.task)) mism.push("task differs from the signed task entry")
  const rec = last?.payload.decision as { outcome?: string; rule?: { id?: string; detail?: string }; checks?: unknown[]; merchant?: string; endpoint?: string } | undefined
  // Fields the chain re-check and the PDF depend on come from the signed entries, never from the pack's summary.
  const signedPayer = (attempt?.payload.payer as string | undefined) ?? g.agentDid
  const signedAt = attempt?.ts
  if (signedPayer !== pack.subject.payer) mism.push("payer differs from the signed attempt")
  if (signedAt !== pack.subject.attemptedAt) mism.push("attempt time differs from the signed attempt")
  if (rec?.rule?.detail !== pack.subject.decidingDetail) mism.push("rule detail differs from the signed decision")
  if (canonicalJson(rec?.checks ?? []) !== canonicalJson(pack.policy.checks)) mism.push("rule results differ from the signed decision")
  if (rec?.merchant !== pack.subject.merchant) mism.push("merchant differs from the signed decision")
  const signedEndpoint = rec?.endpoint ?? (last?.payload.facts as { provenance?: { path?: string } } | undefined)?.provenance?.path
  if (signedEndpoint !== pack.subject.endpoint) mism.push("endpoint differs from the signed decision")
  const signedVersion = (last?.payload.policyVersion as string | undefined) ?? (genesis?.payload.policyVersion as string | undefined)
  if (signedVersion !== pack.policy.version) mism.push("policy version differs from the signed log")
  // The amount comes from the signed payment request option the attempt named.
  try {
    const { paymentRequest } = await verifyPaymentRequestToken(pack.paymentRequest.token as JwtString, { resolver, verifyExpiry: false })
    const optId = attempt?.payload.paymentOptionId as string | null | undefined
    const o = paymentRequest.paymentOptions.find((x) => x.id === optId) ?? paymentRequest.paymentOptions[0]
    const amount = o ? formatAmount(BigInt(o.amount), o.decimals, o.currency) : undefined
    if (amount !== pack.subject.amount) mism.push(`amount ${pack.subject.amount} differs from the signed payment request (${amount})`)
  } catch {
    /* reported by the paymentRequest check below */
  }
  const outcome = st ? "paid" : byKind("payment_error").some((e) => e.payload.attemptId === pack.subject.attemptId) ? "failed" : rec?.outcome
  if (outcome !== pack.subject.outcome) mism.push(`outcome ${pack.subject.outcome} differs from the signed log (${outcome})`)
  if (rec?.rule?.id !== pack.subject.decidingRule) mism.push("deciding rule differs from the signed decision")
  if ((st?.payload.tx as { txId?: string } | undefined)?.txId !== pack.subject.txId) mism.push("transaction differs from the signed settlement")
  if ((rc?.payload.receipt as string | undefined) !== pack.receipt?.jwt) mism.push("receipt differs from the signed receipt entry")
  // Everything else the pack (and its PDF) says, re-derived from the signed entries.
  if (attempt && attempt.payload.episodeId !== pack.subject.episodeId) mism.push("episode differs from the signed attempt")
  if (attempt && attempt.payload.mode !== pack.subject.mode) mism.push("agent mode differs from the signed attempt")
  const steps = ev.entries
    .filter((e) => e.kind === "agent_step" && e.payload.episodeId === attempt?.payload.episodeId && e.seq < (attempt?.seq ?? 0))
    .map((e) => ({ seq: e.seq, text: e.payload.text, toolCalls: e.payload.toolCalls }))
  if (canonicalJson(steps) !== canonicalJson(pack.agentReasoning.map((r) => ({ seq: r.seq, text: r.text, toolCalls: r.toolCalls })))) mism.push("agent steps differ from the signed entries")
  if (canonicalJson(st?.payload.tx ?? null) !== canonicalJson(pack.settlement ?? null)) mism.push("settlement differs from the signed settlement entry")
  if (pack.receipt && pack.receipt.issuer !== g.receiptServiceDid) mism.push("receipt issuer is not the receipt service named in the signed genesis")
  if (ev.logHeadHash !== ev.head.hash || ev.logEntries !== ev.head.seq + 1) mism.push("the log head and size the pack states differ from the signed head")
  if (genesis && pack.policy.genesisPolicyHash !== createHash("sha256").update(canonicalJson(genesis.payload.policy)).digest("hex")) mism.push("genesis policy hash differs from the signed genesis")
  if (pack.policy.source !== (last?.payload.policyVersion ? "decision" : "genesis")) mism.push("policy source differs from the signed log")
  // Completeness within this attempt: an allowed payment ends in a settlement or an error, and a settlement has a receipt.
  if (rec?.outcome === "allow" && !st && !byKind("payment_error").some((e) => e.payload.attemptId === pack.subject.attemptId))
    mism.push("the guard allowed this attempt but the pack has no settlement or payment error for it")
  if (st && !rc) mism.push("a settled attempt without its receipt entry")
  put(
    "matchesLog",
    !mism.length,
    mism.length ? mism.join("; ") : "outcome, rule and its detail, every rule result, policy version, amount, merchant, payer, time, task, chain, transaction and receipt match the signed entries",
  )

  // 4. The ACK artifacts, re-verified. As with the chain, the check is that the pack reports
  // each one exactly as it verifies: a request the guard refused on REQ_SIGNATURE does not verify.
  try {
    const { paymentRequest, parsed } = await verifyPaymentRequestToken(pack.paymentRequest.token as JwtString, { resolver, verifyExpiry: false })
    const same =
      pack.paymentRequest.ok === true &&
      pack.paymentRequest.issuer === parsed.issuer &&
      pack.paymentRequest.id === paymentRequest.id &&
      pack.paymentRequest.description === paymentRequest.description &&
      canonicalJson(pack.paymentRequest.options ?? null) === canonicalJson(paymentRequest.paymentOptions)
    put("paymentRequest", same, same ? `ACK-Pay payment request signed by ${parsed.issuer}, as the pack reports` : "the pack misreports the signed payment request")
  } catch (e) {
    const same = pack.paymentRequest.ok === false
    put("paymentRequest", same, `payment request does not verify (${(e as Error).message.slice(0, 100)})${same ? ", as the pack reports" : "; the pack claims it does"}`)
  }
  if (pack.receipt) {
    const issuer = g.receiptServiceDid ?? pack.receipt.issuer
    const v = await checkReceipt(pack.receipt.jwt, { resolver, trustedReceiptIssuers: [issuer], paymentRequestIssuer: pack.paymentRequest.issuer })
    const same = v.ok === pack.receipt.ok && v.txId === pack.receipt.txId && v.txId === pack.subject.txId
    put("receipt", v.ok && same, v.ok ? `ACK PaymentReceiptCredential from ${issuer} verifies, for transaction ${v.txId}${same ? "" : "; the pack misreports it"}` : `receipt does not verify: ${v.error}`)
  } else put("receipt", pack.subject.outcome !== "paid", pack.subject.outcome === "paid" ? "a paid attempt without a receipt" : "no money moved, so no receipt")
  // Re-verified from the signed chain, payer and time. A blocked attempt can rest on an
  // invalid chain (a forged link was refused); the check is that the pack reports the
  // chain exactly as it verifies, link by link.
  const dv = await verifyDelegationChainAt(pack.delegation.chain, {
    resolver,
    ownerDid: g.ownerDid ?? "",
    rootAgentDid: g.agentDid ?? "",
    payerDid: signedPayer ?? "",
    at: new Date(signedAt ?? 0),
  })
  const sameReport =
    dv.ok === pack.delegation.ok &&
    dv.error === pack.delegation.error &&
    canonicalJson(dv.links) === canonicalJson(pack.delegation.links) &&
    pack.delegation.verifiedAt === new Date(signedAt ?? 0).toISOString()
  put(
    "delegationChain",
    sameReport,
    `${dv.ok ? "valid" : `invalid (${dv.error})`} at the payment time, ${pack.delegation.chain.length} link(s) from the owner to ${signedPayer}${sameReport ? ", as the pack reports" : "; the pack reports it differently"}`,
  )
  // The results stored in the pack (and printed in its PDF) must be what a fresh run gives.
  if (!opts.skipPackSignature) {
    const fresh = Object.fromEntries(Object.entries(checks).filter(([k]) => k !== "packSignature").map(([k, c]) => [k, c.ok]))
    const stored = Object.fromEntries(Object.entries(pack.verification ?? {}).map(([k, c]) => [k, c.ok]))
    const same = canonicalJson(fresh) === canonicalJson(stored)
    put("storedResults", same, same ? "the results stored in the pack match this run" : "the results stored in the pack (and printed in its PDF) differ from this run")
  }
  const pinned = !!opts.signer
  const ok = Object.values(checks).every((c) => c.ok)
  return { ok, pinned, checks }
}
