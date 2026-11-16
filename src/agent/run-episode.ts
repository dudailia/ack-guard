// Runs one agent episode in a fresh World. The naive and guarded agents share
// this exact code path: same model, system prompt, task prompt, tools,
// temperature, seed and step limit. `mode` only changes World.pay().

import { generateText, isStepCount, tool } from "ai"
import { z } from "zod"
import type { AuditLog } from "../audit/chain.js"
import type { Identities } from "../identity/identities.js"
import type { Transfer } from "../ledger/sandbox-ledger.js"
import type { SpendStore } from "../policy/spend-store.js"
import { World, type Approver, type Mode, type PayResult, type WorldSetup } from "../world.js"
import type { ResolvedModel } from "./model.js"
import { SYSTEM_PROMPT, taskPrompt } from "./prompts.js"

export const MAX_STEPS = 16

export interface EpisodeResult {
  episodeId: string
  mode: Mode
  finalText: string
  steps: number
  transfers: Transfer[]
  payResults: { attemptId: string; result: PayResult; rule?: string }[]
  served: Record<string, { path: string; query: string }[]>
  error?: string
  durationMs: number
}

export async function runEpisode(opts: {
  ids: Identities
  setup: WorldSetup
  mode: Mode
  audit: AuditLog
  episodeId: string
  model: ResolvedModel
  seed?: number
  meta?: Record<string, unknown>
  approver?: Approver
  timeoutMs?: number
  /** Share one spend store across episodes so the daily cap is per agent (live demo). */
  spend?: SpendStore
}): Promise<EpisodeResult> {
  const t0 = Date.now()
  const world = new World(opts.ids, opts.setup, opts.mode, opts.audit, opts.episodeId, opts.approver, opts.spend)
  const task = opts.setup.task
  await opts.audit.append("task", {
    episodeId: opts.episodeId,
    mode: opts.mode,
    model: opts.model.id,
    seed: opts.seed,
    task: { ...task, budget: task.budget.toString() },
    systemPrompt: SYSTEM_PROMPT,
    ...opts.meta,
  })

  const tools = {
    http_get: tool({
      description: "Fetch a URL in the sandbox (GET). Returns status and body. HTTP 402 means payment is required.",
      inputSchema: z.object({ url: z.string().describe("Full URL, e.g. http://skycast.test/forecast?city=Boston") }),
      execute: async ({ url }) => {
        try {
          return await world.httpGetForAgent(url)
        } catch (e) {
          return { status: 0, error: (e as Error).message }
        }
      },
    }),
    pay: tool({
      description: "Pay an ACK-Pay payment request with the owner's wallet.",
      inputSchema: z.object({
        paymentRequest: z.string().describe("The payment request reference from the 402 response, e.g. pr_1"),
        paymentOptionId: z.string().optional().describe("Which payment option id to use. Defaults to the first option."),
        purpose: z.string().describe("Why this payment is needed for the user's task"),
      }),
      execute: async (input) => world.pay(input),
    }),
  }

  let finalText = ""
  let steps = 0
  let error: string | undefined
  try {
    const result = await generateText({
      model: opts.model.model,
      system: SYSTEM_PROMPT,
      prompt: taskPrompt(task.prompt, task.budget),
      tools,
      temperature: opts.model.temperature,
      seed: opts.seed,
      providerOptions: opts.model.providerOptions,
      stopWhen: isStepCount(MAX_STEPS),
      maxRetries: 1,
      timeout: opts.timeoutMs ?? 240_000,
      onLanguageModelCallEnd: async (ev) => {
        const text = ev.content
          .filter((p) => p.type === "text" || p.type === "reasoning")
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim()
        const toolCalls = ev.content
          .filter((p) => p.type === "tool-call")
          .map((p) => ({ toolName: (p as { toolName: string }).toolName, input: (p as { input: unknown }).input }))
        const u = ev.usage
        const usage = {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.inputTokenDetails?.cacheReadTokens,
          cacheWrite: u.inputTokenDetails?.cacheWriteTokens,
        }
        await opts.audit.append("agent_step", { episodeId: opts.episodeId, text: text || undefined, toolCalls, usage })
      },
    })
    finalText = result.text
    steps = result.steps.length
  } catch (e) {
    error = (e as Error).message.slice(0, 300)
  }

  const transfers = [...world.ledger.transfers]
  const served: EpisodeResult["served"] = {}
  for (const [k, s] of Object.entries(world.merchantStats)) served[k] = [...s.served]
  // Everything scoring needs is in this signed entry, so reported numbers can
  // be re-derived from the log alone (scripts/gen-results-table.ts does).
  await opts.audit.append("episode_end", {
    episodeId: opts.episodeId,
    finalText: finalText.slice(0, 2000),
    steps,
    error,
    transfers: transfers.map((t) => ({ ...t, amount: t.amount.toString() })),
    served,
  })
  return {
    episodeId: opts.episodeId,
    mode: opts.mode,
    finalText,
    steps,
    transfers,
    payResults: world.outcomes.map((o) => ({ attemptId: o.attemptId, result: o.result, rule: o.decision?.rule.id })),
    served,
    error,
    durationMs: Date.now() - t0,
  }
}
