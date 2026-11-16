// pnpm demo: the one-command run.
//  1. Generates local keys on first run (.data/keys.json, gitignored).
//  2. Starts the dashboard on http://localhost:4300 (127.0.0.1 only).
//  3. Writes this session's events to a fresh signed log (.data/live/).
//     The dashboard's "Run the guided demo" button runs one legitimate payment,
//     one injected attack and one tampering attempt. `--auto` runs a short
//     sequence from the terminal instead (no browser needed).
// Uses local qwen3:8b through Ollama if it is installed; otherwise a
// deterministic scripted stand-in (clearly labelled, never reported as an LLM).

import { join } from "node:path"
import { AuditLog } from "../audit/chain.js"
import { writeGenesis } from "../audit/genesis.js"
import { ollamaAvailable, prepareModel, resolveModel, type ResolvedModel } from "../agent/model.js"
import { runEpisode } from "../agent/run-episode.js"
import { startDashboard, type PendingApproval } from "../dashboard/server.js"
import { buildPolicyConfig } from "../policy/config.js"
import { SpendStore } from "../policy/spend-store.js"
import { approvalDemo } from "../redteam/demo-scenarios.js"
import { ALL_SCENARIOS } from "../redteam/index.js"
import { makeBuildCtx } from "../redteam/types.js"
import { taskInstanceId, type Approver, type Mode } from "../world.js"
import { loadEnv, localIdentities } from "./env.js"
import { arg, c, flag } from "./util.js"

loadEnv()
const port = Number(arg("port", "4300"))
const ids = await localIdentities()
// Each demo session gets a fresh log, so the timeline shows only this session.
const sessionStamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)
const audit = await AuditLog.open(join(process.cwd(), ".data", "live", `audit-${sessionStamp}.jsonl`), ids.parties.guard)

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
// One spend history for the agent across every live episode and restart, so the
// rolling daily cap is real. Delete .data/spend-history.json to reset it.
const spend = new SpendStore(join(process.cwd(), ".data", "spend-history.json"))
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
// Spend history persists across restarts, so task instance ids must be unique
// across sessions too, not just within one.
const sessionId = `${Date.now().toString(36)}${crypto.randomUUID().slice(0, 6)}`
const ctx = makeBuildCtx(ids)
async function run(scenarioId: string, mode: Mode) {
  const scenario = scenarios.find((s) => s.id === scenarioId)
  if (!scenario) throw new Error(`unknown scenario ${scenarioId}`)
  const episodeId = `live-${Date.now().toString(36)}-${++episodeCounter}/${scenarioId}/${mode}`
  const built = await scenario.build(ctx)
  // Each live episode is its own task instance, so running the same scenario
  // twice is two tasks (not a duplicate charge within one task).
  const setup = { ...built, task: { ...built.task, id: taskInstanceId(built.task.id, sessionId, episodeCounter) } }
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
    // Scenarios that simulate earlier spend (SE-04) get their own history so
    // the simulated spend never lands in the agent's real one.
    spend: setup.priorSpend?.length ? undefined : spend,
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
  runScenario: (scenarioId, mode) => run(scenarioId, mode),
})

console.log(c.bold("\nACK Guard demo"))
console.log(`  dashboard   ${c.cyan(url)}`)
console.log(`  agent model ${model.label}`)
console.log(`  audit log   ${audit.path.replace(process.cwd() + "/", "")} (hash-chained, signed by ${ids.parties.guard.did.slice(0, 32)}...)`)
console.log(c.dim("  sandbox only: fictional merchants on .test hosts, an in-memory ledger, no real money\n"))

console.log(`Open ${c.cyan(url)} and click "Run the guided demo": one legitimate payment, one injected attack, one tampering attempt.`)
if (flag("auto")) {
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
