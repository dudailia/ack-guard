import { amountInflation } from "./attacks/amount-inflation.js"
import { duplicateCharge } from "./attacks/duplicate-charge.js"
import { fakeInvoice } from "./attacks/fake-invoice.js"
import { hiddenInstructions } from "./attacks/hidden-instructions.js"
import { impersonation } from "./attacks/impersonation.js"
import { recipientSwap } from "./attacks/recipient-swap.js"
import { splitEvasion } from "./attacks/split-evasion.js"
import { benign } from "./benign.js"
import type { Scenario } from "./types.js"

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

export function selectScenarios(only?: string): Scenario[] {
  if (!only) return ALL_SCENARIOS
  const keys = only.split(",").map((s) => s.trim())
  return ALL_SCENARIOS.filter((s) => keys.some((k) => s.id === k || s.category === k || s.id.startsWith(k)))
}
