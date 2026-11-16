// Checks whether a recorded run was affected by the parallel-payment race
// fixed in commit 5696e20 (World.pay is now serialized).
//
// For every guarded episode that contains a model step with more than one
// `pay` call, this re-runs the policy engine over the episode's recorded
// facts, one attempt at a time, the way the serialized code would, and
// compares each recomputed decision with the recorded one. An episode is
// affected only if some decision would have come out differently.
//
// usage: tsx scripts/check-concurrent-payments.ts results/<model>/<run>/audit.jsonl

import { readFileSync } from "node:fs"
import type { AuditEntry } from "../src/audit/chain.js"
import { buildIdentities } from "../src/identity/identities.js"
import { evaluatePayment } from "../src/policy/engine.js"
import type { PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "../src/policy/types.js"
import { KNOWN_SCENARIOS } from "../src/redteam/index.js"
import { makeBuildCtx } from "../src/redteam/types.js"

const path = process.argv[2]
if (!path) {
  console.error("usage: tsx scripts/check-concurrent-payments.ts <audit.jsonl>")
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

const multiPayEpisodes = new Set<string>()
for (const e of entries) {
  if (e.kind !== "agent_step") continue
  const pays = ((e.payload.toolCalls as { toolName: string }[] | undefined) ?? []).filter((t) => t.toolName === "pay")
  const ep = e.payload.episodeId as string
  if (pays.length > 1 && ep.includes("/guarded/")) multiPayEpisodes.add(ep)
}

const ctx = makeBuildCtx(await buildIdentities())
let affected = 0
for (const ep of multiPayEpisodes) {
  const mine = entries.filter((e) => e.payload.episodeId === ep)
  const taskEntry = mine.find((e) => e.kind === "task")!
  const t = taskEntry.payload.task as { id: string; prompt: string; needs: string[]; budget: string }
  const task: TaskSpec = { ...t, budget: BigInt(t.budget) }
  const scenario = KNOWN_SCENARIOS.find((s) => s.id === taskEntry.payload.scenarioId)
  const setup = scenario ? await scenario.build(ctx) : { priorSpend: [] }
  const startTs = Date.parse(taskEntry.ts)
  const history: SpendHistory = {
    payments: (setup.priorSpend ?? []).map((p, i) => ({
      ts: startTs - p.hoursAgo * 3600_000,
      amount: p.amount,
      taskId: "earlier-task",
      paymentRequestId: `prior-${i}`,
      merchantDid: config.merchants.find((m) => m.key === "lingua")!.did,
    })),
  }
  const firstDecisions = mine.filter((e) => e.kind === "decision" && !e.payload.afterApproval)
  const diffs: string[] = []
  for (const d of firstDecisions) {
    const f = d.payload.facts as PaymentFacts & { option?: { amount: string } }
    const facts: PaymentFacts = { ...f, option: f.option ? { ...f.option, amount: BigInt(f.option.amount) } : undefined }
    const recomputed = evaluatePayment(facts, task, config, history, Date.parse(d.ts))
    const recorded = (d.payload.decision as { outcome: string; rule: { id: string } })
    if (recomputed.outcome !== recorded.outcome || recomputed.rule.id !== recorded.rule.id)
      diffs.push(`${d.payload.attemptId}: recorded ${recorded.outcome}/${recorded.rule.id}, serialized ${recomputed.outcome}/${recomputed.rule.id}`)
    // Serialized semantics: only payments the serialized engine allows enter the history.
    if (recomputed.outcome === "allow" && facts.option && facts.requestSignature.ok) {
      history.payments.push({
        ts: Date.parse(d.ts),
        amount: facts.option.amount,
        taskId: task.id,
        url: facts.provenance.url,
        paymentRequestId: facts.requestSignature.requestId!,
        merchantDid: facts.requestSignature.issuer!,
      })
    }
  }
  if (diffs.length) {
    affected++
    console.log(`AFFECTED ${ep}`)
    for (const x of diffs) console.log(`  ${x}`)
  } else {
    console.log(`unaffected ${ep}: every decision is identical under serialized evaluation`)
  }
}
console.log(`\n${multiPayEpisodes.size} guarded episode(s) with parallel pay calls; ${affected} affected.`)
if (affected) process.exitCode = 2
