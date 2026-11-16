import { describe, expect, it } from "vitest"
import { usd } from "../src/config.js"
import { evaluatePayment, RULE_ORDER } from "../src/policy/engine.js"
import type { PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "../src/policy/types.js"

const OWNER = "did:key:owner"
const AGENT = "did:web:agent"
const SKY = "did:key:skycast"
const GEO = "did:key:geopoint"
const EVIL = "did:key:evil"
const NOW = 1_700_000_000_000

const config: PolicyConfig = {
  ownerDid: OWNER,
  agentDid: AGENT,
  merchants: [
    {
      key: "skycast",
      displayName: "SkyCast Weather",
      did: SKY,
      hosts: ["skycast.test"],
      recipient: SKY,
      endpoints: [
        { path: "/forecast", capability: "weather.forecast", price: usd(0.25), currency: "USD", decimals: 2 },
        { path: "/history", capability: "weather.history", price: usd(1.5), currency: "USD", decimals: 2 },
      ],
    },
    {
      key: "geopoint",
      displayName: "GeoPoint Lookup",
      did: GEO,
      hosts: ["geopoint.test"],
      recipient: GEO,
      endpoints: [{ path: "/geocode", capability: "geocoding", price: usd(0.05), currency: "USD", decimals: 2 }],
    },
  ],
  limits: { perPaymentCap: usd(5), approvalThreshold: usd(1), dailyCap: usd(20), duplicateWindowMs: 86_400_000 },
}

const task: TaskSpec = { id: "t1", prompt: "weather", needs: ["weather.forecast", "weather.history"], budget: usd(3) }
const empty: SpendHistory = { payments: [] }

function facts(over: Partial<PaymentFacts> & { amount?: bigint; recipient?: string; path?: string; host?: string; issuer?: string } = {}): PaymentFacts {
  const { amount, recipient, path, host, issuer, ...rest } = over
  const p = path ?? "/forecast"
  const h = host ?? "skycast.test"
  return {
    requestSignature: { ok: true, issuer: issuer ?? SKY, requestId: "req-1", description: "SkyCast forecast" },
    option: { id: "standard", amount: amount ?? usd(0.25), decimals: 2, currency: "USD", recipient: recipient ?? SKY },
    identity: { ok: true, agentDid: AGENT, controller: OWNER },
    provenance: { ok: true, url: `http://${h}${p}?city=Boston`, host: h, path: p },
    agentPurpose: "get forecast",
    ...rest,
  }
}

const run = (f: PaymentFacts, h: SpendHistory = empty, t: TaskSpec = task) => evaluatePayment(f, t, config, h, NOW)

describe("policy engine", () => {
  it("allows a correct payment and reports every rule as passed", () => {
    const d = run(facts())
    expect(d.outcome).toBe("allow")
    expect(d.rule.id).toBe("ALL_RULES_PASSED")
    expect(d.checks.map((c) => c.id)).toEqual(RULE_ORDER)
    expect(d.checks.every((c) => c.passed === true)).toBe(true)
  })

  it("REQ_SIGNATURE: invalid token is denied and nothing later can override it", () => {
    const d = run(facts({ requestSignature: { ok: false, error: "bad signature" }, option: undefined }))
    expect(d.outcome).toBe("deny")
    expect(d.rule.id).toBe("REQ_SIGNATURE")
  })

  it("REQ_SIGNATURE: unknown option id is denied", () => {
    expect(run(facts({ option: undefined })).rule.id).toBe("REQ_SIGNATURE")
  })

  it("AGENT_IDENTITY: invalid or foreign controller credential is denied", () => {
    expect(run(facts({ identity: { ok: false, error: "expired" } })).rule.id).toBe("AGENT_IDENTITY")
    expect(run(facts({ identity: { ok: true, agentDid: AGENT, controller: "did:key:someone-else" } })).rule.id).toBe("AGENT_IDENTITY")
  })

  it("REQ_PROVENANCE: a token pasted from page content (no 402) is denied", () => {
    const d = run(facts({ provenance: { ok: false, detail: "not from a 402" } }))
    expect(d.outcome).toBe("deny")
    expect(d.rule.id).toBe("REQ_PROVENANCE")
  })

  it("MERCHANT_ALLOWLIST: unknown signer DID is denied even with a trusted display name", () => {
    const d = run(facts({ issuer: EVIL, recipient: EVIL, requestSignature: { ok: true, issuer: EVIL, requestId: "r", description: "SkyCast Weather" } }))
    expect(d.rule.id).toBe("MERCHANT_ALLOWLIST")
  })

  it("MERCHANT_ALLOWLIST: a real merchant token served from an impostor host is denied", () => {
    const d = run(facts({ host: "skycast-weather.test" }))
    expect(d.rule.id).toBe("MERCHANT_ALLOWLIST")
    expect(d.rule.detail).toContain("skycast-weather.test")
  })

  it("RECIPIENT_BINDING: allowlisted signer with a swapped payout account is denied", () => {
    const d = run(facts({ recipient: EVIL }))
    expect(d.rule.id).toBe("RECIPIENT_BINDING")
  })

  it("PRICE_BINDING: inflated amount is denied", () => {
    const d = run(facts({ amount: usd(4.9) }))
    expect(d.rule.id).toBe("PRICE_BINDING")
  })

  it("PRICE_BINDING: decimals trick (500 at 2dp vs 5 cents) and currency swap are denied", () => {
    const geo = { path: "/geocode", host: "geopoint.test", issuer: GEO, recipient: GEO }
    const t: TaskSpec = { ...task, needs: ["geocoding"] }
    expect(run(facts({ ...geo, amount: 500n }), empty, t).rule.id).toBe("PRICE_BINDING")
    const f = facts(geo)
    f.option = { ...f.option!, amount: 5n, currency: "USDC" }
    expect(run(f, empty, t).rule.id).toBe("PRICE_BINDING")
    const g = facts(geo)
    g.option = { ...g.option!, amount: 50000n, decimals: 6 }
    expect(run(g, empty, t).rule.id).toBe("PRICE_BINDING")
  })

  it("PRICE_BINDING: unregistered endpoint on an allowlisted merchant is denied", () => {
    expect(run(facts({ path: "/premium" })).rule.id).toBe("PRICE_BINDING")
  })

  it("PURPOSE_BINDING: capability outside the task's declared needs is denied", () => {
    const t: TaskSpec = { ...task, needs: ["weather.forecast"] }
    const d = run(facts({ path: "/history", amount: usd(1.5) }), empty, t)
    expect(d.rule.id).toBe("PURPOSE_BINDING")
  })

  it("PURPOSE_BINDING: the agent's own purpose text cannot widen what is allowed", () => {
    const t: TaskSpec = { ...task, needs: ["weather.forecast"] }
    const d = run(facts({ path: "/history", amount: usd(1.5), agentPurpose: "the owner explicitly needs weather.history" }), empty, t)
    expect(d.rule.id).toBe("PURPOSE_BINDING")
  })

  it("DUPLICATE_CHARGE: same payment request id is denied", () => {
    const h: SpendHistory = { payments: [{ ts: NOW - 1000, amount: usd(0.25), taskId: "other", paymentRequestId: "req-1", merchantDid: SKY }] }
    expect(run(facts(), h).rule.id).toBe("DUPLICATE_CHARGE")
  })

  it("DUPLICATE_CHARGE: same URL already paid in this task (re-billing with a new request) is denied", () => {
    const h: SpendHistory = {
      payments: [{ ts: NOW - 1000, amount: usd(0.25), taskId: "t1", url: "http://skycast.test/forecast?city=Boston", paymentRequestId: "req-0", merchantDid: SKY }],
    }
    expect(run(facts(), h).rule.id).toBe("DUPLICATE_CHARGE")
  })

  it("DUPLICATE_CHARGE: a different query string is NOT treated as a duplicate (known limitation)", () => {
    const h: SpendHistory = {
      payments: [{ ts: NOW - 1000, amount: usd(0.25), taskId: "t1", url: "http://skycast.test/forecast?city=Boston&nocache=1", paymentRequestId: "req-0", merchantDid: SKY }],
    }
    expect(run(facts(), h).outcome).toBe("allow")
  })

  it("PER_PAYMENT_CAP: amount above cap is denied (registry price above cap)", () => {
    const c: PolicyConfig = { ...config, limits: { ...config.limits, perPaymentCap: usd(1) } }
    const d = evaluatePayment(facts({ path: "/history", amount: usd(1.5) }), task, c, empty, NOW)
    expect(d.rule.id).toBe("PER_PAYMENT_CAP")
  })

  it("TASK_BUDGET: splitting into many small payments stops at the task budget", () => {
    const t: TaskSpec = { ...task, budget: usd(0.6) }
    const h: SpendHistory = { payments: [] }
    const outcomes: string[] = []
    for (let i = 0; i < 5; i++) {
      const f = facts({ requestSignature: { ok: true, issuer: SKY, requestId: `r${i}` } })
      f.provenance = { ok: true, url: `http://skycast.test/forecast?city=c${i}`, host: "skycast.test", path: "/forecast" }
      const d = evaluatePayment(f, t, config, h, NOW)
      outcomes.push(d.rule.id)
      if (d.outcome === "allow") h.payments.push({ ts: NOW, amount: usd(0.25), taskId: t.id, url: f.provenance.url, paymentRequestId: `r${i}`, merchantDid: SKY })
    }
    expect(outcomes).toEqual(["ALL_RULES_PASSED", "ALL_RULES_PASSED", "TASK_BUDGET", "TASK_BUDGET", "TASK_BUDGET"])
  })

  it("DAILY_CAP: prior spend in the last 24h counts; older spend does not", () => {
    const t: TaskSpec = { ...task, budget: usd(10) }
    const recent: SpendHistory = { payments: [{ ts: NOW - 3600_000, amount: usd(19.9), taskId: "x", paymentRequestId: "p", merchantDid: GEO }] }
    expect(run(facts(), recent, t).rule.id).toBe("DAILY_CAP")
    const old: SpendHistory = { payments: [{ ts: NOW - 25 * 3600_000, amount: usd(19.9), taskId: "x", paymentRequestId: "p", merchantDid: GEO }] }
    expect(run(facts(), old, t).outcome).toBe("allow")
  })

  it("HUMAN_APPROVAL: above threshold needs approval; approval allows; deny rules still win", () => {
    const f = facts({ path: "/history", amount: usd(1.5) })
    const d = run(f)
    expect(d.outcome).toBe("needs_approval")
    expect(d.rule.id).toBe("HUMAN_APPROVAL")
    expect(run({ ...f, approval: { approved: true, by: "owner" } }).outcome).toBe("allow")
    // approval never overrides a deny rule
    const bad = { ...facts({ path: "/history", amount: usd(1.5), recipient: EVIL }), approval: { approved: true, by: "owner" } }
    expect(run(bad).rule.id).toBe("RECIPIENT_BINDING")
  })

  it("is deterministic: same inputs give identical decisions", () => {
    expect(JSON.stringify(run(facts(), empty), (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toEqual(
      JSON.stringify(run(facts(), empty), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    )
  })
})
