// Runs every scenario against the naive and the guarded agent, N runs each,
// with the same model, prompts and seed per run. Writes:
//   <outDir>/audit.jsonl (+ .head.json)  hash-chained signed log of everything
//   <outDir>/episodes.jsonl              one scored row per episode
//   <outDir>/summary.json                aggregate (regenerated after each episode)
//   <outDir>/meta.json                   model, versions, settings
// Resumable: episodes already in episodes.jsonl are skipped.

import { execSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AuditLog } from "../audit/chain.js"
import { writeGenesis } from "../audit/genesis.js"
import { MAX_STEPS, runEpisode } from "../agent/run-episode.js"
import type { ResolvedModel } from "../agent/model.js"
import { SYSTEM_PROMPT } from "../agent/prompts.js"
import type { Identities } from "../identity/identities.js"
import { buildPolicyConfig } from "../policy/config.js"
import type { Mode } from "../world.js"
import { scoreEpisode } from "./scoring.js"
import { readRows, summarize, type EpisodeRow } from "./summary.js"
import { makeBuildCtx, type Scenario } from "./types.js"

export interface SuiteOptions {
  ids: Identities
  scenarios: Scenario[]
  model: ResolvedModel
  runs: number
  outDir: string
  modes?: Mode[]
  onEpisode?: (row: EpisodeRow, done: number, total: number) => void
  meta?: Record<string, unknown>
}

export async function runSuite(opts: SuiteOptions) {
  const modes = opts.modes ?? ["naive", "guarded"]
  mkdirSync(opts.outDir, { recursive: true })
  const episodesPath = join(opts.outDir, "episodes.jsonl")
  const done = new Set(existsSync(episodesPath) ? readRows(episodesPath).map((r) => r.episodeId) : [])
  const audit = new AuditLog(join(opts.outDir, "audit.jsonl"), opts.ids.parties.guard)
  await writeGenesis(audit, opts.ids, buildPolicyConfig(opts.ids), { model: opts.model.id })
  writeFileSync(
    join(opts.outDir, "meta.json"),
    JSON.stringify(
      {
        model: opts.model.id,
        modelLabel: opts.model.label,
        provider: opts.model.provider,
        temperature: opts.model.temperature,
        maxSteps: MAX_STEPS,
        runs: opts.runs,
        modes,
        gitCommit: gitCommit(),
        guardDid: opts.ids.parties.guard.did,
        scenarios: opts.scenarios.map((s) => s.id),
        systemPrompt: SYSTEM_PROMPT,
        node: process.version,
        startedAt: new Date().toISOString(),
        ...opts.meta,
      },
      null,
      2,
    ),
  )

  const ctx = makeBuildCtx(opts.ids)
  const total = opts.runs * opts.scenarios.length * modes.length
  let count = done.size
  for (let run = 1; run <= opts.runs; run++) {
    for (const scenario of opts.scenarios) {
      for (const mode of modes) {
        const episodeKey = `${scenario.id}/${mode}/r${run}`
        if (done.has(episodeKey)) continue
        // If an earlier attempt at this episode crashed after writing to the
        // audit log, give the retry a distinct id so replay never mixes them.
        const tries = audit.entries.filter(
          (e) => e.kind === "task" && typeof e.payload.episodeId === "string" && (e.payload.episodeId === episodeKey || e.payload.episodeId.startsWith(`${episodeKey}.retry`)),
        ).length
        const episodeId = tries ? `${episodeKey}.retry${tries}` : episodeKey
        const setup = await scenario.build(ctx)
        const seed = run
        const r = await runEpisode({
          ids: opts.ids,
          setup,
          mode,
          audit,
          episodeId,
          model: opts.model,
          seed,
          meta: { scenarioId: scenario.id, category: scenario.category, run },
        })
        const score = scoreEpisode(scenario, setup, r, opts.ids)
        const row: EpisodeRow = {
          episodeId: episodeKey,
          logEpisodeId: episodeId,
          scenarioId: scenario.id,
          category: scenario.category,
          title: scenario.title,
          mode,
          run,
          seed,
          model: opts.model.id,
          probesGap: scenario.probesGap,
          score,
          steps: r.steps,
          error: r.error,
          durationMs: r.durationMs,
          finalText: r.finalText.slice(0, 500),
          attempts: r.payResults.map((p) => ({ attemptId: p.attemptId, status: p.result.status, rule: p.rule })),
        }
        appendFileSync(episodesPath, JSON.stringify(row) + "\n")
        writeFileSync(join(opts.outDir, "summary.json"), JSON.stringify(summarize(readRows(episodesPath)), null, 2))
        opts.onEpisode?.(row, ++count, total)
      }
    }
  }
  await audit.flush()
  const summary = summarize(readRows(episodesPath))
  writeFileSync(join(opts.outDir, "summary.json"), JSON.stringify(summary, null, 2))
  return summary
}

function gitCommit(): string | undefined {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    const dirty = execSync("git status --porcelain -- src", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
    return dirty ? `${sha}+uncommitted-src-changes` : sha
  } catch {
    return undefined
  }
}
