// pnpm redteam [--model qwen3:8b|claude-...|scripted] [--runs 3] [--only FI,RS-01,benign] [--out dir] [--resume dir]
//              [--patch-of results/<model>/<base run> --reason "why"]
import { join } from "node:path"
import { ollamaAvailable, prepareModel, resolveModel } from "../agent/model.js"
import { SUITES, selectScenarios, type Suite } from "../redteam/index.js"
import { runSuite } from "../redteam/runner.js"
import { loadEnv, localIdentities, modelSlug } from "./env.js"
import { arg, c } from "./util.js"

loadEnv()
const modelId = arg("model", "qwen3:8b")!
const runs = Number(arg("runs", "3"))
// --suite delegation runs the sub-agent suite and --suite wrong-city the wrong-item
// suite; each is recorded and reported separately from the main benchmark.
const suite = arg("suite", "main") as Suite
if (!SUITES.includes(suite)) {
  console.error(c.red(`--suite must be one of ${SUITES.join(", ")}`))
  process.exit(1)
}
const scenarios = selectScenarios(arg("only"), suite)
if (resolveModel(modelId).provider === "ollama" && !(await ollamaAvailable(modelId))) {
  console.error(c.red(`Ollama model ${modelId} is not available. Install Ollama and run: ollama pull ${modelId}`))
  process.exit(1)
}
const thinking = arg("thinking") as "off" | "adaptive" | undefined
if (thinking && thinking !== "off" && thinking !== "adaptive") {
  console.error(c.red("--thinking must be off or adaptive"))
  process.exit(1)
}
const model = await prepareModel(modelId, { thinking })
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13)
const outDir = arg("resume") ?? arg("out") ?? join("results", modelSlug(modelId), stamp)
const ids = await localIdentities()

console.log(c.bold(`ACK Guard red-team: ${scenarios.length} scenarios x 2 agents x ${runs} runs on ${model.label}`))
console.log(c.dim(`output: ${outDir}`))
const t0 = Date.now()
let firstDone: number | undefined
// --patch-of <base run dir> --reason "...": a partial rerun that replaces some
// scenarios of a recorded base run (pnpm report combines the two, verifying both).
const patchOf = arg("patch-of")
if (patchOf && !arg("reason")) {
  console.error(c.red("--patch-of needs --reason, saying why these scenarios were re-run"))
  process.exit(1)
}
const summary = await runSuite({
  ids,
  scenarios,
  model,
  runs,
  outDir,
  meta: { ...(patchOf ? { patchOf, patchReason: arg("reason") } : {}), ...(suite !== "main" ? { suite } : {}) },
  onEpisode: (row, done, total) => {
    firstDone ??= done - 1
    const s = row.score
    const verdict =
      row.category === "benign"
        ? s.completed
          ? c.green("completed")
          : c.yellow("not completed")
        : s.attackSucceeded
          ? c.red("ATTACK SUCCEEDED")
          : c.green("attack failed")
    const rules = s.blocked.map((b) => b.rule).join(",")
    const per = (Date.now() - t0) / Math.max(1, done - firstDone)
    const eta = (per * (total - done)) / 60000
    console.log(
      `${String(done).padStart(4)}/${total} ${row.episodeId.padEnd(22)} ${verdict} spent $${(s.spentCents / 100).toFixed(2)}` +
        `${rules ? c.dim(` blocked:${rules}`) : ""}${row.error ? c.red(` error:${row.error.slice(0, 80)}`) : ""}` +
        c.dim(` ${(row.durationMs / 1000).toFixed(1)}s, eta ${eta.toFixed(0)}m`),
    )
  },
})
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
console.log(c.bold("\nAttack success rate"))
console.log(`  naive:   ${summary.attacks.naive.successes}/${summary.attacks.naive.n} (${pct(summary.attacks.naive.rate)})`)
console.log(`  guarded: ${summary.attacks.guarded.successes}/${summary.attacks.guarded.n} (${pct(summary.attacks.guarded.rate)})`)
console.log(c.bold("Benign task completion"))
console.log(`  naive:   ${summary.benign.naive.completed}/${summary.benign.naive.n}   guarded: ${summary.benign.guarded.completed}/${summary.benign.guarded.n}`)
console.log(c.dim(`\nWrote ${outDir}/summary.json. Regenerate the README table with: pnpm report`))
