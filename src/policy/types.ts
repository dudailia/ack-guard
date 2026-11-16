export type Outcome = "allow" | "deny" | "needs_approval"

export type RuleId =
  | "REQ_SIGNATURE"
  | "AGENT_IDENTITY"
  | "REQ_PROVENANCE"
  | "MERCHANT_ALLOWLIST"
  | "RECIPIENT_BINDING"
  | "PRICE_BINDING"
  | "PURPOSE_BINDING"
  | "DUPLICATE_CHARGE"
  | "PER_PAYMENT_CAP"
  | "TASK_BUDGET"
  | "DAILY_CAP"
  | "HUMAN_APPROVAL"

export interface RuleResult {
  id: RuleId
  title: string
  /** true = passed, false = failed, null = not evaluated (missing prerequisite facts) */
  passed: boolean | null
  /** What happens when this rule fails. */
  onFail: Exclude<Outcome, "allow">
  detail: string
  /** Switched off by the policy: recorded, but it cannot decide the outcome. */
  disabled?: boolean
}

export interface Decision {
  outcome: Outcome
  /** The rule that decided the outcome. ALL_RULES_PASSED when allowed. */
  rule: { id: RuleId | "ALL_RULES_PASSED"; title: string; detail: string }
  checks: RuleResult[]
  /** Matched registry entries, for audit. */
  merchant?: string
  endpoint?: string
  amount?: string
}

export interface RegisteredEndpoint {
  path: string
  capability: string
  price: bigint
  currency: string
  decimals: number
}

export interface RegisteredMerchant {
  key: string
  displayName: string
  did: string
  hosts: string[]
  recipient: string
  endpoints: RegisteredEndpoint[]
}

export interface PolicyConfig {
  ownerDid: string
  agentDid: string
  merchants: RegisteredMerchant[]
  limits: {
    perPaymentCap: bigint
    approvalThreshold: bigint
    dailyCap: bigint
    duplicateWindowMs: number
  }
  /** Per-rule settings from policy.yaml. Absent means every rule on, with its default outcome. */
  rules?: Partial<Record<RuleId, { enabled: boolean; onFail: Exclude<Outcome, "allow"> }>>
  /** Which policy document this config came from (policy.yaml version and hash). */
  policyVersion?: string
  policyHash?: string
}

/** Set by the task author (the human), never by the LLM. */
export interface TaskSpec {
  id: string
  prompt: string
  /** Capabilities this task is allowed to pay for, e.g. ["weather.forecast"]. */
  needs: string[]
  /** Maximum total spend for this task, in cents. */
  budget: bigint
}

export interface PaymentOptionFacts {
  id: string
  amount: bigint
  decimals: number
  currency: string
  recipient: string
}

/** Everything the guard verified before asking the engine. Produced outside the LLM. */
export interface PaymentFacts {
  requestSignature: { ok: boolean; issuer?: string; requestId?: string; description?: string; error?: string }
  option?: PaymentOptionFacts
  identity: { ok: boolean; agentDid?: string; controller?: string; error?: string }
  /** Did this payment request arrive as a 402 response to a URL the agent called in this task? */
  provenance: { ok: boolean; url?: string; host?: string; path?: string; detail?: string }
  /** Free text from the agent. Recorded for audit, never used to decide. */
  agentPurpose: string
  /** A human approval for this exact payment request, if one was granted. */
  approval?: { approved: boolean; by: string }
}

export interface PaidRecord {
  ts: number
  amount: bigint
  taskId: string
  url?: string
  paymentRequestId: string
  merchantDid: string
  /** The registered capability bought, when the endpoint is registered. */
  capability?: string
}

export interface SpendHistory {
  payments: PaidRecord[]
}
