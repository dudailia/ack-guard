// Property-based tests (fast-check) for the policy engine, the serialized
// payment path, and the audit verifier.

import { copyFileSync, readFileSync, writeFileSync } from "node:fs"
import { createJwt } from "agentcommercekit"
import fc from "fast-check"
import { beforeAll, describe, expect, it } from "vitest"
import { AuditLog, entryHash, headPath, type AuditEntry } from "../src/audit/chain.js"
import { verifyLog } from "../src/audit/verify.js"
import { usd } from "../src/config.js"
import type { Identities } from "../src/identity/identities.js"
import { evaluatePayment } from "../src/policy/engine.js"
import type { PaidRecord, PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "../src/policy/types.js"
import { World } from "../src/world.js"
import { testIdentities, tmpAudit, tmpLogPath } from "./helpers.js"

// ---------------------------------------------------------------- policy

const OWNER = "did:key:owner"
const AGENT = "did:web:agent"
const SKY = "did:key:sky"
const GEO = "did:key:geo"
const EVIL = "did:key:evil"
const NOW = 1_800_000_000_000
const DAY = 24 * 3600 * 1000

const config: PolicyConfig = {
  ownerDid: OWNER,
  agentDid: AGENT,
  merchants: [
    {
      key: "sky",
      displayName: "Sky",
      did: SKY,
      hosts: ["sky.test"],
      recipient: SKY,
      endpoints: [
        { path: "/forecast", capability: "weather.forecast", price: 25n, currency: "USD", decimals: 2 },
        { path: "/history", capability: "weather.history", price: 150n, currency: "USD", decimals: 2 },
      ],
    },
    {
      key: "geo",
      displayName: "Geo",
      did: GEO,
      hosts: ["geo.test"],
      recipient: "acct:geo-payouts",
      endpoints: [{ path: "/geocode", capability: "geocoding", price: 5n, currency: "USD", decimals: 2 }],
    },
  ],
  limits: { perPaymentCap: 500n, approvalThreshold: 100n, dailyCap: 2000n, duplicateWindowMs: DAY },
}

const dids = fc.constantFrom(SKY, GEO, EVIL)
const hosts = fc.constantFrom("sky.test", "geo.test", "evil.test")
const paths = fc.constantFrom("/forecast", "/history", "/geocode", "/premium")
const urls = fc.tuple(hosts, paths, fc.integer({ min: 0, max: 3 })).map(([h, p, q]) => ({ host: h, path: p, url: `http://${h}${p}?q=${q}` }))
const amounts = fc.oneof(fc.constantFrom(5n, 25n, 150n, 500n, 501n, 2500n), fc.bigInt({ min: 1n, max: 3000n }))

// Near-miss generation: start from a fully valid payment for a random
// endpoint, then apply zero or more random perturbations. Purely random facts
// almost never pass every rule, which would make "allow implies invariants"
// vacuously true.
const ENDPOINTS = config.merchants.flatMap((m) => m.endpoints.map((e) => ({ m, e })))
const PERTURB = [
  "sigFail", "noOption", "idFail", "otherAgent", "otherController", "noProvenance", "foreignHost",
  "evilIssuer", "swapRecipient", "otherAmount", "decimals6", "usdc", "otherPath",
] as const

const factsArb: fc.Arbitrary<PaymentFacts> = fc
  .record({
    pick: fc.integer({ min: 0, max: ENDPOINTS.length - 1 }),
    q: fc.integer({ min: 0, max: 3 }),
    requestId: fc.constantFrom("r1", "r2", "r3", "r4", "r5", "r6"),
    perturb: fc.subarray([...PERTURB], { maxLength: 3 }),
    amount: amounts,
    otherPath: paths,
    approval: fc.option(fc.boolean(), { nil: undefined }),
  })
  .map((r) => {
    const { m, e } = ENDPOINTS[r.pick]!
    const has = (k: (typeof PERTURB)[number]) => r.perturb.includes(k)
    const host = has("foreignHost") ? "evil.test" : m.hosts[0]!
    const path = has("otherPath") ? r.otherPath : e.path
    const issuer = has("evilIssuer") ? EVIL : m.did
    const f: PaymentFacts = {
      requestSignature: has("sigFail") ? { ok: false, error: "bad" } : { ok: true, issuer, requestId: r.requestId },
      option: has("noOption")
        ? undefined
        : {
            id: "o",
            amount: has("otherAmount") ? r.amount : e.price,
            decimals: has("decimals6") ? 6 : 2,
            currency: has("usdc") ? "USDC" : "USD",
            recipient: has("swapRecipient") ? EVIL : m.recipient,
          },
      identity: has("idFail")
        ? { ok: false, error: "x" }
        : { ok: true, agentDid: has("otherAgent") ? "did:web:other" : AGENT, controller: has("otherController") ? EVIL : OWNER },
      provenance: has("noProvenance") ? { ok: false } : { ok: true, url: `http://${host}${path}?q=${r.q}`, host, path },
      agentPurpose: "the owner definitely needs this",
      approval: r.approval === undefined ? undefined : { approved: r.approval, by: "test" },
    }
    return f
  })

const taskArb: fc.Arbitrary<TaskSpec> = fc.record({
  id: fc.constantFrom("t1", "t2"),
  prompt: fc.constant("p"),
  needs: fc.subarray(["weather.forecast", "weather.history", "geocoding", "data.premium"]),
  budget: fc.bigInt({ min: 0n, max: 1000n }),
})

const historyArb: fc.Arbitrary<SpendHistory> = fc
  .array(
    fc.record({
      ageMs: fc.integer({ min: 0, max: 2 * DAY }),
      amount: fc.bigInt({ min: 1n, max: 800n }),
      taskId: fc.constantFrom("t1", "t2", "other"),
      where: urls,
      paymentRequestId: fc.constantFrom("r1", "r2", "x", "y"),
      merchantDid: dids,
    }),
    { maxLength: 6 },
  )
  .map((ps) => ({
    payments: ps.map((p): PaidRecord => ({
      ts: NOW - p.ageMs,
      amount: p.amount,
      taskId: p.taskId,
      url: p.where.url,
      paymentRequestId: p.paymentRequestId,
      merchantDid: p.merchantDid,
    })),
  }))

/** Independent statement of what "allowed" must imply. Written separately from the engine on purpose. */
function invariantsHold(f: PaymentFacts, t: TaskSpec, h: SpendHistory): string | null {
  if (!f.requestSignature.ok || !f.option) return "allowed without a valid signed request"
  if (!f.identity.ok || f.identity.agentDid !== AGENT || f.identity.controller !== OWNER) return "allowed without owner identity"
  if (!f.provenance.ok) return "allowed without provenance"
  const m = config.merchants.find((x) => x.did === f.requestSignature.issuer)
  if (!m) return "allowed a non-allowlisted signer"
  if (!m.hosts.includes(f.provenance.host!)) return "allowed a token served from a foreign host"
  if (f.option.recipient !== m.recipient) return "allowed an unbound recipient"
  const e = m.endpoints.find((x) => x.path === f.provenance.path)
  if (!e) return "allowed an unregistered endpoint"
  if (f.option.amount !== e.price || f.option.currency !== e.currency || f.option.decimals !== e.decimals) return "allowed a wrong price"
  if (!t.needs.includes(e.capability)) return "allowed an undeclared purpose"
  if (h.payments.some((p) => p.paymentRequestId === f.requestSignature.requestId)) return "allowed a repeated request"
  if (h.payments.some((p) => p.taskId === t.id && p.url === f.provenance.url && p.merchantDid === m.did && NOW - p.ts <= DAY))
    return "allowed a repeated URL"
  if (f.option.amount > config.limits.perPaymentCap) return "allowed above the per-payment cap"
  const taskSpent = h.payments.filter((p) => p.taskId === t.id).reduce((a, p) => a + p.amount, 0n)
  if (taskSpent + f.option.amount > t.budget) return "allowed above the task budget"
  const daySpent = h.payments.filter((p) => NOW - p.ts < DAY).reduce((a, p) => a + p.amount, 0n)
  if (daySpent + f.option.amount > config.limits.dailyCap) return "allowed above the daily cap"
  if (f.option.amount > config.limits.approvalThreshold && f.approval?.approved !== true) return "allowed above threshold without a human"
  return null
}

describe("policy engine properties", () => {
  it("never allows a payment that violates any invariant", () => {
    fc.assert(
      fc.property(factsArb, taskArb, historyArb, (f, t, h) => {
        const d = evaluatePayment(f, t, config, h, NOW)
        if (d.outcome === "allow") expect(invariantsHold(f, t, h)).toBeNull()
      }),
      { numRuns: 20000 },
    )
  })

  it("finds allowed payments too (the generator is not vacuous)", () => {
    let allowed = 0
    fc.assert(
      fc.property(factsArb, taskArb, historyArb, (f, t, h) => {
        if (evaluatePayment(f, t, config, h, NOW).outcome === "allow") allowed++
      }),
      { numRuns: 20000 },
    )
    expect(allowed).toBeGreaterThan(500)
  })

  it("reports the first failing check as the deciding rule, and is deterministic", () => {
    fc.assert(
      fc.property(factsArb, taskArb, historyArb, (f, t, h) => {
        const d = evaluatePayment(f, t, config, h, NOW)
        const first = d.checks.find((c) => c.passed !== true)
        expect(d.rule.id).toBe(first ? first.id : "ALL_RULES_PASSED")
        expect(evaluatePayment(f, t, config, h, NOW).rule).toEqual(d.rule)
      }),
      { numRuns: 5000 },
    )
  })

  it("a human approval never turns a deny into an allow", () => {
    fc.assert(
      fc.property(factsArb, taskArb, historyArb, (f, t, h) => {
        const without = evaluatePayment({ ...f, approval: undefined }, t, config, h, NOW)
        const withApproval = evaluatePayment({ ...f, approval: { approved: true, by: "owner" } }, t, config, h, NOW)
        if (without.outcome === "deny") {
          expect(withApproval.outcome).toBe("deny")
          expect(withApproval.rule.id).toBe(without.rule.id)
        }
      }),
      { numRuns: 5000 },
    )
  })

  it("cumulative spend never exceeds the task budget or the daily cap, in any order", () => {
    const attempt = fc.record({
      endpoint: fc.constantFrom(
        { host: "sky.test", path: "/forecast", price: 25n, did: SKY, recipient: SKY },
        { host: "sky.test", path: "/history", price: 150n, did: SKY, recipient: SKY },
        { host: "geo.test", path: "/geocode", price: 5n, did: GEO, recipient: "acct:geo-payouts" },
      ),
      q: fc.integer({ min: 0, max: 50 }),
      approved: fc.boolean(),
    })
    fc.assert(
      fc.property(
        fc.array(attempt, { minLength: 1, maxLength: 40 }),
        fc.bigInt({ min: 0n, max: 1500n }),
        fc.bigInt({ min: 0n, max: 2000n }),
        (attempts, budget, prior) => {
          const task: TaskSpec = { id: "t1", prompt: "p", needs: ["weather.forecast", "weather.history", "geocoding"], budget }
          const h: SpendHistory = { payments: prior > 0n ? [{ ts: NOW - 1000, amount: prior, taskId: "earlier", paymentRequestId: "prior", merchantDid: GEO }] : [] }
          attempts.forEach((a, i) => {
            const url = `http://${a.endpoint.host}${a.endpoint.path}?q=${a.q}`
            const f: PaymentFacts = {
              requestSignature: { ok: true, issuer: a.endpoint.did, requestId: `req-${i}` },
              option: { id: "o", amount: a.endpoint.price, decimals: 2, currency: "USD", recipient: a.endpoint.recipient },
              identity: { ok: true, agentDid: AGENT, controller: OWNER },
              provenance: { ok: true, url, host: a.endpoint.host, path: a.endpoint.path },
              agentPurpose: "",
              approval: a.approved ? { approved: true, by: "owner" } : undefined,
            }
            const d = evaluatePayment(f, task, config, h, NOW)
            if (d.outcome === "allow") h.payments.push({ ts: NOW, amount: a.endpoint.price, taskId: "t1", url, paymentRequestId: `req-${i}`, merchantDid: a.endpoint.did })
          })
          const taskSpent = h.payments.filter((p) => p.taskId === "t1").reduce((s, p) => s + p.amount, 0n)
          const daySpent = h.payments.reduce((s, p) => s + p.amount, 0n)
          expect(taskSpent).toBeLessThanOrEqual(budget)
          if (prior <= config.limits.dailyCap) expect(daySpent).toBeLessThanOrEqual(config.limits.dailyCap)
          else expect(taskSpent).toBe(0n)
        },
      ),
      { numRuns: 3000 },
    )
  })
})

// ---------------------------------------------- concurrency, real payment path

describe("serialized payment path (real ACK tokens, real merchants)", () => {
  let ids: Identities
  beforeAll(async () => {
    ids = await testIdentities()
  })

  it("under any batching of concurrent pay calls, ledger spend stays within the task budget and daily cap", async () => {
    const cities = ["Boston", "Cambridge", "Quincy", "Salem", "Lowell"]
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ city: fc.constantFrom(...cities), path: fc.constantFrom("forecast", "alerts"), repeat: fc.integer({ min: 1, max: 3 }) }), { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 0, max: 120 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 0, max: 2000 }),
        async (plan, budgetCents, batchSize, priorCents) => {
          const audit = await tmpAudit(ids)
          const w = new World(
            ids,
            {
              task: { id: "t", prompt: "", needs: ["weather.forecast", "weather.alerts"], budget: BigInt(budgetCents) },
              priorSpend: priorCents ? [{ amount: BigInt(priorCents), hoursAgo: 1 }] : [],
            },
            "guarded",
            audit,
            "prop",
          )
          const refs: string[] = []
          for (const p of plan) {
            const r = (await w.httpGetForAgent(`http://skycast.test/${p.path}?city=${p.city}`)) as { payment_request?: string }
            for (let i = 0; i < p.repeat; i++) if (r.payment_request) refs.push(r.payment_request)
          }
          for (let i = 0; i < refs.length; i += batchSize) {
            await Promise.all(refs.slice(i, i + batchSize).map((ref) => w.pay({ paymentRequest: ref, purpose: "x" })))
          }
          const spent = w.ledger.transfers.reduce((a, t) => a + t.amount, 0n)
          expect(spent).toBeLessThanOrEqual(BigInt(budgetCents))
          expect(BigInt(priorCents) + spent <= usd(20) || spent === 0n).toBe(true)
          // No request is ever paid twice.
          const reqIds = w.ledger.transfers.map((t) => t.paymentRequestId)
          expect(new Set(reqIds).size).toBe(reqIds.length)
        },
      ),
      { numRuns: 40 },
    )
  }, 120_000)
})

// ---------------------------------------------------------- audit verifier fuzz

describe("audit verifier fuzzing", () => {
  let ids: Identities
  let template: string
  const N = 8
  beforeAll(async () => {
    ids = await testIdentities()
    template = tmpLogPath()
    const log = new AuditLog(template, ids.parties.guard)
    await log.append("genesis", { guardDid: ids.parties.guard.did })
    for (let i = 1; i < N; i++)
      await log.append(i % 2 ? "decision" : "agent_step", { episodeId: "e", n: i, nested: { amount: String(i * 25), list: [i, "x"] } })
  })

  type Mutation =
    | { kind: "field"; i: number; field: "payload" | "ts" | "kind" | "prevHash" | "hash" | "sig" | "seq" }
    | { kind: "flip"; i: number; pos: number; ch: string }
    | { kind: "delete"; i: number }
    | { kind: "swap"; i: number; j: number }
    | { kind: "truncate"; k: number }
    | { kind: "duplicate"; i: number }
    | { kind: "forge"; i: number }

  const mutation: fc.Arbitrary<Mutation> = fc.oneof(
    fc.record({ kind: fc.constant("field" as const), i: fc.integer({ min: 0, max: N - 1 }), field: fc.constantFrom("payload", "ts", "kind", "prevHash", "hash", "sig", "seq") }),
    fc.record({ kind: fc.constant("flip" as const), i: fc.integer({ min: 0, max: N - 1 }), pos: fc.nat(), ch: fc.constantFrom("a", "0", "Z", "}", '"', "x", "9") }),
    fc.record({ kind: fc.constant("delete" as const), i: fc.integer({ min: 0, max: N - 1 }) }),
    fc
      .tuple(fc.integer({ min: 0, max: N - 1 }), fc.integer({ min: 0, max: N - 1 }))
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => ({ kind: "swap" as const, i: Math.min(a, b), j: Math.max(a, b) })),
    fc.record({ kind: fc.constant("truncate" as const), k: fc.integer({ min: 0, max: N - 1 }) }),
    fc.record({ kind: fc.constant("duplicate" as const), i: fc.integer({ min: 0, max: N - 1 }) }),
    fc.record({ kind: fc.constant("forge" as const), i: fc.integer({ min: 0, max: N - 1 }) }),
  )

  /** Applies the mutation; returns the position where verification must first break. */
  async function apply(path: string, m: Mutation): Promise<number> {
    const ls = readFileSync(path, "utf8").trim().split("\n")
    switch (m.kind) {
      case "field": {
        const e = JSON.parse(ls[m.i]!) as AuditEntry & Record<string, unknown>
        if (m.field === "payload") e.payload = { ...e.payload, n: 999 }
        else if (m.field === "ts") e.ts = "2001-01-01T00:00:00.000Z"
        else if (m.field === "kind") e.kind = e.kind === "decision" ? "settlement" : "decision"
        else if (m.field === "seq") e.seq = e.seq + 100
        else e[m.field] = String(e[m.field]).replace(/.$/, (c) => (c === "A" ? "B" : "A"))
        ls[m.i] = JSON.stringify(e)
        break
      }
      case "flip": {
        const line = ls[m.i]!
        const pos = m.pos % line.length
        const ch = line[pos] === m.ch ? (m.ch === "a" ? "b" : "a") : m.ch
        ls[m.i] = line.slice(0, pos) + ch + line.slice(pos + 1)
        break
      }
      case "delete":
        ls.splice(m.i, 1)
        break
      case "swap":
        ;[ls[m.i], ls[m.j]] = [ls[m.j]!, ls[m.i]!]
        break
      case "truncate":
        ls.length = m.k
        break
      case "duplicate":
        ls.splice(m.i + 1, 0, ls[m.i]!)
        writeFileSync(path, ls.join("\n") + "\n")
        return m.i + 1
      case "forge": {
        // A well-formed entry, correctly linked and hashed, but signed by another key.
        const original = JSON.parse(ls[m.i]!) as AuditEntry
        const e: AuditEntry = { ...original, payload: { forged: true } }
        e.hash = entryHash(e)
        const a = ids.parties.attacker
        e.sig = await createJwt({ seq: e.seq, hash: e.hash }, { issuer: a.did, signer: a.signer }, { alg: a.alg })
        ls[m.i] = JSON.stringify(e)
        break
      }
    }
    writeFileSync(path, ls.length ? ls.join("\n") + "\n" : "")
    return m.kind === "truncate" ? m.k : m.i
  }

  it("detects every random edit, flip, deletion, reorder, truncation, duplication and forgery at the right position", async () => {
    await fc.assert(
      fc.asyncProperty(mutation, async (m) => {
        const path = tmpLogPath()
        copyFileSync(template, path)
        copyFileSync(headPath(template), headPath(path))
        const expected = await apply(path, m)
        const r = await verifyLog(path, { expectedSignerDid: ids.parties.guard.did })
        expect(r.ok, JSON.stringify(m)).toBe(false)
        expect(r.firstBadSeq, JSON.stringify(m)).toBe(expected)
      }),
      { numRuns: 400 },
    )
  }, 120_000)

  it("accepts the untouched log", async () => {
    const r = await verifyLog(template, { expectedSignerDid: ids.parties.guard.did })
    expect(r.ok).toBe(true)
    expect(r.firstBadSeq).toBeNull()
  })
})
