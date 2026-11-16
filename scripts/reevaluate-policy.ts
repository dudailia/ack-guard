// Re-runs the CURRENT policy engine over every guarded decision recorded in a
// run's signed log, to see which recorded episodes a policy change would have
// affected. For each decision it rebuilds the spend history from the
// settlements recorded before it, evaluates the recorded facts with the
// current engine and the current scenario definitions, and compares the
// outcome and deciding rule with what was recorded. An episode is affected at
// its first differing decision; after that the model may have acted
// differently, so the rest of the episode cannot be re-derived and the
// scenario must be re-run.
//
// usage: tsx scripts/reevaluate-policy.ts results/<model>/<run>/audit.jsonl

import { readFileSync } from "node:fs"
import type { AuditEntry } from "../src/audit/chain.js"
import { buildIdentities } from "../src/identity/identities.js"
import { capabilityFor, evaluatePayment } from "../src/policy/engine.js"
import type { PaymentFacts, PolicyConfig, SpendHistory } from "../src/policy/types.js"
import { ALL_SCENARIOS } from "../src/redteam/index.js"
import { makeBuildCtx } from "../src/redteam/types.js"

const path = process.argv[2]
if (!path) {
  console.error("usage: tsx scripts/reevaluate-policy.ts <audit.jsonl>")
  process.exit(1)
}
const entries = readFileSync(path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as AuditEntry)

const genesis = entries[0]!.payload as {
  ownerDid: string
  agentDid: string
  policy: { merchants: { key: string; displayName: string; did: string; hosts: string[]; recipient: string; endpoints: { path: string; capability: string; price: string; currency: string; decimals: number }[] }[]; limits: Record<string, string> }
}
const config: PolicyConfig = {
  ownerDid: genesis.ownerDid,
  agentDid: genesis.agentDid,
  merchants: genesis.policy.merchants.map((m) => ({ ...m, endpoints: m.endpoints.map((e) => ({ ...e, price: BigInt(e.price) })) })),
  limits: {
    perPaymentCap: BigInt(genesis.policy.limits.perPaymentCap!),
    approvalThreshold: BigInt(genesis.policy.limits.approvalThreshold!),
    dailyCap: BigInt(genesis.policy.limits.dailyCap!),
    duplicateWindowMs: Number(genesis.policy.limits.duplicateWindowMs),
  },
}

const byEpisode = new Map<string, AuditEntry[]>()
for (const e of entries) {
  const ep = e.payload.episodeId as string | undefined
  if (!ep || !ep.includes("/guarded/")) continue
  if (!byEpisode.has(ep)) byEpisode.set(ep, [])
  byEpisode.get(ep)!.push(e)
}

const ctx = makeBuildCtx(await buildIdentities())
const affectedByScenario = new Map<string, string[]>()
let decisions = 0
for (const [ep, mine] of byEpisode) {
  const taskEntry = mine.find((e) => e.kind === "task")
  if (!taskEntry) continue
  const scenario = ALL_SCENARIOS.find((s) => s.id === taskEntry.payload.scenarioId)
  if (!scenario) continue
  const built = await scenario.build(ctx)
  const t = taskEntry.payload.task as { id: string; budget: string }
  // Current scenario needs (they may have changed), recorded task id and budget.
  const task = { ...built.task, id: t.id, budget: BigInt(t.budget) }
  const startTs = Date.parse(taskEntry.ts)
  const history: SpendHistory = {
    payments: (built.priorSpend ?? []).map((p, i) => ({
      ts: startTs - p.hoursAgo * 3600_000,
      amount: p.amount,
      taskId: "earlier-task",
      paymentRequestId: `prior-${i}`,
      merchantDid: config.merchants.find((m) => m.key === "lingua")!.did,
    })),
  }
  const factsByAttempt = new Map<string, PaymentFacts>()
  for (const e of mine) {
    if (e.kind === "decision") {
      const f = e.payload.facts as PaymentFacts & { option?: { amount: string } }
      const facts: PaymentFacts = { ...f, option: f.option ? { ...f.option, amount: BigInt(f.option.amount) } : undefined }
      factsByAttempt.set(e.payload.attemptId as string, facts)
      if (e.payload.afterApproval) continue
      decisions++
      const now = evaluatePayment(facts, task, config, history, Date.parse(e.ts))
      const rec = e.payload.decision as { outcome: string; rule: { id: string } }
      if (now.outcome !== rec.outcome || now.rule.id !== rec.rule.id) {
        const list = affectedByScenario.get(scenario.id) ?? []
        list.push(`${ep}: ${e.payload.attemptId} recorded ${rec.outcome}/${rec.rule.id}, now ${now.outcome}/${now.rule.id}`)
        affectedByScenario.set(scenario.id, list)
        break
      }
    } else if (e.kind === "settlement") {
      const facts = factsByAttempt.get(e.payload.attemptId as string)
      const tx = e.payload.tx as { amount: string; paymentRequestId: string; ts: number }
      history.payments.push({
        ts: tx.ts,
        amount: BigInt(tx.amount),
        taskId: task.id,
        url: facts?.provenance.url,
        paymentRequestId: tx.paymentRequestId,
        merchantDid: facts?.requestSignature.issuer ?? "",
        capability: capabilityFor(config, facts?.requestSignature.issuer, facts?.provenance.path),
      })
    }
  }
}

console.log(`${byEpisode.size} guarded episodes, ${decisions} first decisions re-evaluated with the current engine.`)
if (!affectedByScenario.size) console.log("No recorded decision changes.")
for (const [id, list] of [...affectedByScenario.entries()].sort()) {
  console.log(`\n${id}: ${list.length} affected episode(s)`)
  for (const l of list) console.log(`  ${l}`)
}
console.log(`\nAffected scenarios: ${[...affectedByScenario.keys()].sort().join(",") || "none"}`)
