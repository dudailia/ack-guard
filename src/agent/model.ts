// Model provider. Both agents (naive and guarded) always use the same model,
// prompts, tools and sampling settings; only the payment path differs.
//
//   qwen3:8b (default) -> local Ollama via its OpenAI-compatible API. No key.
//   claude-*           -> Anthropic API. Needs ANTHROPIC_API_KEY in .env.
//   scripted           -> deterministic stand-in used for tests and the
//                         offline demo. It is NOT an LLM and its results are
//                         never reported as model results.

import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { generateText, LanguageModel } from "ai"
import { scriptedGullibleModel } from "./scripted-model.js"

export interface ResolvedModel {
  id: string
  label: string
  provider: "ollama" | "anthropic" | "scripted"
  model: LanguageModel
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"]
  /** Undefined means the provider default (Claude Sonnet 5.5 rejects non-default sampling). */
  temperature?: number
}

/** Claude thinking mode for benchmark runs: "off" (between_tools) or the model's default adaptive thinking. */
export type ClaudeThinking = "off" | "adaptive"

export const OLLAMA_NUM_CTX = 16384

function ollamaBase() {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/v1\/?$/, "")
}

/**
 * Ollama's OpenAI-compatible API ignores num_ctx and defaults to a 4096-token
 * context, which silently truncates long agent episodes. We create a local
 * variant of the same weights with a 16k context (no download, no account).
 */
export async function ensureOllamaContextVariant(base: string): Promise<string> {
  const name = `ack-guard-${base.replace(/[^a-z0-9]+/gi, "-")}-16k`
  const r = await fetch(`${ollamaBase()}/api/create`, {
    method: "POST",
    body: JSON.stringify({ model: name, from: base, parameters: { num_ctx: OLLAMA_NUM_CTX }, stream: false }),
  })
  if (!r.ok) throw new Error(`could not create Ollama variant ${name}: ${await r.text()}`)
  return name
}

export async function prepareModel(id: string, opts: { thinking?: ClaudeThinking } = {}): Promise<ResolvedModel> {
  const m = resolveModel(id, opts)
  if (m.provider !== "ollama") return m
  const variant = await ensureOllamaContextVariant(id)
  const ollama = createOpenAICompatible({ name: "ollama", baseURL: `${ollamaBase()}/v1` })
  return { ...m, model: ollama.chatModel(variant), label: `${id} (local Ollama, num_ctx ${OLLAMA_NUM_CTX}, thinking off)` }
}

export function resolveModel(id: string, opts: { thinking?: ClaudeThinking } = {}): ResolvedModel {
  if (id === "scripted") {
    return { id, label: "scripted (deterministic, not an LLM)", provider: "scripted", model: scriptedGullibleModel(), temperature: 0 }
  }
  if (id.startsWith("claude")) {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env (gitignored) to run Claude benchmarks.")
    const thinking = opts.thinking ?? "off"
    return {
      id,
      label: `${id} (Anthropic API, ${thinking === "off" ? "thinking off" : "adaptive thinking"}, default sampling)`,
      provider: "anthropic",
      model: createAnthropic({ apiKey })(id),
      // Thinking off matches the qwen3 runs. No server-side fallback model: a
      // refusal is recorded as it happened instead of being answered by another model.
      providerOptions: {
        anthropic: { thinking: { type: thinking === "off" ? "between_tools" : "adaptive" }, cacheControl: { type: "ephemeral" } },
      },
    }
  }
  const ollama = createOpenAICompatible({
    name: "ollama",
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  })
  return {
    id,
    label: `${id} (local Ollama, thinking off)`,
    provider: "ollama",
    model: ollama.chatModel(id),
    // qwen3 thinking mode is ~25x slower per episode; it is disabled for both agents.
    providerOptions: { ollama: { reasoning_effort: "none" } },
    temperature: 0.7,
  }
}

export async function ollamaAvailable(model = "qwen3:8b"): Promise<boolean> {
  try {
    const r = await fetch(`${ollamaBase()}/api/tags`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return false
    const j = (await r.json()) as { models?: { name: string }[] }
    return !!j.models?.some((m) => m.name === model || m.name.startsWith(model))
  } catch {
    return false
  }
}
