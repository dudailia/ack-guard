// ITEM_BINDING: a payment is only allowed for the item the task declared
// (capability plus exact query parameters). Unit tests on the matcher, engine
// tests on the rule, sandbox tests through the real merchant and URL
// canonicalisation (case, encoding, extra, repeated and reordered parameters, a
// redirect to another city), and property tests.

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { usd } from "../src/config.js"
import { evaluatePayment, RULE_ORDER } from "../src/policy/engine.js"
import { bindItem, matchItem } from "../src/policy/items.js"
import { SpendStore } from "../src/policy/spend-store.js"
import type { ItemSpec, PaidRecord, PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "../src/policy/types.js"
import { normalizeUrl, World, type WorldSetup } from "../src/world.js"
import { testIdentities, tmpAudit } from "./helpers.js"

const BOSTON: ItemSpec = { capability: "weather.forecast", params: { city: "Boston" } }
const CHICAGO: ItemSpec = { capability: "weather.forecast", params: { city: "Chicago" } }
const FR: ItemSpec = { capability: "translation", params: { text: "the meeting is at noon", to: "fr" } }
const F = "http://skycast.test/forecast"

describe("item matcher", () => {
  it("matches the declared parameters, ignoring letter case of names and values", () => {
    expect(matchItem(BOSTON, `${F}?city=Boston`).ok).toBe(true)
    expect(matchItem(BOSTON, `${F}?city=BOSTON`).ok).toBe(true)
    expect(matchItem(BOSTON, `${F}?CITY=boston`).ok).toBe(true)
  })
  it("decodes percent-encoding and '+' before comparing", () => {
    expect(matchItem(BOSTON, `${F}?city=Bost%6Fn`).ok).toBe(true)
    expect(matchItem(BOSTON, `${F}?%63ity=Boston`).ok).toBe(true)
    expect(matchItem(FR, "http://linguabridge.test/translate?text=the+meeting+is+at+noon&to=fr").ok).toBe(true)
  })
  it("does not care about parameter order", () => {
    expect(matchItem(FR, "http://linguabridge.test/translate?to=fr&text=the%20meeting%20is%20at%20noon").ok).toBe(true)
  })
  it("refuses another value, a missing, an extra or a repeated parameter", () => {
    expect(matchItem(BOSTON, `${F}?city=Chicago`)).toMatchObject({ ok: false, detail: "city=Chicago but the item needs city=Boston" })
    expect(matchItem(BOSTON, F)).toMatchObject({ ok: false, detail: expect.stringMatching(/city is missing/) })
    expect(matchItem(BOSTON, `${F}?city=Boston&days=30`)).toMatchObject({ ok: false, detail: expect.stringMatching(/days is not part/) })
    expect(matchItem(BOSTON, `${F}?city=Boston&city=Chicago`)).toMatchObject({ ok: false, detail: expect.stringMatching(/appears 2 times/) })
    expect(matchItem(BOSTON, `${F}?city=Boston&CITY=Boston`).ok).toBe(false)
    expect(matchItem(FR, "http://linguabridge.test/translate?text=the%20meeting%20is%20at%20noon&to=es").ok).toBe(false)
  })
  it("does not trim or fold look-alike characters", () => {
    expect(matchItem(BOSTON, `${F}?city=Boston%20`).ok).toBe(false)
    expect(matchItem(BOSTON, `${F}?city=%20Boston`).ok).toBe(false)
    expect(matchItem(BOSTON, `${F}?city=Bost%D0%BEn`).ok).toBe(false) // Cyrillic o
    expect(matchItem(BOSTON, `${F}?city=Boston%2C%20MA`).ok).toBe(false)
    expect(matchItem(BOSTON, `${F}?city=`).ok).toBe(false)
  })
  it("each listed item is bought once; listing it twice allows two", () => {
    expect(bindItem([BOSTON], "weather.forecast", `${F}?city=Boston`, []).ok).toBe(true)
    expect(bindItem([BOSTON], "weather.forecast", `${F}?city=boston`, [`${F}?city=Boston`])).toMatchObject({ ok: false, detail: expect.stringMatching(/already bought/) })
    expect(bindItem([BOSTON, BOSTON], "weather.forecast", `${F}?city=Boston`, [`${F}?city=Boston`]).ok).toBe(true)
    expect(bindItem([BOSTON, CHICAGO], "weather.forecast", `${F}?city=Chicago`, [`${F}?city=Boston`]).ok).toBe(true)
  })
  it("a capability the task gives no item for is not checked, and says so", () => {
    const b = bindItem(undefined, "weather.forecast", `${F}?city=Chicago`, [])
    expect(b).toMatchObject({ ok: true, specified: false })
    expect(b.detail).toMatch(/not checked/)
    expect(bindItem([FR], "weather.forecast", `${F}?city=Chicago`, []).specified).toBe(false)
  })
})

// ---------------------------------------------------------------- engine

const OWNER = "did:key:owner"
const AGENT = "did:web:agent"
const SKY = "did:key:sky"
const NOW = 1_800_000_000_000
const config: PolicyConfig = {
  ownerDid: OWNER,
  agentDid: AGENT,
  merchants: [
    {
      key: "sky",
      displayName: "Sky",
      did: SKY,
      hosts: ["skycast.test"],
      recipient: SKY,
      endpoints: [{ path: "/forecast", capability: "weather.forecast", price: 25n, currency: "USD", decimals: 2 }],
    },
  ],
  limits: { perPaymentCap: 500n, approvalThreshold: 100n, dailyCap: 2000n, duplicateWindowMs: 86_400_000 },
}
const taskWith = (items?: ItemSpec[], needs = ["weather.forecast"]): TaskSpec => ({ id: "t", prompt: "", needs, budget: 100n, ...(items ? { items } : {}) })
const factsFor = (url: string, reqId = "req-1"): PaymentFacts => {
  const u = new URL(url)
  return {
    requestSignature: { ok: true, issuer: SKY, requestId: reqId },
    option: { id: "o", amount: 25n, decimals: 2, currency: "USD", recipient: SKY },
    identity: { ok: true, agentDid: AGENT, controller: OWNER },
    provenance: { ok: true, url, host: u.hostname, path: u.pathname },
    agentPurpose: "forecast",
  }
}

describe("ITEM_BINDING in the engine", () => {
  it("runs right after PURPOSE_BINDING and before the delegation and duplicate rules", () => {
    expect(RULE_ORDER.indexOf("ITEM_BINDING")).toBe(RULE_ORDER.indexOf("PURPOSE_BINDING") + 1)
    expect(RULE_ORDER.indexOf("ITEM_BINDING")).toBeLessThan(RULE_ORDER.indexOf("DUPLICATE_CHARGE"))
  })
  it("denies the right merchant, endpoint and price for another city, and names both", () => {
    const d = evaluatePayment(factsFor(`${F}?city=Chicago`), taskWith([BOSTON]), config, { payments: [] }, NOW)
    expect(d.outcome).toBe("deny")
    expect(d.rule.id).toBe("ITEM_BINDING")
    expect(d.rule.detail).toMatch(/city=Chicago but the item needs city=Boston/)
    // Every earlier rule passed: this is exactly the purchase the guard allowed before.
    expect(d.checks.slice(0, RULE_ORDER.indexOf("ITEM_BINDING")).every((c) => c.passed)).toBe(true)
  })
  it("allows the declared item", () => {
    const d = evaluatePayment(factsFor(`${F}?city=Boston`), taskWith([BOSTON]), config, { payments: [] }, NOW)
    expect(d.outcome).toBe("allow")
    expect(d.checks.find((c) => c.id === "ITEM_BINDING")?.detail).toMatch(/is the item the task asked for/)
  })
  it("passes, and records that it did not check, when the task lists no item (every older log)", () => {
    const d = evaluatePayment(factsFor(`${F}?city=Chicago`), taskWith(), config, { payments: [] }, NOW)
    expect(d.outcome).toBe("allow")
    expect(d.checks.find((c) => c.id === "ITEM_BINDING")?.detail).toMatch(/not checked/)
  })
  it("fails closed without provenance, and cannot be evaluated without a registered endpoint", () => {
    const f = { ...factsFor(`${F}?city=Boston`), provenance: { ok: false } }
    const d = evaluatePayment(f, taskWith([BOSTON]), config, { payments: [] }, NOW)
    expect(d.checks.find((c) => c.id === "ITEM_BINDING")?.passed).toBeNull()
    expect(d.outcome).toBe("deny")
  })
  it("counts only this task's earlier purchases of the capability", () => {
    const paid = (taskId: string, url: string): PaidRecord => ({ ts: NOW - 1000, amount: 25n, taskId, url, paymentRequestId: `p-${taskId}`, merchantDid: SKY, capability: "weather.forecast" })
    const t = taskWith([BOSTON, CHICAGO], ["weather.forecast", "weather.forecast"])
    const other: SpendHistory = { payments: [paid("other", `${F}?city=Boston`)] }
    expect(evaluatePayment(factsFor(`${F}?city=Boston`), t, config, other, NOW).outcome).toBe("allow")
    const mine: SpendHistory = { payments: [paid("t", `${F}?city=Boston`)] }
    const again = evaluatePayment(factsFor(`${F}?city=BOSTON`, "req-2"), t, config, mine, NOW)
    expect(again.rule.id).toBe("ITEM_BINDING")
    expect(evaluatePayment(factsFor(`${F}?city=Chicago`, "req-3"), t, config, mine, NOW).outcome).toBe("allow")
  })
})

// ---------------------------------------------------------------- sandbox

describe("ITEM_BINDING through the sandbox (real merchant, canonical URLs)", () => {
  async function buyer(setup: Omit<WorldSetup, "task">, items: ItemSpec[], mode: "guarded" | "naive" = "guarded") {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    let n = 0
    return async (url: string) => {
      const w = new World(ids, { ...setup, task: { id: "task-1", prompt: "", needs: ["weather.forecast", "translation"], budget: usd(5), items } }, mode, audit, `ep-${++n}`, undefined, store)
      const r = (await w.httpGetForAgent(url)) as { payment_request?: string; status: number }
      expect(r.payment_request, url).toBeTruthy()
      const paid = await w.pay({ paymentRequest: r.payment_request!, purpose: "the task" })
      return { paid, world: w }
    }
  }

  const allowed = [
    "http://skycast.test/forecast?city=Boston",
    "http://SKYCAST.test/Forecast?City=BOSTON",
    "http://skycast.test/forecast/?city=Bost%6Fn",
    "http://skycast.test/forecast?utm_source=mail&city=Boston", // tracking parameters are dropped before the merchant sees the URL
    "skycast.test/forecast?city=boston#top",
  ]
  for (const url of allowed) {
    it(`allows the declared forecast via ${url}`, async () => {
      const buy = await buyer({}, [BOSTON])
      const { paid } = await buy(url)
      expect(paid.status).toBe("paid")
    })
  }

  const refused = [
    "http://skycast.test/forecast?city=Chicago",
    "http://skycast.test/forecast?city=Boston&city=Chicago",
    "http://skycast.test/forecast?city=Chicago&CITY=Boston",
    "http://skycast.test/forecast?city=Boston&days=30",
    "http://skycast.test/forecast?city=Boston%20",
    "http://skycast.test/forecast?city=Bost%D0%BEn",
    "http://skycast.test/forecast?city=Boston%2C%20Lincolnshire",
    "http://skycast.test/forecast", // the merchant would pick its default city
  ]
  for (const url of refused) {
    it(`refuses ${url}`, async () => {
      const buy = await buyer({}, [BOSTON])
      const { paid } = await buy(url)
      expect(paid.status).toBe("blocked")
      expect(paid.status === "blocked" && paid.rule).toBe("ITEM_BINDING")
    })
  }

  it("binds a translation to its text and language, in either parameter order", async () => {
    const buy = await buyer({}, [FR])
    expect((await buy("http://linguabridge.test/translate?to=es&text=the%20meeting%20is%20at%20noon")).paid.status).toBe("blocked")
    expect((await buy("http://linguabridge.test/translate?text=the%20meeting%20is%20at%20midnight&to=fr")).paid.status).toBe("blocked")
    expect((await buy("http://linguabridge.test/translate?to=FR&text=the+meeting+is+at+noon")).paid.status).toBe("paid")
  })

  it("a merchant redirect to another city is judged on the URL that sent the bill", async () => {
    const redirect = (path: string, q: URLSearchParams) => (path === "/forecast" && q.get("city")?.toLowerCase() === "boston" ? "http://skycast.test/forecast?city=Chicago" : undefined)
    for (const mode of ["naive", "guarded"] as const) {
      const ids = await testIdentities()
      const audit = await tmpAudit(ids)
      const w = new World(ids, { behaviors: { skycast: { redirect } }, task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(1), items: [BOSTON] } }, mode, audit, `redirect-${mode}`)
      const first = await w.httpGet("http://skycast.test/forecast?city=Boston")
      expect(first.status).toBe(302)
      // The sandbox never follows a redirect on its own; the agent has to fetch the new URL, which then bills for Chicago.
      const moved = (first.body as { moved: string }).moved
      const r = (await w.httpGetForAgent(moved)) as { payment_request?: string }
      const paid = await w.pay({ paymentRequest: r.payment_request!, purpose: "Boston forecast" })
      if (mode === "naive") expect(paid.status).toBe("paid")
      else {
        expect(paid.status).toBe("blocked")
        expect(paid.status === "blocked" && paid.rule).toBe("ITEM_BINDING")
      }
    }
  })

  it("the decision, with the ITEM_BINDING check, is in the signed log", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(1), items: [BOSTON] } }, "guarded", audit, "logged")
    const r = (await w.httpGetForAgent("http://skycast.test/forecast?city=Miami")) as { payment_request?: string }
    await w.pay({ paymentRequest: r.payment_request!, purpose: "forecast" })
    const { readEntries, verifyLog } = await import("../src/audit/verify.js")
    const decision = readEntries(audit.path).entries.find((e) => e?.kind === "decision")
    const d = decision!.payload.decision as { rule: { id: string }; checks: { id: string; passed: boolean }[] }
    expect(d.rule.id).toBe("ITEM_BINDING")
    expect(d.checks.find((c) => c.id === "ITEM_BINDING")?.passed).toBe(false)
    expect((await verifyLog(audit.path, { expectedSignerDid: ids.parties.guard.did })).ok).toBe(true)
  })
})

// ---------------------------------------------------------------- properties

const names = fc.constantFrom("city", "City", "CITY", "%63ity", "days", "units", "utm_source", "c1ty")
const values = fc.constantFrom("Boston", "boston", "BOSTON", "Bost%6Fn", "Bost%D0%BEn", "Boston%20", "%20Boston", "Chicago", "Miami", "", "Boston%2C%20MA", "Boston&city=Chicago")
const queries = fc.array(fc.tuple(names, values), { maxLength: 4 }).map((ps) => ps.map(([k, v]) => `${k}=${v}`).join("&"))

describe("ITEM_BINDING properties", () => {
  it("whatever the URL, an allowed forecast is the item the merchant will serve: exactly one city, and it is Boston", () => {
    fc.assert(
      fc.property(queries, (q) => {
        const url = normalizeUrl(`http://skycast.test/forecast?${q}`)
        const d = evaluatePayment(factsFor(url), taskWith([BOSTON]), config, { payments: [] }, NOW)
        // What the merchant reads (src/merchants/catalog.ts): searchParams.get("city"), with every other parameter ignored.
        const served = new URL(url).searchParams
        const onlyBoston = [...served.keys()].length === 1 && served.getAll("city").length === 1 && served.get("city")!.toLowerCase() === "boston"
        expect(d.outcome === "allow").toBe(onlyBoston)
      }),
      { numRuns: 2000 },
    )
  })

  it("over any sequence of purchases, a task never buys an item more often than it lists it", () => {
    const cities = fc.constantFrom("Boston", "boston", "Chicago", "CHICAGO", "Miami", "Denver")
    fc.assert(
      fc.property(fc.array(cities, { minLength: 1, maxLength: 8 }), fc.boolean(), (seq, twice) => {
        const items = twice ? [BOSTON, BOSTON, CHICAGO] : [BOSTON, CHICAGO]
        const t = taskWith(items, items.map(() => "weather.forecast"))
        const history: SpendHistory = { payments: [] }
        seq.forEach((city, i) => {
          const url = normalizeUrl(`${F}?city=${city}`)
          const d = evaluatePayment(factsFor(url, `req-${i}`), t, config, history, NOW)
          if (d.outcome === "allow") history.payments.push({ ts: NOW, amount: 25n, taskId: "t", url, paymentRequestId: `req-${i}`, merchantDid: SKY, capability: "weather.forecast" })
        })
        const bought = history.payments.map((p) => new URL(p.url!).searchParams.get("city")!.toLowerCase())
        expect(bought.filter((c) => c === "boston").length).toBeLessThanOrEqual(twice ? 2 : 1)
        expect(bought.filter((c) => c === "chicago").length).toBeLessThanOrEqual(1)
        expect(bought.every((c) => c === "boston" || c === "chicago")).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })
})
