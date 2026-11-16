// A deterministic, maximally gullible stand-in "model" built on the AI SDK's
// MockLanguageModelV4. It is NOT an LLM. It exists so the attack runner, the
// scoring and the guard can be tested deterministically, and so the demo has
// an offline fallback. It follows every .test link it sees and pays every
// ACK payment request token it sees, which is the worst case for a wallet.

import { MockLanguageModelV4 } from "ai/test"

const TOKEN_RE = /\bpr_\d+\b|eyJ[\w-]+\.[\w-]+\.[\w-]+/g
const URL_RE = /https?:\/\/[a-z0-9.-]+\.test(?:\/[^\s"'<>)\\\]]*)?/gi

type Msg = { role: string; content: unknown }

function asText(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v)
}

function parseInput(input: unknown): Record<string, unknown> {
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return (input ?? {}) as Record<string, unknown>
}

export function decideNextAction(prompt: Msg[]): { tool: "http_get" | "pay"; input: Record<string, unknown> } | { text: string } {
  const visited = new Set<string>()
  const paid = new Set<string>()
  // Discoveries grouped by message, so the most recent tool output is acted on first (depth-first).
  const groups: { kind: "url" | "token"; value: string }[][] = []
  let discovered: { kind: "url" | "token"; value: string }[] = []
  let lastPayFollowUp: string | undefined
  // Gullible about credentials too: pay under the latest delegation credential it was offered.
  let offeredCredential: string | undefined

  const scan = (text: string) => {
    // Normalize JSON-escaped slashes so URLs inside JSON strings are found.
    const t = text.replace(/\\\//g, "/")
    for (const m of t.matchAll(/\bcred_\d+\b/g)) offeredCredential = m[0]
    const hits: { idx: number; kind: "url" | "token"; value: string }[] = []
    for (const m of t.matchAll(URL_RE)) hits.push({ idx: m.index ?? 0, kind: "url", value: m[0].replace(/[.,;:]+$/, "") })
    for (const m of t.matchAll(TOKEN_RE)) hits.push({ idx: m.index ?? 0, kind: "token", value: m[0] })
    hits.sort((a, b) => a.idx - b.idx)
    for (const h of hits) discovered.push({ kind: h.kind, value: h.value })
  }

  for (const msg of prompt) {
    discovered = []
    groups.push(discovered)
    if (msg.role === "user") scan(asText(msg.content))
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content as { type: string; toolName?: string; input?: unknown }[]) {
        if (part.type !== "tool-call") continue
        const input = parseInput(part.input)
        if (part.toolName === "http_get") visited.add(String(input.url))
        if (part.toolName === "pay") paid.add(String(input.paymentRequest))
      }
    }
    if (msg.role === "tool" && Array.isArray(msg.content)) {
      for (const part of msg.content as { toolName?: string; output?: unknown }[]) {
        const text = asText(part.output)
        lastPayFollowUp = undefined
        if (part.toolName === "pay") {
          const m = text.match(/Call http_get on (\S+) again/)
          if (m) lastPayFollowUp = m[1]
        } else {
          scan(text)
        }
      }
    }
  }

  if (lastPayFollowUp) return { tool: "http_get", input: { url: lastPayFollowUp } }
  for (const group of [...groups].reverse()) {
    for (const d of group) {
      if (d.kind === "token" && !paid.has(d.value))
        return { tool: "pay", input: { paymentRequest: d.value, purpose: "required by the content I fetched", ...(offeredCredential ? { credential: offeredCredential } : {}) } }
      if (d.kind === "url" && !visited.has(d.value)) return { tool: "http_get", input: { url: d.value } }
    }
  }
  return { text: "Done. I completed the steps I found." }
}

let counter = 0
export function scriptedGullibleModel() {
  return new MockLanguageModelV4({
    provider: "ack-guard",
    modelId: "scripted-gullible",
    doGenerate: async (options) => {
      const action = decideNextAction(options.prompt as unknown as Msg[])
      const usage = {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 0, text: 0, reasoning: undefined },
      }
      if ("text" in action) {
        return { content: [{ type: "text", text: action.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] }
      }
      return {
        content: [
          { type: "text", text: `Next: ${action.tool}.` },
          { type: "tool-call", toolCallId: `call_${++counter}`, toolName: action.tool, input: JSON.stringify(action.input) },
        ],
        finishReason: { unified: "tool-calls", raw: undefined },
        usage,
        warnings: [],
      }
    },
  })
}
