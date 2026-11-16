// Combines a recorded base run with partial re-runs ("patches") recorded on
// top of it: every scenario a patch re-ran takes the patch's rows, all others
// keep the base run's rows. Each run keeps its own signed log and is verified
// on its own; nothing is copied between runs.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, normalize } from "node:path"
import { readRows, type EpisodeRow } from "./summary.js"

export type Meta = Record<string, any>
export const readMeta = (r: string): Meta => (existsSync(join(r, "meta.json")) ? JSON.parse(readFileSync(join(r, "meta.json"), "utf8")) : {})

/** Recorded run directories of one model directory, oldest first. */
function runDirs(mdir: string): string[] {
  return readdirSync(mdir)
    .map((r) => join(mdir, r))
    .filter((r) => existsSync(join(r, "episodes.jsonl")) && !readMeta(r).superseded)
    .sort((a, b) => String(readMeta(a).startedAt ?? "").localeCompare(String(readMeta(b).startedAt ?? "")))
}

/** Latest full (non-patch) run per model directory. */
export function defaultRuns(base = "results"): string[] {
  if (!existsSync(base)) return []
  const runs: string[] = []
  for (const model of readdirSync(base)) {
    const mdir = join(base, model)
    if (!statSync(mdir).isDirectory()) continue
    const full = runDirs(mdir).filter((r) => !readMeta(r).patchOf && !readMeta(r).suite)
    if (full.length) runs.push(full[full.length - 1]!)
  }
  return runs
}

/** Latest run of a separate suite (e.g. "delegation") per model directory. */
export function suiteRuns(suite: string, base = "results"): string[] {
  if (!existsSync(base)) return []
  const runs: string[] = []
  for (const model of readdirSync(base)) {
    const mdir = join(base, model)
    if (!statSync(mdir).isDirectory()) continue
    const rs = runDirs(mdir).filter((r) => readMeta(r).suite === suite && !readMeta(r).patchOf)
    if (rs.length) runs.push(rs[rs.length - 1]!)
  }
  return runs
}

/** Partial re-runs recorded on top of a base run, oldest first. */
export function patchesOf(baseRun: string): string[] {
  const mdir = join(baseRun, "..")
  return runDirs(mdir).filter((r) => readMeta(r).patchOf && normalize(readMeta(r).patchOf) === normalize(baseRun))
}

/** Base rows, with every scenario a patch re-ran replaced by the patch's rows. */
export function combinedRows(baseRun: string, patches: string[]): EpisodeRow[] {
  let rows = readRows(join(baseRun, "episodes.jsonl"))
  for (const p of patches) {
    const ids = new Set<string>(readMeta(p).scenarios ?? [])
    rows = [...rows.filter((r) => !ids.has(r.scenarioId)), ...readRows(join(p, "episodes.jsonl"))]
  }
  return rows
}

