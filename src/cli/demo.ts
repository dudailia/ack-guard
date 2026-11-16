// pnpm demo: the one-command run.
//  1. Generates local keys on first run (.data/keys.json, gitignored).
//  2. Starts the dashboard on http://localhost:4300 (127.0.0.1 only).
//  3. Runs a few live episodes into a signed audit log (.data/audit.jsonl):
//     a benign payment, a fake-invoice attack against both agents, and a
//     legit payment that needs a human (approve or decline it in the dashboard).
// Uses local qwen3:8b through Ollama if it is installed; otherwise a
// deterministic scripted stand-in (clearly labelled, never reported as an LLM).

import { join } from "node:path"
import { AuditLog } from "../audit/chain.js"
import { writeGenesis } from "../audit/genesis.js"
import { ollamaAvailable, prepareModel, resolveModel, type ResolvedModel } from "../agent/model.js"
import { runEpisode } from "../agent/run-episode.js"
import { startDashboard, type PendingApproval } from "../dashboard/server.js"
import { buildPolicyConfig } from "../policy/config.js"
import { approvalDemo } from "../redteam/demo-scenarios.js"
import { ALL_SCENARIOS } from "../redteam/index.js"
import { makeBuildCtx } from "../redteam/types.js"
import type { Approver, Mode } from "../world.js"
import { loadEnv, localIdentities } from "./env.js"
import { arg, c, flag } from "./util.js"

loadEnv()
const port = Number(arg("port", "4300"))
const ids = await localIdentities()
const audit = new AuditLog(join(process.cwd(), ".data", "audit.jsonl"), ids.parties.guard)

let model: ResolvedModel
const requested = arg("model")
if (requested) model = await prepareModel(requested)
else if (await ollamaAvailable("qwen3:8b")) model = await prepareModel("qwen3:8b")
else {
  model = resolveModel("scripted")
  console.log(c.yellow("Ollama with qwen3:8b was not found, so the live demo uses the deterministic scripted agent (not an LLM)."))
  console.log(c.yellow("For a real model: install Ollama, run `ollama pull qwen3:8b`, then `pnpm demo` again.\n"))
}
await writeGenesis(audit, ids, buildPolicyConfig(ids), { model: model.id, purpose: "live demo log" })

const scenarios = [...ALL_SCENARIOS, approvalDemo]
const approvals = new Map<string, PendingApproval>()
let approvalCounter = 0
const dashboardApprover =
  (episodeId: string): Approver =>
  ({ decision, task }) =>
    new Promise((resolve) => {
      const id = `ap_${++approvalCounter}_${crypto.randomUUID()}`
      const timer = setTimeout(() => {
        if (approvals.delete(id)) resolve({ approved: false, by: "timeout (no human answered in 10 minutes)" })
      }, 10 * 60 * 1000)
      approvals.set(id, {
        id,
        episodeId,
        createdAt: new Date().toISOString(),
        decision,
        task: { id: task.id, prompt: task.prompt },
        resolve: (r) => {
          clearTimeout(timer)
          resolve(r)
        },
      })
      console.log(c.yellow(`  ${episodeId}: waiting for a human. Approve or decline it at http://localhost:${port}`))
    })

let episodeCounter = 0
const ctx = makeBuildCtx(ids)
async function run(scenarioId: string, mode: Mode) {
  const scenario = scenarios.find((s) => s.id === scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  const episodeId = `live-${Date.now().toString(36)}-${++episodeCounter}/${scenarioId}/${mode}`
  const setup = await scenario.build(ctx)
  const done = runEpisode({
    ids,
    setup,
    mode,
    audit,
    episodeId,
    model,
    seed: episodeCounter,
    meta: { scenarioId, category: scenario.category, live: true },
    approver: dashboardApprover(episodeId),
  }).then((r) => {
    const paid = r.payResults.filter((p) => p.result.status === "paid").length
    const stopped = r.payResults.filter((p) => p.result.status !== "paid").map((p) => p.rule ?? p.result.status)
    console.log(`  ${c.bold(episodeId)}: ${paid} paid${stopped.length ? `, stopped by ${stopped.join(", ")}` : ""}${r.error ? c.red(` (error: ${r.error})`) : ""}`)
    return r
  })
  return { episodeId, done }
}

const { url } = startDashboard({
  port,
  liveLog: audit,
  scenarios,
  approvals,
  liveInfo: () => ({ model: model.label }),
  operatorGuardDid: ids.parties.guard.did,
  runScenario: async (scenarioId, mode) => {
    const { episodeId } = await run(scenarioId, mode)
    return { episodeId }
  },
})

console.log(c.bold("\nACK Guard demo"))
console.log(`  dashboard   ${c.cyan(url)}`)
console.log(`  agent model ${model.label}`)
console.log(`  audit log   .data/audit.jsonl (hash-chained, signed by ${ids.parties.guard.did.slice(0, 32)}...)`)
console.log(c.dim("  sandbox only: fictional merchants on .test hosts, an in-memory ledger, no real money\n"))

if (!flag("no-auto")) {
  console.log(c.bold("Running live episodes:"))
  for (const [id, mode] of [
    ["B-01", "guarded"],
    ["FI-01", "naive"],
    ["FI-01", "guarded"],
  ] as const) {
    const { done } = await run(id, mode)
    await done
  }
  void run("DEMO-APPROVAL", "guarded")
}
console.log(c.dim(`\nReplay any attempt:  pnpm replay            (lists attempts in the newest log)`))
console.log(c.dim(`Verify the log:      pnpm verify-log`))
console.log(c.dim(`Press Ctrl+C to stop.`))
