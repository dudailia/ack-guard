// Local dashboard: scoreboard (from recorded runs), payment timeline (live via
// SSE from the demo log, or any recorded run), replay view, tamper demo, and a
// human-approval queue for live guarded runs. Binds to 127.0.0.1 only.

import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { headPath, type AuditLog } from "../audit/chain.js"
import { listAttempts, replayAttempt } from "../audit/replay.js"
import { trustedSignerFor } from "../audit/trust.js"
import { verifyLog } from "../audit/verify.js"
import { findLogs } from "../cli/util.js"
import type { EpisodeResult } from "../agent/run-episode.js"
import { RULE_TITLES } from "../policy/engine.js"
import type { Decision } from "../policy/types.js"
import { approvalDemo } from "../redteam/demo-scenarios.js"
import { ALL_SCENARIOS } from "../redteam/index.js"
import { CATEGORY_LABELS } from "../redteam/types.js"
import type { Scenario } from "../redteam/types.js"

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public")

export interface PendingApproval {
  id: string
  episodeId: string
  createdAt: string
  decision: Decision
  task: { id: string; prompt: string }
  resolve: (r: { approved: boolean; by: string }) => void
}

export interface DashboardOptions {
  port?: number
  liveLog?: AuditLog
  scenarios?: Scenario[]
  runScenario?: (scenarioId: string, mode: "naive" | "guarded") => Promise<{ episodeId: string; done: Promise<EpisodeResult> }>
  approvals?: Map<string, PendingApproval>
  liveInfo?: () => Record<string, unknown>
  root?: string
  /** This machine's guard DID. Logs it signed are verified as pinned; other logs as "not pinned". */
  operatorGuardDid?: string
}

export function createDashboard(opts: DashboardOptions) {
  const root = opts.root ?? process.cwd()
  const port = opts.port ?? 4300
  const app = new Hono()

  // Local-only API. Reject other Host headers (DNS rebinding) and cross-site
  // writes: state-changing requests need a same-origin Origin header and JSON.
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`])
  const origins = new Set([...hosts].map((h) => `http://${h}`))
  app.use("/api/*", async (c, next) => {
    // @hono/node-server builds c.req.url from the Host header.
    if (!hosts.has(c.req.header("host") ?? new URL(c.req.url).host)) return c.json({ error: "forbidden host" }, 403)
    if (c.req.method !== "GET") {
      if (!origins.has(c.req.header("origin") ?? "")) return c.json({ error: "cross-origin request refused" }, 403)
      if (!(c.req.header("content-type") ?? "").startsWith("application/json")) return c.json({ error: "JSON body required" }, 415)
    }
    await next()
  })
  const signerFor = (log: string) => trustedSignerFor(log, { operatorGuardDid: opts.operatorGuardDid })

  /** Only logs the tool itself produced (under .data/ or results/) can be read. */
  const allowedLog = (requested?: string): string | undefined => {
    const logs = findLogs(root).map((p) => resolve(p))
    if (!requested) return opts.liveLog ? resolve(opts.liveLog.path) : logs[0]
    const abs = resolve(root, requested)
    return logs.includes(abs) ? abs : undefined
  }
  const rel = (p: string) => relative(root, p)

  for (const f of ["app.js", "styles.css"]) {
    app.get(`/${f}`, (c) =>
      c.body(readFileSync(join(PUBLIC, f), "utf8"), 200, {
        "content-type": f.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8",
      }),
    )
  }
  app.get("/", (c) => c.html(readFileSync(join(PUBLIC, "index.html"), "utf8")))

  app.get("/api/runs", (c) => {
    const runs: { path: string; model: string; summary: unknown; meta: unknown }[] = []
    const base = join(root, "results")
    if (existsSync(base)) {
      for (const model of readdirSync(base)) {
        const mdir = join(base, model)
        if (!statSync(mdir).isDirectory()) continue
        for (const run of readdirSync(mdir)) {
          if (!statSync(join(mdir, run)).isDirectory()) continue
          const s = join(mdir, run, "summary.json")
          if (!existsSync(s)) continue
          const metaPath = join(mdir, run, "meta.json")
          runs.push({
            path: rel(join(mdir, run)),
            model,
            summary: JSON.parse(readFileSync(s, "utf8")),
            meta: existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : null,
          })
        }
      }
    }
    return c.json({ runs, categoryLabels: CATEGORY_LABELS })
  })

  app.get("/api/catalog", (c) =>
    c.json({
      categories: CATEGORY_LABELS,
      rules: RULE_TITLES,
      scenarios: Object.fromEntries([...ALL_SCENARIOS, approvalDemo].map((s) => [s.id, { title: s.title, category: s.category, description: s.description }])),
    }),
  )

  app.get("/api/logs", (c) => {
    const live = opts.liveLog ? rel(resolve(opts.liveLog.path)) : undefined
    return c.json({ live, logs: findLogs(root).map(rel) })
  })

  app.get("/api/attempts", (c) => {
    const log = allowedLog(c.req.query("log"))
    if (!log) return c.json({ error: "unknown log" }, 404)
    return c.json({ log: rel(log), attempts: listAttempts(log) })
  })

  app.get("/api/replay", async (c) => {
    const log = allowedLog(c.req.query("log"))
    const id = c.req.query("id")
    if (!log || !id) return c.json({ error: "log and id are required" }, 400)
    try {
      return c.json({ ...(await replayAttempt(log, id, { expectedSignerDid: signerFor(log).did })), signerSource: signerFor(log).source })
    } catch (e) {
      return c.json({ error: (e as Error).message }, 404)
    }
  })

  app.get("/api/verify", async (c) => {
    const log = allowedLog(c.req.query("log"))
    if (!log) return c.json({ error: "unknown log" }, 404)
    const trust = signerFor(log)
    return c.json({ log: rel(log), signerSource: trust.source, ...(await verifyLog(log, { expectedSignerDid: trust.did })) })
  })

  /** Copy a log, flip one blocked decision to "allow" in the copy, and show that verification catches it. */
  app.post("/api/tamper-demo", async (c) => {
    const log = allowedLog(c.req.query("log"))
    if (!log) return c.json({ error: "unknown log" }, 404)
    const dir = mkdtempSync(join(tmpdir(), "ack-guard-tamper-"))
    const copy = join(dir, basename(log))
    copyFileSync(log, copy)
    if (existsSync(headPath(log))) copyFileSync(headPath(log), headPath(copy))
    const lines = readFileSync(copy, "utf8").trim().split("\n")
    const attemptId = c.req.query("attemptId")
    const isDeny = (l: string) => l.includes('"kind":"decision"') && l.includes('"outcome":"deny"')
    let idx = attemptId ? lines.findIndex((l) => isDeny(l) && l.includes(`"attemptId":${JSON.stringify(attemptId)}`)) : -1
    if (idx < 0) idx = lines.findIndex(isDeny)
    let change = 'a blocked decision rewritten to "allow"'
    if (idx < 0) {
      idx = lines.findIndex((l) => l.includes('"kind":"decision"'))
      change = "a decision's rule detail rewritten"
    }
    if (idx < 0) return c.json({ error: "no decision entries to tamper with yet" }, 400)
    const original = lines[idx]!
    lines[idx] = original.includes('"outcome":"deny"')
      ? original.replace('"outcome":"deny"', '"outcome":"allow"')
      : original.replace('"detail":"', '"detail":"edited: ')
    writeFileSync(copy, lines.join("\n") + "\n")
    const trust = signerFor(log)
    const before = await verifyLog(log, { expectedSignerDid: trust.did })
    const after = await verifyLog(copy, { expectedSignerDid: trust.did })
    return c.json({ log: rel(log), tamperedSeq: idx, change, before: { ok: before.ok }, after })
  })

  app.get("/api/scenarios", (c) =>
    c.json({
      canRun: !!opts.runScenario,
      info: opts.liveInfo?.() ?? {},
      scenarios: (opts.scenarios ?? []).map((s) => ({ id: s.id, category: s.category, title: s.title, description: s.description })),
    }),
  )

  app.post("/api/run", async (c) => {
    if (!opts.runScenario) return c.json({ error: "live runs are available when started with pnpm demo" }, 400)
    const body = (await c.req.json()) as { scenarioId: string; mode: "naive" | "guarded"; wait?: boolean }
    if (!opts.scenarios?.some((s) => s.id === body.scenarioId)) return c.json({ error: "unknown scenario" }, 400)
    if (body.mode !== "naive" && body.mode !== "guarded") return c.json({ error: "mode must be naive or guarded" }, 400)
    const { episodeId, done } = await opts.runScenario(body.scenarioId, body.mode)
    if (!body.wait) return c.json({ episodeId })
    const r = await done
    return c.json({
      episodeId,
      error: r.error,
      attempts: r.payResults.map((p) => ({
        attemptId: p.attemptId,
        status: p.result.status,
        rule: p.rule ?? ("rule" in p.result ? p.result.rule : undefined),
        reason: "reason" in p.result ? p.result.reason : undefined,
        amount: "amount" in p.result ? p.result.amount : undefined,
        recipient: "recipient" in p.result ? p.result.recipient : undefined,
      })),
    })
  })

  app.get("/api/approvals", (c) =>
    c.json(
      [...(opts.approvals?.values() ?? [])].map((a) => ({
        id: a.id,
        episodeId: a.episodeId,
        createdAt: a.createdAt,
        task: a.task,
        rule: a.decision.rule,
        merchant: a.decision.merchant,
        endpoint: a.decision.endpoint,
        amount: a.decision.amount,
      })),
    ),
  )

  app.post("/api/approvals/:id", async (c) => {
    const a = opts.approvals?.get(c.req.param("id"))
    if (!a) return c.json({ error: "no such pending approval" }, 404)
    const { approved } = (await c.req.json()) as { approved: boolean }
    opts.approvals!.delete(a.id)
    a.resolve({ approved: !!approved, by: "owner (via dashboard)" })
    return c.json({ ok: true })
  })

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      if (!opts.liveLog) {
        await stream.writeSSE({ event: "info", data: "no live log" })
        return
      }
      const off = opts.liveLog.onAppend((e) => {
        void stream.writeSSE({
          event: "entry",
          data: JSON.stringify({ seq: e.seq, kind: e.kind, ts: e.ts, episodeId: e.payload.episodeId, attemptId: e.payload.attemptId }),
        })
      })
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15000)
      await new Promise<void>((res) => stream.onAbort(() => res()))
      clearInterval(ping)
      off()
    }),
  )

  return app
}

export function startDashboard(opts: DashboardOptions) {
  const port = opts.port ?? 4300
  const app = createDashboard({ ...opts, port })
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" })
  return { app, server, url: `http://localhost:${port}` }
}
