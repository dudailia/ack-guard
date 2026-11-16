// Verifies a recorded benchmark run end to end, so the reported numbers are
// backed by the signed audit log rather than by the unsigned summary files:
//   1. the audit log verifies (chain, signatures pinned to the guard DID, head)
//   2. the log belongs to this run (genesis runId and final head hash match meta.json)
//   3. every scored row has its episode in the log, and the log has no extra episodes
//   4. every row's score is re-derived from the log's signed entries and matches
//
// The guard DID defaults to the one in meta.json. That only proves internal
// consistency; pass an independently published DID and head hash for more.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AuditEntry } from "../audit/chain.js"
import { readEntries, verifyLog } from "../audit/verify.js"
import type { EpisodeResult } from "../agent/run-episode.js"
import { buildIdentities, type Identities } from "../identity/identities.js"
import type { Transfer } from "../ledger/sandbox-ledger.js"
import type { PayResult } from "../world.js"
import { KNOWN_SCENARIOS } from "./index.js"
import { scoreEpisode, type EpisodeScore } from "./scoring.js"
import { readRows, type EpisodeRow } from "./summary.js"
import { makeBuildCtx } from "./types.js"

export interface RunVerification {
  ok: boolean
  runDir: string
  episodesChecked: number
  logOk: boolean
  pinnedTo?: string
  headHash?: string
  problems: string[]
}

/** Identities with the run's public DIDs, enough to score (only DIDs are compared). */
function identitiesFromGenesis(g: Record<string, unknown>, ids: Identities): Identities {
  const merchants = (g.policy as { merchants: { key: string; did: string }[] }).merchants
  const parties = { ...ids.parties }
  const did = (k: string) => merchants.find((m) => m.key === k)?.did
  for (const k of ["skycast", "lingua", "geopoint"] as const) parties[k] = { ...parties[k], did: did(k) as `did:${string}:${string}` }
  parties.agent = { ...parties.agent, did: g.agentDid as `did:${string}:${string}` }
  return { ...ids, parties }
}

export async function verifyRun(runDir: string, opts: { signer?: string; expectedHeadHash?: string } = {}): Promise<RunVerification> {
  const problems: string[] = []
  const metaPath = join(runDir, "meta.json")
  const logPath = join(runDir, "audit.jsonl")
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>) : {}
  if (!existsSync(logPath)) return { ok: false, runDir, episodesChecked: 0, logOk: false, problems: ["audit.jsonl is missing"] }

  const signer = opts.signer ?? (meta.guardDid as string | undefined)
  const v = await verifyLog(logPath, { expectedSignerDid: signer, expectedHeadHash: opts.expectedHeadHash ?? (meta.headHash as string | undefined) })
  if (!v.ok) problems.push(`audit log fails verification at position ${v.firstBadSeq}: ${v.problems[0]?.kind} ${v.problems[0]?.detail}`)

  const entries = readEntries(logPath).entries.filter((e): e is AuditEntry => !!e)
  const genesis = entries[0]
  if (!genesis || genesis.kind !== "genesis") problems.push("log has no genesis entry")
  if (meta.runId && genesis?.payload.runId !== meta.runId) problems.push(`log runId ${String(genesis?.payload.runId)} does not match meta.json runId ${String(meta.runId)}`)

  const rows = readRows(join(runDir, "episodes.jsonl"))
  const byEpisode = new Map<string, AuditEntry[]>()
  for (const e of entries) {
    const id = e.payload.episodeId as string | undefined
    if (!id) continue
    if (!byEpisode.has(id)) byEpisode.set(id, [])
    byEpisode.get(id)!.push(e)
  }
  const logEpisodes = new Set([...byEpisode.entries()].filter(([, es]) => es.some((e) => e.kind === "episode_end")).map(([id]) => id))
  const rowEpisodes = new Set(rows.map((r) => r.logEpisodeId ?? r.episodeId))
  for (const id of logEpisodes) if (!rowEpisodes.has(id)) problems.push(`log has episode ${id} with no scored row`)

  const ids = genesis ? identitiesFromGenesis(genesis.payload, await buildIdentities()) : undefined
  const ctx = ids ? makeBuildCtx(ids) : undefined
  let checked = 0
  const seenLogEpisodes = new Set<string>()
  for (const row of rows) {
    const id = row.logEpisodeId ?? row.episodeId
    // One row per log episode: a row cannot borrow another row's episode.
    if (seenLogEpisodes.has(id)) problems.push(`row ${row.episodeId}: log episode ${id} is claimed by more than one row`)
    seenLogEpisodes.add(id)
    const es = byEpisode.get(id)
    const end = es?.find((e) => e.kind === "episode_end")
    const taskEntry = es?.find((e) => e.kind === "task")
    if (!es || !end || !taskEntry) {
      problems.push(`row ${row.episodeId} has no complete episode in the signed log`)
      continue
    }
    // The row's identity (which scenario, which agent, which run) must be the signed one.
    const tp = taskEntry.payload
    const signedId: Record<string, unknown> = { scenarioId: tp.scenarioId, mode: tp.mode, run: tp.run, seed: tp.seed, model: tp.model, category: tp.category }
    for (const [k, v] of Object.entries(signedId)) {
      const rv = (row as unknown as Record<string, unknown>)[k]
      if (JSON.stringify(rv) !== JSON.stringify(v)) problems.push(`row ${row.episodeId}: ${k} is ${JSON.stringify(rv)} in episodes.jsonl but ${JSON.stringify(v)} in the signed log`)
    }
    if (!!row.error !== !!end.payload.error) problems.push(`row ${row.episodeId}: error status differs from the signed log`)
    const scenario = KNOWN_SCENARIOS.find((s) => s.id === tp.scenarioId)
    if (!scenario || !ids || !ctx) {
      problems.push(`unknown scenario ${String(tp.scenarioId)}`)
      continue
    }
    const built = await scenario.build(ctx)
    const t = taskEntry.payload.task as { id: string; prompt: string; needs: string[]; budget: string }
    const setup = { ...built, task: { ...t, budget: BigInt(t.budget) } }
    const transfers = ((end.payload.transfers as (Omit<Transfer, "amount"> & { amount: string })[]) ?? []).map((x) => ({ ...x, amount: BigInt(x.amount) }))
    const attempts = [...new Set(es.filter((e) => e.kind === "payment_attempt").map((e) => e.payload.attemptId as string))]
    const payResults = attempts.map((attemptId) => {
      const mine = es.filter((e) => e.payload.attemptId === attemptId)
      const decisions = mine.filter((e) => e.kind === "decision")
      const last = decisions[decisions.length - 1]?.payload.decision as { outcome: string; rule: { id: string; detail: string } } | undefined
      const approval = mine.find((e) => e.kind === "approval")
      let result: PayResult
      if (mine.some((e) => e.kind === "settlement")) result = { status: "paid", txId: "", amount: "", recipient: "", message: "" }
      else if (mine.some((e) => e.kind === "payment_error")) result = { status: "error", message: "" }
      else if (last?.outcome === "needs_approval" || (approval && approval.payload.approved === false))
        result = { status: "escalated_denied", rule: last?.rule.id ?? "HUMAN_APPROVAL", reason: "", message: "" }
      else result = { status: "blocked", rule: last?.rule.id ?? "?", reason: "", message: "" }
      return { attemptId, result, rule: last?.rule.id }
    })
    const r: EpisodeResult = {
      episodeId: id,
      mode: tp.mode as EpisodeResult["mode"],
      finalText: "",
      steps: 0,
      transfers,
      payResults,
      served: (end.payload.served as EpisodeResult["served"]) ?? {},
      durationMs: 0,
    }
    if (!end.payload.served) {
      problems.push(`row ${row.episodeId}: the log predates served-data logging, so task completion cannot be re-derived`)
    }
    const derived = scoreEpisode(scenario, setup, r, ids)
    const keys: (keyof EpisodeScore)[] = ["attackSucceeded", "spentCents", "attackerReceivedCents", "excessCents", "paidCount", "escalations"]
    if (end.payload.served) keys.push("completed")
    for (const k of keys) {
      if (JSON.stringify(derived[k]) !== JSON.stringify(row.score[k])) {
        problems.push(`row ${row.episodeId}: ${k} is ${JSON.stringify(row.score[k])} in episodes.jsonl but ${JSON.stringify(derived[k])} from the signed log`)
      }
    }
    const rulesRow = row.score.blocked.map((b) => b.rule).join(",")
    const rulesLog = derived.blocked.map((b) => b.rule).join(",")
    if (rulesRow !== rulesLog) problems.push(`row ${row.episodeId}: blocked rules differ (${rulesRow} vs ${rulesLog} from the log)`)
    checked++
  }
  return { ok: problems.length === 0, runDir, episodesChecked: checked, logOk: v.ok, pinnedTo: signer, headHash: v.headHash, problems }
}

export type { EpisodeRow }
