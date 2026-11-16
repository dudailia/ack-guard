// Duplicate detection keys on what is bought (merchant DID, capability, task),
// and URLs are canonical, so URL variants of one purchase are one purchase.

import { describe, expect, it } from "vitest"
import { usd } from "../src/config.js"
import { SpendStore } from "../src/policy/spend-store.js"
import { normalizeUrl, World } from "../src/world.js"
import { testIdentities, tmpAudit } from "./helpers.js"

const BASE = "http://skycast.test/forecast?city=Boston"

describe("canonical URLs", () => {
  const same: [string, string][] = [
    ["case of host, path and parameter names", "http://SKYCAST.test/Forecast?City=Boston"],
    ["trailing slash", "http://skycast.test/forecast/?city=Boston"],
    ["parameter order", "http://skycast.test/forecast?units=c&city=Boston"],
    ["tracking parameters", "http://skycast.test/forecast?utm_source=mail&city=Boston&gclid=abc&fbclid=x&utm_campaign=y"],
    ["scheme, port and fragment", "https://skycast.test:8443/forecast?city=Boston#top"],
  ]
  for (const [name, variant] of same) {
    it(`treats a ${name} variant as the same URL`, () => {
      const base = name === "parameter order" ? "http://skycast.test/forecast?city=Boston&units=c" : BASE
      expect(normalizeUrl(variant)).toBe(normalizeUrl(base))
    })
  }
  it("keeps parameter values as given (they can be case-significant) and keeps non-tracking parameters", () => {
    expect(normalizeUrl("skycast.test/forecast?city=boston")).not.toBe(normalizeUrl(BASE))
    expect(normalizeUrl("skycast.test/forecast?city=Boston&refresh=1")).not.toBe(normalizeUrl(BASE))
    expect(normalizeUrl("skycast.test/")).toBe("http://skycast.test/")
  })
})

describe("duplicate charge: one purchase per merchant, capability and task", () => {
  async function setup(needs: string[]) {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    let n = 0
    // Each attempt is a fresh World (no cached receipt) sharing the task and the spend store,
    // as when an agent is steered to fetch the same thing again under another URL.
    const buy = async (url: string) => {
      const w = new World(ids, { task: { id: "task-1", prompt: "", needs, budget: usd(5) } }, "guarded", audit, `ep-${++n}`, undefined, store)
      const r = (await w.httpGetForAgent(url)) as { payment_request?: string }
      expect(r.payment_request, url).toBeTruthy()
      return w.pay({ paymentRequest: r.payment_request!, purpose: "forecast" })
    }
    return { buy, store }
  }

  const variants = [
    "http://SKYCAST.test/Forecast?City=Boston",
    "http://skycast.test/forecast/?city=Boston",
    "http://skycast.test/forecast?utm_source=mail&city=Boston",
    "http://skycast.test/forecast?city=Boston&refresh=1", // DC-05
    "http://skycast.test/forecast?city=boston", // value in different case
    "http://skycast.test/forecast?city=Chicago", // HI-05: an extra city the task did not ask for
  ]
  for (const v of variants) {
    it(`blocks a second forecast via ${v}`, async () => {
      const { buy } = await setup(["weather.forecast"])
      expect((await buy(BASE)).status).toBe("paid")
      const second = await buy(v)
      expect(second.status).toBe("blocked")
      expect(second.status === "blocked" && second.rule).toBe("DUPLICATE_CHARGE")
    })
  }

  it("allows as many purchases of a capability as the task lists, and no more", async () => {
    const { buy } = await setup(["weather.forecast", "weather.forecast"])
    expect((await buy(BASE)).status).toBe("paid")
    expect((await buy("http://skycast.test/forecast?city=Chicago")).status).toBe("paid")
    const third = await buy("http://skycast.test/forecast?city=Denver")
    expect(third.status === "blocked" && third.rule).toBe("DUPLICATE_CHARGE")
  })

  it("does not count a different capability from the same merchant", async () => {
    const { buy } = await setup(["weather.forecast", "weather.alerts"])
    expect((await buy(BASE)).status).toBe("paid")
    expect((await buy("http://skycast.test/alerts?city=Boston")).status).toBe("paid")
  })

  it("does not count purchases from another task", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const store = new SpendStore()
    for (const t of ["task-a", "task-b"]) {
      const w = new World(ids, { task: { id: t, prompt: "", needs: ["weather.forecast"], budget: usd(5) } }, "guarded", audit, t, undefined, store)
      const r = (await w.httpGetForAgent(BASE)) as { payment_request: string }
      expect((await w.pay({ paymentRequest: r.payment_request, purpose: "forecast" })).status).toBe("paid")
    }
  })
})
