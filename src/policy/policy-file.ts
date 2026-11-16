// policy.yaml: the guard's configuration as one human-readable file.
//
// The file names merchants by key; their DIDs and payout accounts are resolved
// from the operator's key registry (or, when replaying an old log, from the
// policy recorded in that log's genesis entry). Rule order is fixed by the
// engine; the file can switch a rule off or send its failures to a human.

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { canonicalJson } from "../audit/chain.js"
import { RULE_ORDER, RULE_TITLES } from "./engine.js"
import type { PolicyConfig, RuleId } from "./types.js"

export const REPO_POLICY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "policy.yaml")

/** Rules that check that a payment and its payer are genuine. They cannot be switched off. */
export const REQUIRED_RULES: RuleId[] = ["REQ_SIGNATURE", "AGENT_IDENTITY"]

export interface PolicyDocument {
  name: string
  version: number
  currency: string
  decimals: number
  limits: { per_payment_cap: string; approval_threshold: string; daily_cap: string; duplicate_window_hours: number }
  merchants: {
    key: string
    name: string
    hosts: string[]
    /** Optional explicit identity; otherwise resolved from the key registry. */
    did?: string
    payout?: string
    sells: { path: string; capability: string; price: string; description?: string }[]
  }[]
  rules: { id: RuleId; title: string; plain: string; on_fail: "deny" | "escalate"; enabled?: boolean }[]
}

export interface LoadedPolicy {
  doc: PolicyDocument
  text: string
  /** SHA-256 of the canonical JSON of the parsed document: what an approval signs. */
  hash: string
  /** Short human label, e.g. "v1-3f2a9c1b7d04". */
  version: string
}

export class PolicyError extends Error {}

export function parsePolicy(text: string): LoadedPolicy {
  let doc: PolicyDocument
  try {
    doc = parse(text) as PolicyDocument
  } catch (e) {
    throw new PolicyError(`policy is not valid YAML: ${(e as Error).message}`)
  }
  validate(doc)
  const hash = createHash("sha256").update(canonicalJson(doc)).digest("hex")
  return { doc, text, hash, version: `v${doc.version}-${hash.slice(0, 12)}` }
}

export function loadPolicyFile(path = REPO_POLICY_PATH): LoadedPolicy {
  return parsePolicy(readFileSync(path, "utf8"))
}

function validate(doc: PolicyDocument) {
  const fail = (m: string): never => {
    throw new PolicyError(m)
  }
  if (!doc || typeof doc !== "object") fail("policy must be a YAML mapping")
  if (typeof doc.name !== "string" || !Number.isInteger(doc.version)) fail("policy needs a name and an integer version")
  if (doc.currency !== "USD" || doc.decimals !== 2) fail("only USD with 2 decimals is supported")
  const l = doc.limits ?? fail("policy needs limits")
  for (const k of ["per_payment_cap", "approval_threshold", "daily_cap"] as const) {
    if (typeof l[k] !== "string" || !/^\d+(\.\d{1,2})?$/.test(l[k])) fail(`limits.${k} must be an amount like "5.00"`)
  }
  if (!(Number(l.duplicate_window_hours) > 0)) fail("limits.duplicate_window_hours must be a positive number")
  if (!Array.isArray(doc.merchants)) fail("policy needs a merchants list")
  const keys = new Set<string>()
  for (const m of doc.merchants) {
    if (!m.key || keys.has(m.key)) fail(`merchant key ${m.key} is missing or repeated`)
    keys.add(m.key)
    if (!Array.isArray(m.hosts) || !m.hosts.length) fail(`merchant ${m.key} needs hosts`)
    if (!Array.isArray(m.sells)) fail(`merchant ${m.key} needs a sells list`)
    for (const e of m.sells) {
      if (!e.path?.startsWith("/") || !e.capability) fail(`merchant ${m.key} has an endpoint without a path or capability`)
      if (typeof e.price !== "string" || !/^\d+(\.\d{1,2})?$/.test(e.price)) fail(`price of ${m.key} ${e.path} must be an amount like "0.25"`)
    }
  }
  const ids = (doc.rules ?? []).map((r) => r.id)
  if (ids.join(",") !== RULE_ORDER.join(",")) fail(`rules must list exactly ${RULE_ORDER.join(", ")}, in that order`)
  for (const r of doc.rules) {
    if (r.title !== RULE_TITLES[r.id]) fail(`rule ${r.id} title must be "${RULE_TITLES[r.id]}"`)
    if (!r.plain) fail(`rule ${r.id} needs a plain-English explanation`)
    if (r.on_fail !== "deny" && r.on_fail !== "escalate") fail(`rule ${r.id} on_fail must be deny or escalate`)
    if (r.enabled === false && REQUIRED_RULES.includes(r.id)) fail(`rule ${r.id} cannot be switched off`)
  }
}

/** "5.00" -> 500n at 2 decimals. */
export function decimalToSubunits(s: string, decimals: number): bigint {
  const [whole, frac = ""] = s.split(".")
  return BigInt(whole!) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0")
}

export type MerchantResolver = (key: string) => { did: string; recipient: string } | undefined

/** The engine's configuration from a policy document. */
export function policyConfig(p: LoadedPolicy, owner: { ownerDid: string; agentDid: string }, resolve: MerchantResolver): PolicyConfig {
  const d = p.doc
  const money = (s: string) => decimalToSubunits(s, d.decimals)
  return {
    ownerDid: owner.ownerDid,
    agentDid: owner.agentDid,
    merchants: d.merchants.map((m) => {
      const r = m.did ? { did: m.did, recipient: m.payout ?? m.did } : resolve(m.key)
      if (!r) throw new PolicyError(`merchant ${m.key} has no known identity: add did and payout to the policy, or register its key`)
      return {
        key: m.key,
        displayName: m.name,
        did: r.did,
        hosts: m.hosts,
        recipient: m.payout ?? r.recipient,
        endpoints: m.sells.map((e) => ({ path: e.path, capability: e.capability, price: money(e.price), currency: d.currency, decimals: d.decimals })),
      }
    }),
    limits: {
      perPaymentCap: money(d.limits.per_payment_cap),
      approvalThreshold: money(d.limits.approval_threshold),
      dailyCap: money(d.limits.daily_cap),
      duplicateWindowMs: Math.round(d.limits.duplicate_window_hours * 3600 * 1000),
    },
    rules: Object.fromEntries(
      d.rules.map((r) => [r.id, { enabled: r.enabled !== false, onFail: r.on_fail === "escalate" ? "needs_approval" : "deny" }]),
    ) as PolicyConfig["rules"],
    policyVersion: p.version,
    policyHash: p.hash,
  }
}
