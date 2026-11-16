// Policy diff: before a policy change is approved, replay a signed audit log
// and show exactly which past payment decisions would come out differently.
//
// The log must verify against a pinned guard key first. Then, for every
// guarded payment attempt, the recorded facts (signature, identity,
// provenance, option) are evaluated twice with the current engine: once under
// the current policy and once under the proposed one. The spend history for
// each decision is rebuilt from the settlements the log recorded before it.
//
// What it cannot know: how the agent would have behaved after a decision that
// comes out differently (a newly allowed payment could have led the agent
// elsewhere). Later attempts in such an episode are marked, not guessed.

import { readEntries, verifyLog } from "../audit/verify.js"
import type { AuditEntry } from "../audit/chain.js"
import { formatAmount } from "../money.js"
import { KNOWN_SCENARIOS } from "../redteam/index.js"
import { makeBuildCtx } from "../redteam/types.js"
import { buildIdentities } from "../identity/identities.js"
import { capabilityFor, evaluatePayment } from "./engine.js"
import { policyConfig, type LoadedPolicy, type PolicyDocument } from "./policy-file.js"
import type { Outcome, PaidRecord, PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "./types.js"

export type ChangeKind = "now allowed" | "now blocked" | "now escalated" | "different rule"

export interface DecisionChange {
  attemptId: string
  episodeId: string
  scenarioId?: string
  merchant?: string
  endpoint?: string
  amount?: string
  current: { outcome: Outcome; rule: string; detail: string }
  proposed: { outcome: Outcome; rule: string; detail: string }
  change: ChangeKind
  /** An earlier decision in the same episode also changed, so the agent might not have reached this one. */
  afterEarlierChange: boolean
}

export interface PolicyDiffReport {
  log: string
  logVerified: boolean
  logHeadHash?: string
  logEntries: number
  signer?: string
  from: { version: string; hash: string }
  to: { version: string; hash: string }
  policyChanges: string[]
  decisionsReplayed: number
  unchanged: number
  changes: DecisionChange[]
  counts: Record<ChangeKind, number>
  /** Recorded decisions that the current engine and policy no longer reproduce (code changed since the log was written). */
  notReproduced: { attemptId: string; recorded: string; current: string }[]
  notes: string[]
}

const outcomeWord = (o: Outcome) => (o === "allow" ? "allowed" : o === "deny" ? "blocked" : "held for a human")

/** Plain-English differences between two policy documents. */
export function describePolicyChange(a: PolicyDocument, b: PolicyDocument): string[] {
  const out: string[] = []
  const lim: [keyof PolicyDocument["limits"], string][] = [
    ["per_payment_cap", "Per-payment cap"],
    ["approval_threshold", "Payments need a human above"],
    ["daily_cap", "Daily cap"],
    ["duplicate_window_hours", "Duplicate window (hours)"],
  ]
  for (const [k, label] of lim) {
    if (String(a.limits[k]) !== String(b.limits[k])) {
      const fmt = (v: unknown) => (k === "duplicate_window_hours" ? String(v) : `$${v}`)
      out.push(`${label}: ${fmt(a.limits[k])} -> ${fmt(b.limits[k])}`)
    }
  }
  const am = new Map(a.merchants.map((m) => [m.key, m]))
  const bm = new Map(b.merchants.map((m) => [m.key, m]))
  for (const [k, m] of bm) if (!am.has(k)) out.push(`New merchant allowed: ${m.name} (${m.hosts.join(", ")})`)
  for (const [k, m] of am) if (!bm.has(k)) out.push(`Merchant removed: ${m.name}`)
  for (const [k, ma] of am) {
    const mb = bm.get(k)
    if (!mb) continue
    if (ma.hosts.join(",") !== mb.hosts.join(",")) out.push(`${ma.name} hosts: ${ma.hosts.join(", ")} -> ${mb.hosts.join(", ")}`)
    if ((ma.payout ?? "") !== (mb.payout ?? "") || (ma.did ?? "") !== (mb.did ?? "")) out.push(`${ma.name} identity or payout account changed`)
    const ea = new Map(ma.sells.map((e) => [e.path, e]))
    const eb = new Map(mb.sells.map((e) => [e.path, e]))
    for (const [p, e] of eb) if (!ea.has(p)) out.push(`${ma.name} may now sell ${p} (${e.capability}) at $${e.price}`)
    for (const [p] of ea) if (!eb.has(p)) out.push(`${ma.name} may no longer sell ${p}`)
    for (const [p, e] of ea) {
      const f = eb.get(p)
      if (f && f.price !== e.price) out.push(`${ma.name} ${p} price: $${e.price} -> $${f.price}`)
      if (f && f.capability !== e.capability) out.push(`${ma.name} ${p} capability: ${e.capability} -> ${f.capability}`)
    }
  }
  const ra = new Map(a.rules.map((r) => [r.id, r]))
  for (const r of b.rules) {
    const o = ra.get(r.id)
    if (!o) continue
    if ((o.enabled !== false) !== (r.enabled !== false)) out.push(`Rule ${r.id} switched ${r.enabled === false ? "off" : "on"}`)
    if (o.on_fail !== r.on_fail) out.push(`Rule ${r.id} failures: ${o.on_fail === "deny" ? "refused" : "sent to a human"} -> ${r.on_fail === "deny" ? "refused" : "sent to a human"}`)
  }
  if (!out.length && a.version !== b.version) out.push(`Version ${a.version} -> ${b.version} (no rule, limit or merchant changes)`)
  return out
}

function kindOf(cur: Outcome, next: Outcome): ChangeKind {
  if (cur === next) return "different rule"
  if (next === "allow") return "now allowed"
  if (next === "deny") return "now blocked"
  return "now escalated"
}

export async function policyDiff(
  logPath: string,
  current: LoadedPolicy,
  proposed: LoadedPolicy,
  opts: { expectedSignerDid: string },
): Promise<PolicyDiffReport> {
  const v = await verifyLog(logPath, { expectedSignerDid: opts.expectedSignerDid })
  const base = {
    log: logPath,
    logVerified: v.ok,
    logHeadHash: v.headHash,
    logEntries: v.entries,
    signer: opts.expectedSignerDid,
    from: { version: current.version, hash: current.hash },
    to: { version: proposed.version, hash: proposed.hash },
    policyChanges: describePolicyChange(current.doc, proposed.doc),
  }
  const counts: Record<ChangeKind, number> = { "now allowed": 0, "now blocked": 0, "now escalated": 0, "different rule": 0 }
  if (!v.ok) {
    return { ...base, decisionsReplayed: 0, unchanged: 0, changes: [], counts, notReproduced: [], notes: [`The log does not verify against ${opts.expectedSignerDid}, so it was not replayed.`] }
  }

  const entries = readEntries(logPath).entries.filter((e): e is AuditEntry => !!e)
  const g = entries[0]!.payload as { ownerDid: string; agentDid: string; policy?: { merchants: { key: string; did: string; recipient: string }[] } }
  // Merchant identities as recorded when the log was written.
  const known = new Map((g.policy?.merchants ?? []).map((m) => [m.key, { did: m.did, recipient: m.recipient }]))
  const owner = { ownerDid: g.ownerDid, agentDid: g.agentDid }
  const curCfg: PolicyConfig = policyConfig(current, owner, (k) => known.get(k))
  const newCfg: PolicyConfig = policyConfig(proposed, owner, (k) => known.get(k))

  const byEpisode = new Map<string, AuditEntry[]>()
  for (const e of entries) {
    const ep = e.payload.episodeId as string | undefined
    if (!ep) continue
    if (!byEpisode.has(ep)) byEpisode.set(ep, [])
    byEpisode.get(ep)!.push(e)
  }

  const notes: string[] = []
  let ctx: Awaited<ReturnType<typeof makeBuildCtx>> | undefined
  const changes: DecisionChange[] = []
  const notReproduced: PolicyDiffReport["notReproduced"] = []
  let replayed = 0
  let fallbackPrior = 0
  for (const [ep, mine] of byEpisode) {
    const taskEntry = mine.find((e) => e.kind === "task")
    if (!taskEntry || taskEntry.payload.mode !== "guarded") continue
    const t = taskEntry.payload.task as { id: string; prompt: string; needs: string[]; budget: string }
    const task: TaskSpec = { ...t, budget: BigInt(t.budget) }
    const startTs = Date.parse(taskEntry.ts)
    const history: SpendHistory = { payments: [] }
    const snap = taskEntry.payload.spendAtStart as (Omit<PaidRecord, "amount"> & { amount: string })[] | undefined
    if (snap) history.payments.push(...snap.map((p) => ({ ...p, amount: BigInt(p.amount) })))
    else {
      // Logs written before spendAtStart was recorded: rebuild seeded prior spend from the scenario.
      const sc = KNOWN_SCENARIOS.find((s) => s.id === taskEntry.payload.scenarioId)
      if (sc) {
        ctx ??= makeBuildCtx(await buildIdentities())
        const built = await sc.build(ctx)
        for (const [i, p] of (built.priorSpend ?? []).entries()) {
          history.payments.push({ ts: startTs - p.hoursAgo * 3600_000, amount: p.amount, taskId: "earlier-task", paymentRequestId: `prior-${i}`, merchantDid: known.get("lingua")?.did ?? "" })
          fallbackPrior++
        }
      }
    }
    const facts = new Map<string, PaymentFacts>()
    let changedEarlier = false
    for (const e of mine) {
      if (e.kind === "decision" && !e.payload.afterApproval) {
        const f = e.payload.facts as PaymentFacts & { option?: { amount: string } }
        const pf: PaymentFacts = { ...f, option: f.option ? { ...f.option, amount: BigInt(f.option.amount) } : undefined }
        facts.set(e.payload.attemptId as string, pf)
        const now = Date.parse(e.ts)
        const cur = evaluatePayment(pf, task, curCfg, history, now)
        const nxt = evaluatePayment(pf, task, newCfg, history, now)
        replayed++
        const rec = e.payload.decision as { outcome: Outcome; rule: { id: string } }
        if (rec.outcome !== cur.outcome || rec.rule.id !== cur.rule.id)
          notReproduced.push({ attemptId: e.payload.attemptId as string, recorded: `${rec.outcome}/${rec.rule.id}`, current: `${cur.outcome}/${cur.rule.id}` })
        if (cur.outcome !== nxt.outcome || cur.rule.id !== nxt.rule.id) {
          const change = kindOf(cur.outcome, nxt.outcome)
          counts[change]++
          changes.push({
            attemptId: e.payload.attemptId as string,
            episodeId: ep,
            scenarioId: taskEntry.payload.scenarioId as string | undefined,
            merchant: cur.merchant ?? nxt.merchant,
            endpoint: cur.endpoint ?? nxt.endpoint ?? pf.provenance.path,
            amount: pf.option ? formatAmount(pf.option.amount, pf.option.decimals, pf.option.currency) : undefined,
            current: { outcome: cur.outcome, rule: cur.rule.id, detail: cur.rule.detail },
            proposed: { outcome: nxt.outcome, rule: nxt.rule.id, detail: nxt.rule.detail },
            change,
            afterEarlierChange: changedEarlier,
          })
          changedEarlier = true
        }
      } else if (e.kind === "settlement") {
        const pf = facts.get(e.payload.attemptId as string)
        const tx = e.payload.tx as { amount: string; paymentRequestId: string; ts: number }
        history.payments.push({
          ts: tx.ts,
          amount: BigInt(tx.amount),
          taskId: task.id,
          url: pf?.provenance.url,
          paymentRequestId: tx.paymentRequestId,
          merchantDid: pf?.requestSignature.issuer ?? "",
          capability: capabilityFor(curCfg, pf?.requestSignature.issuer, pf?.provenance.path),
          // Delegation: the scoped links this payment counted against, as recorded in its facts.
          ...(pf?.identity.chain ? { links: pf.identity.chain.links.filter((l) => l.scope).map((l) => l.id) } : {}),
        })
      }
    }
  }
  if (fallbackPrior) notes.push(`This log predates recorded spend snapshots; prior spend for ${fallbackPrior} seeded payment(s) was rebuilt from the scenario definitions.`)
  if (changes.some((c) => c.afterEarlierChange))
    notes.push("Some changed decisions come after an earlier change in the same episode. The agent might have acted differently after the first change, so treat those as indicative.")
  if (notReproduced.length)
    notes.push(`${notReproduced.length} recorded decision(s) are not reproduced by today's engine under the current policy (the code changed after the log was written). The comparison above is between current and proposed policy, both with today's engine.`)
  if (!changes.length) notes.push(`No past decision in this log would come out differently: all ${replayed} were ${replayed ? "unchanged" : "absent"}.`)
  return { ...base, decisionsReplayed: replayed, unchanged: replayed - changes.length, changes, counts, notReproduced, notes }
}

/** One line per change, for the terminal. */
export function changeLine(c: DecisionChange): string {
  return `${c.change.toUpperCase()}: ${c.attemptId} ${c.amount ?? ""} ${c.merchant ?? ""} ${c.endpoint ?? ""}: ${outcomeWord(c.current.outcome)} by ${c.current.rule} -> ${outcomeWord(c.proposed.outcome)} by ${c.proposed.rule}${c.afterEarlierChange ? " (after an earlier change in this episode)" : ""}`
}
