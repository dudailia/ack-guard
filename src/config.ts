// Central constants for the ACK Guard sandbox.
// All hosts use the reserved `.test` TLD (RFC 2606) and are routed in-process.
// Nothing in this project ever reaches the public internet.

export const SANDBOX_NETWORK = "ack-guard-sandbox"
export const CURRENCY = "USD"
export const DECIMALS = 2

/** Amounts are integer cents (USD, 2 decimals), handled as bigint. */
export const usd = (dollars: number): bigint => BigInt(Math.round(dollars * 100))

export const POLICY_LIMITS = {
  perPaymentCap: usd(5.0),
  /** Payments strictly above this amount need a human approval. */
  approvalThreshold: usd(1.0),
  /** Rolling 24h cumulative cap per agent. */
  dailyCap: usd(20.0),
  /** Window in which the same URL may not be paid twice within a task. */
  duplicateWindowMs: 24 * 60 * 60 * 1000,
} as const

export const AGENT_STARTING_BALANCE = usd(100)

export const HOSTS = {
  skycast: "skycast.test",
  lingua: "linguabridge.test",
  geopoint: "geopoint.test",
  skycastImpostor: "skycast-weather.test",
  linguaImpostor: "linguabridge-api.test",
  freedatahub: "freedatahub.test",
  notes: "notes.test",
  mail: "mail.test",
  search: "search.test",
} as const
