// Replay: reconstruct, from the signed log alone, everything about one payment
// attempt: task, agent reasoning, proposed payment, policy rule and checks,
// identity, receipt, and fresh verification results.

import { getDidResolver, verifyPaymentRequestToken, type DidDocument, type DidResolver } from "agentcommercekit"
import { verifyAgentIdentity } from "../identity/verify-identity.js"
import { checkReceipt } from "../receipts/receipt-service.js"
import type { AuditEntry } from "./chain.js"
import { readEntries, verifyLog, type VerifyReport } from "./verify.js"

export interface AttemptSummary {
  attemptId: string
  episodeId: string
  mode: string
  scenarioId?: string
  category?: string
  outcome: string
  rule: string
  amount?: string
  merchant?: string
  seq: number
  ts: string
}

export interface ReplayResult {
  attemptId: string
  episodeId: string
  mode: string
  task?: Record<string, unknown>
  identity: {
    agentDid?: string
    ownerDid?: string
    controllerCredentialValid: boolean
    detail?: string
  }
  reasoning: { seq: number; text?: string; toolCalls?: unknown[] }[]
  proposed: {
    seq: number
    agentPurpose?: string
    paymentOptionId?: string | null
    request?: { issuer?: string; id?: string; description?: string; options?: unknown[]; error?: string }
  }
  decisions: { seq: number; outcome: string; rule: unknown; checks: unknown[]; afterApproval?: boolean }[]
  approval?: { seq: number; approved: boolean; by: string }
  settlement?: { seq: number; tx: Record<string, unknown> }
  receipt?: { seq: number; jwt: string; issuer: string; verifiedNow: { ok: boolean; error?: string; txId?: string } }
  chain: VerifyReport & { relatedSeqs: number[]; relatedEntriesIntact: boolean }
  error?: string
  /** Only a fully verified log signed by a pinned key is trustworthy evidence. */
  trusted: boolean
  finalOutcome: string
}

function genesisOf(entries: AuditEntry[]) {
  return entries.find((e) => e.kind === "genesis")
}

export function listAttempts(path: string): AttemptSummary[] {
  const entries = readEntries(path).entries.filter((e): e is AuditEntry => !!e)
  const tasks = new Map<string, AuditEntry>()
  for (const e of entries) if (e.kind === "task") tasks.set(e.payload.episodeId as string, e)
  const out: AttemptSummary[] = []
  const lastDecision = new Map<string, AuditEntry>()
  for (const e of entries) if (e.kind === "decision") lastDecision.set(e.payload.attemptId as string, e)
  for (const e of entries) {
    if (e.kind !== "payment_attempt") continue
    const attemptId = e.payload.attemptId as string
    const d = lastDecision.get(attemptId)
    const dec = d?.payload.decision as { outcome?: string; rule?: { id?: string }; merchant?: string; amount?: string } | undefined
    const settled = entries.some((x) => x.kind === "settlement" && x.payload.attemptId === attemptId)
    const failed = entries.some((x) => x.kind === "payment_error" && x.payload.attemptId === attemptId)
    const answered = entries.some((x) => x.kind === "approval" && x.payload.attemptId === attemptId)
    const t = tasks.get(e.payload.episodeId as string)
    out.push({
      attemptId,
      episodeId: e.payload.episodeId as string,
      mode: e.payload.mode as string,
      scenarioId: t?.payload.scenarioId as string | undefined,
      category: t?.payload.category as string | undefined,
      outcome: settled ? "paid" : failed ? "failed" : dec?.outcome === "needs_approval" && !answered ? "awaiting_approval" : (dec?.outcome ?? "unknown"),
      rule: dec?.rule?.id ?? "?",
      amount: dec?.amount,
      merchant: dec?.merchant,
      seq: e.seq,
      ts: e.ts,
    })
  }
  return out
}

export async function replayAttempt(
  path: string,
  attemptId: string,
  opts: { expectedSignerDid?: string; resolver?: DidResolver } = {},
): Promise<ReplayResult> {
  const resolver = opts.resolver ?? getDidResolver()
  const all = readEntries(path).entries
  // Remember each entry's line, so integrity is matched by position, not by the seq an entry claims.
  const lineOf = new Map<AuditEntry, number>()
  all.forEach((e, i) => e && lineOf.set(e, i + 1))
  const entries = all.filter((e): e is AuditEntry => !!e)
  const genesis = genesisOf(entries)
  const g = (genesis?.payload ?? {}) as {
    guardDid?: string
    ownerDid?: string
    agentDid?: string
    agentDidDocument?: DidDocument
    controllerCredential?: string
    receiptServiceDid?: string
  }
  // The agent's did:web document was recorded (and signed) in the genesis entry.
  if (g.agentDid && g.agentDidDocument) resolver.addToCache(g.agentDid as `did:${string}:${string}`, g.agentDidDocument)

  const attempt = entries.find((e) => e.kind === "payment_attempt" && e.payload.attemptId === attemptId)
  if (!attempt) throw new Error(`no payment attempt ${attemptId} in ${path}`)
  const episodeId = attempt.payload.episodeId as string
  const related = entries.filter((e) => e.payload.attemptId === attemptId)
  const task = entries.find((e) => e.kind === "task" && e.payload.episodeId === episodeId)
  const reasoning = entries
    .filter((e) => e.kind === "agent_step" && e.payload.episodeId === episodeId && e.seq < attempt.seq)
    .map((e) => ({ seq: e.seq, text: e.payload.text as string | undefined, toolCalls: e.payload.toolCalls as unknown[] | undefined }))

  // Decode the payment request the agent tried to pay (signature checked, expiry ignored for replay).
  const token = attempt.payload.paymentRequestToken as string
  let request: ReplayResult["proposed"]["request"]
  try {
    const { paymentRequest, parsed } = await verifyPaymentRequestToken(token as `${string}.${string}.${string}`, {
      resolver,
      verifyExpiry: false,
    })
    request = { issuer: parsed.issuer, id: paymentRequest.id, description: paymentRequest.description, options: paymentRequest.paymentOptions }
  } catch (e) {
    request = { error: (e as Error).message.slice(0, 200) }
  }

  const identity = g.controllerCredential
    ? await verifyAgentIdentity(g.controllerCredential, { resolver, expectedOwnerDid: g.ownerDid ?? "", expectedAgentDid: g.agentDid })
    : { ok: false, error: "no controller credential in genesis" }

  const decisions = related
    .filter((e) => e.kind === "decision")
    .map((e) => {
      const d = e.payload.decision as { outcome: string; rule: unknown; checks: unknown[] }
      return { seq: e.seq, outcome: d.outcome, rule: d.rule, checks: d.checks, afterApproval: e.payload.afterApproval as boolean | undefined }
    })
  const ap = related.find((e) => e.kind === "approval")
  const st = related.find((e) => e.kind === "settlement")
  const err = related.find((e) => e.kind === "payment_error")
  const rc = related.find((e) => e.kind === "receipt")
  let receipt: ReplayResult["receipt"]
  if (rc) {
    const jwt = rc.payload.receipt as string
    // Trust the receipt service named in the (guard-signed) genesis entry, not the receipt entry itself.
    const issuer = g.receiptServiceDid ?? (rc.payload.receiptIssuer as string)
    const v = await checkReceipt(jwt, { resolver, trustedReceiptIssuers: [issuer], paymentRequestIssuer: request?.issuer })
    receipt = { seq: rc.seq, jwt, issuer, verifiedNow: { ok: v.ok, error: v.error, txId: v.txId } }
  }

  // Only an externally supplied signer counts as pinned. Without one, the
  // identity and receipt checks above are relative to the log's own genesis.
  const chain = await verifyLog(path, { expectedSignerDid: opts.expectedSignerDid, resolver })
  const usedEntries = [
    genesis,
    task,
    ...entries.filter((e) => e.kind === "agent_step" && e.payload.episodeId === episodeId && e.seq < attempt.seq),
    ...related,
  ].filter((e): e is AuditEntry => !!e)
  const relatedSeqs = usedEntries.map((e) => (Number.isInteger(e.seq) ? e.seq : -1))
  const badLines = new Set(chain.problems.map((p) => p.line))
  const relatedIntact = usedEntries.every((e) => Number.isInteger(e.seq) && !badLines.has(lineOf.get(e) ?? -1))
  const lastDecision = decisions[decisions.length - 1]
  return {
    attemptId,
    episodeId,
    mode: attempt.payload.mode as string,
    task: task?.payload,
    identity: {
      agentDid: g.agentDid,
      ownerDid: g.ownerDid,
      controllerCredentialValid: identity.ok,
      detail: identity.ok ? `controller ${identity.controller}` : identity.error,
    },
    reasoning,
    proposed: {
      seq: attempt.seq,
      agentPurpose: attempt.payload.agentPurpose as string | undefined,
      paymentOptionId: attempt.payload.paymentOptionId as string | null,
      request,
    },
    decisions,
    approval: ap ? { seq: ap.seq, approved: ap.payload.approved as boolean, by: ap.payload.by as string } : undefined,
    settlement: st ? { seq: st.seq, tx: st.payload.tx as Record<string, unknown> } : undefined,
    receipt,
    chain: { ...chain, relatedSeqs, relatedEntriesIntact: relatedIntact },
    trusted: chain.ok && chain.pinned,
    error: err ? (err.payload.error as string) : undefined,
    finalOutcome: st ? "paid" : err ? "failed" : (lastDecision?.outcome ?? "unknown"),
  }
}
