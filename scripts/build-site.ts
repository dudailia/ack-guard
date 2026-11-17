// pnpm build:site
// Builds the static guided demo in site/ for GitHub Pages. Everything runs here,
// at build time, with the deterministic scripted agent (not an LLM): no API
// calls and no keys from .data. It writes site/data/demo.json (a real signed
// audit log of one legitimate purchase and one injected invoice, plus their
// replays) and copies the dashboard stylesheet. The page itself re-checks the
// log's hash chain and Ed25519 signatures in the browser.

import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveModel } from "../src/agent/model.js"
import { runEpisode } from "../src/agent/run-episode.js"
import { AuditLog, headPath } from "../src/audit/chain.js"
import { writeGenesis } from "../src/audit/genesis.js"
import { listAttempts, replayAttempt } from "../src/audit/replay.js"
import { verifyLog } from "../src/audit/verify.js"
import { buildIdentities } from "../src/identity/identities.js"
import { buildPolicyConfig } from "../src/policy/config.js"
import { RULE_TITLES } from "../src/policy/engine.js"
import { SpendStore } from "../src/policy/spend-store.js"
import { suiteHistory, suiteRuns } from "../src/redteam/combine.js"
import { ALL_SCENARIOS } from "../src/redteam/index.js"
import { CATEGORY_LABELS, makeBuildCtx } from "../src/redteam/types.js"

const out = process.argv[2] ?? "site"
const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v)

// Throwaway identities: the published page never carries this machine's keys.
const ids = await buildIdentities()
const dir = mkdtempSync(join(tmpdir(), "ack-guard-site-"))
const logPath = join(dir, "audit.jsonl")
const audit = await AuditLog.open(logPath, ids.parties.guard)
await writeGenesis(audit, ids, buildPolicyConfig(ids), { model: "scripted", purpose: "static guided demo" })

const ctx = makeBuildCtx(ids)
const spend = new SpendStore()
const model = resolveModel("scripted")
const steps = [
  { key: "legit", scenarioId: "B-01", episodeId: "demo/legit-purchase" },
  { key: "attack", scenarioId: "FI-01", episodeId: "demo/injected-invoice" },
] as const
for (const s of steps) {
  const scenario = ALL_SCENARIOS.find((x) => x.id === s.scenarioId)!
  const built = await scenario.build(ctx)
  await runEpisode({
    ids,
    setup: { ...built, task: { ...built.task, id: `${built.task.id}#static` } },
    mode: "guarded",
    audit,
    episodeId: s.episodeId,
    model,
    seed: 1,
    meta: { scenarioId: scenario.id, category: scenario.category, static: true },
    spend,
  })
}

const guardDid = ids.parties.guard.did
const verification = await verifyLog(logPath, { expectedSignerDid: guardDid })
if (!verification.ok) throw new Error(`the demo log does not verify: ${JSON.stringify(verification.problems[0])}`)
const attempts = listAttempts(logPath)
const legit = attempts.find((a) => a.episodeId === steps[0].episodeId && a.outcome === "paid")
const attack = attempts.find((a) => a.episodeId === steps[1].episodeId && a.outcome === "deny")
if (!legit || !attack) throw new Error("the scripted demo did not produce one paid and one denied attempt")
const replays = {
  legit: await replayAttempt(logPath, legit.attemptId, { expectedSignerDid: guardDid }),
  attack: await replayAttempt(logPath, attack.attemptId, { expectedSignerDid: guardDid }),
}
if (!replays.legit.trusted || !replays.attack.trusted) throw new Error("replays are not trusted")

// Recorded benchmark results, as combined and verified by pnpm report.
const results: unknown[] = []
if (existsSync("results")) {
  for (const m of readdirSync("results")) {
    const cur = join("results", m, "current")
    if (!statSync(join("results", m)).isDirectory() || !existsSync(join(cur, "summary.json"))) continue
    const ver = JSON.parse(readFileSync(join(cur, "verification.json"), "utf8"))
    if (!ver.ok) continue
    results.push({ model: m, suite: "main", summary: JSON.parse(readFileSync(join(cur, "summary.json"), "utf8")), meta: JSON.parse(readFileSync(join(cur, "meta.json"), "utf8")) })
  }
  // Separate suites (delegation), each verified against its signed log by pnpm report.
  for (const run of suiteRuns("delegation")) {
    const ver = JSON.parse(readFileSync(join(run, "verification.json"), "utf8"))
    if (!ver.ok) continue
    const meta = JSON.parse(readFileSync(join(run, "meta.json"), "utf8"))
    results.push({ model: meta.model, suite: "delegation", summary: JSON.parse(readFileSync(join(run, "summary.json"), "utf8")), meta })
  }
  // Wrong-city suite: the run before ITEM_BINDING existed, then the latest one.
  for (const latest of suiteRuns("wrong-city")) {
    for (const run of suiteHistory("wrong-city", join(latest, ".."))) {
      const ver = JSON.parse(readFileSync(join(run, "verification.json"), "utf8"))
      if (!ver.ok) continue
      const meta = JSON.parse(readFileSync(join(run, "meta.json"), "utf8"))
      const after = readFileSync(join(run, "audit.jsonl"), "utf8").includes('"id":"ITEM_BINDING"')
      results.push({ model: meta.model, suite: after ? "wrong-city" : "wrong-city-before", summary: JSON.parse(readFileSync(join(run, "summary.json"), "utf8")), meta })
    }
  }
}

let commit = "unknown"
try {
  commit = execFileSync("git", ["rev-parse", "--short", "HEAD"]).toString().trim()
} catch {
  // not a git checkout
}

const entries = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
const head = JSON.parse(readFileSync(headPath(logPath), "utf8"))
mkdirSync(join(out, "data"), { recursive: true })
writeFileSync(
  join(out, "data", "demo.json"),
  JSON.stringify(
    {
      builtAt: new Date().toISOString(),
      gitCommit: commit,
      agentModel: model.label,
      guardDid,
      log: entries,
      head,
      steps: { legit: { attemptId: legit.attemptId, replay: replays.legit }, attack: { attemptId: attack.attemptId, replay: replays.attack } },
      ruleTitles: RULE_TITLES,
      categoryLabels: CATEGORY_LABELS,
      results,
    },
    bigintSafe,
    1,
  ),
)
copyFileSync("src/dashboard/public/styles.css", join(out, "styles.css"))
console.log(`Wrote ${out}/data/demo.json (${entries.length} signed log entries, guard ${guardDid}) and ${out}/styles.css`)
