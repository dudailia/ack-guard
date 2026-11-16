// Aggregates episodes.jsonl into summary.json. Pure, so the README table and
// the dashboard are always generated from the same recorded data.

import { readFileSync } from "node:fs"
import { CATEGORIES, CATEGORY_LABELS, type Category } from "./types.js"
import type { EpisodeScore } from "./scoring.js"

export interface EpisodeRow {
  episodeId: string
  scenarioId: string
  category: Category | "benign"
  title: string
  mode: "naive" | "guarded"
  run: number
  seed: number
  model: string
  probesGap?: string
  score: EpisodeScore
  steps: number
  error?: string
  durationMs: number
  finalText: string
  attempts: { attemptId: string; status: string; rule?: string }[]
}

export interface Cell {
  n: number
  successes: number
  rate: number
  ci95: [number, number]
  escalations: number
  completed: number
  spentCents: number
  attackerReceivedCents: number
  errors: number
}

export interface Summary {
  model: string
  runsPerScenario: number
  episodes: number
  generatedAt: string
  attacks: { naive: Cell; guarded: Cell }
  byCategory: Record<string, { label: string; naive: Cell; guarded: Cell }>
  benign: { naive: Cell; guarded: Cell; guardBlocksOnBenign: number }
  scenarios: {
    id: string
    category: string
    title: string
    probesGap?: string
    naive: { successes: number; n: number; completed: number }
    guarded: { successes: number; n: number; completed: number; rules: Record<string, number> }
  }[]
  rulesFired: Record<string, number>
}

/** Wilson score interval, 95%. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0]
  const z = 1.96
  const p = k / n
  const d = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d
  return [Math.max(0, center - half), Math.min(1, center + half)]
}

function cell(rows: EpisodeRow[], benign = false): Cell {
  const n = rows.length
  const successes = benign ? rows.filter((r) => r.score.completed).length : rows.filter((r) => r.score.attackSucceeded).length
  return {
    n,
    successes,
    rate: n ? successes / n : 0,
    ci95: wilson(successes, n),
    escalations: rows.reduce((a, r) => a + r.score.escalations, 0),
    completed: rows.filter((r) => r.score.completed).length,
    spentCents: rows.reduce((a, r) => a + r.score.spentCents, 0),
    attackerReceivedCents: rows.reduce((a, r) => a + r.score.attackerReceivedCents, 0),
    errors: rows.filter((r) => r.error).length,
  }
}

export function readRows(path: string): EpisodeRow[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as EpisodeRow)
}

export function summarize(rows: EpisodeRow[]): Summary {
  const attacks = rows.filter((r) => r.category !== "benign")
  const ben = rows.filter((r) => r.category === "benign")
  const by = (rs: EpisodeRow[], mode: string) => rs.filter((r) => r.mode === mode)
  const byCategory: Summary["byCategory"] = {}
  for (const c of CATEGORIES) {
    const rs = attacks.filter((r) => r.category === c)
    byCategory[c] = { label: CATEGORY_LABELS[c], naive: cell(by(rs, "naive")), guarded: cell(by(rs, "guarded")) }
  }
  const rulesFired: Record<string, number> = {}
  for (const r of by(rows, "guarded")) for (const b of r.score.blocked) rulesFired[b.rule] = (rulesFired[b.rule] ?? 0) + 1

  const ids = [...new Set(rows.map((r) => r.scenarioId))]
  const scenarios = ids.map((id) => {
    const rs = rows.filter((r) => r.scenarioId === id)
    const first = rs[0]!
    const g = by(rs, "guarded")
    const rules: Record<string, number> = {}
    for (const r of g) for (const b of r.score.blocked) rules[b.rule] = (rules[b.rule] ?? 0) + 1
    const success = (x: EpisodeRow) => (x.category === "benign" ? false : !!x.score.attackSucceeded)
    return {
      id,
      category: first.category,
      title: first.title,
      probesGap: first.probesGap,
      naive: { successes: by(rs, "naive").filter(success).length, n: by(rs, "naive").length, completed: by(rs, "naive").filter((x) => x.score.completed).length },
      guarded: { successes: g.filter(success).length, n: g.length, completed: g.filter((x) => x.score.completed).length, rules },
    }
  })

  return {
    model: rows[0]?.model ?? "unknown",
    runsPerScenario: Math.max(0, ...rows.map((r) => r.run)),
    episodes: rows.length,
    generatedAt: new Date().toISOString(),
    attacks: { naive: cell(by(attacks, "naive")), guarded: cell(by(attacks, "guarded")) },
    byCategory,
    benign: {
      naive: cell(by(ben, "naive"), true),
      guarded: cell(by(ben, "guarded"), true),
      guardBlocksOnBenign: by(ben, "guarded").reduce((a, r) => a + r.score.blocked.length, 0),
    },
    scenarios,
    rulesFired,
  }
}
