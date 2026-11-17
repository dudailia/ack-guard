import { amountInflation } from "./attacks/amount-inflation.js"
import { duplicateCharge } from "./attacks/duplicate-charge.js"
import { fakeInvoice } from "./attacks/fake-invoice.js"
import { hiddenInstructions } from "./attacks/hidden-instructions.js"
import { impersonation } from "./attacks/impersonation.js"
import { recipientSwap } from "./attacks/recipient-swap.js"
import { splitEvasion } from "./attacks/split-evasion.js"
import { benign } from "./benign.js"
import { DELEGATION_SCENARIOS } from "./delegation.js"
import type { Scenario } from "./types.js"
import { WRONG_CITY_SCENARIOS } from "./wrong-city.js"

export const ATTACKS: Scenario[] = [
  ...fakeInvoice,
  ...recipientSwap,
  ...amountInflation,
  ...duplicateCharge,
  ...impersonation,
  ...splitEvasion,
  ...hiddenInstructions,
]

export const BENIGN: Scenario[] = benign
export const ALL_SCENARIOS: Scenario[] = [...ATTACKS, ...BENIGN]

/** The delegation suite (sub-agents), run and reported separately from the main benchmark. */
export { DELEGATION_SCENARIOS }
/** The wrong-city suite (right item type, wrong parameters), run and reported separately. */
export { WRONG_CITY_SCENARIOS }
/** Every scenario any recorded run may refer to (for verification and replay). */
export const KNOWN_SCENARIOS: Scenario[] = [...ALL_SCENARIOS, ...DELEGATION_SCENARIOS, ...WRONG_CITY_SCENARIOS]

export type Suite = "main" | "delegation" | "wrong-city"
export const SUITES: Suite[] = ["main", "delegation", "wrong-city"]

export function selectScenarios(only?: string, suite: Suite = "main"): Scenario[] {
  const pool = suite === "delegation" ? DELEGATION_SCENARIOS : suite === "wrong-city" ? WRONG_CITY_SCENARIOS : ALL_SCENARIOS
  if (!only) return pool
  const keys = only.split(",").map((s) => s.trim())
  return pool.filter((s) => keys.some((k) => s.id === k || s.category === k || s.id.startsWith(k)))
}
