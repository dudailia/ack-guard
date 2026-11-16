// Deterministic payment policy engine. Pure function, no I/O, no LLM.
//
// Every rule is evaluated and reported. The decision is made by the FIRST
// failing rule in a fixed order (deny rules first, human approval last), and
// that rule's id is returned as the reason. If nothing fails, the payment is
// allowed.
//
// Starting point: Catena's "policy-before-signing" example in
// agentcommercekit/ack demos/payments/src/payment-policy.ts (MIT), which
// checks a recipient allowlist and a per-transaction cap and notes that a real
// spend control needs cumulative limits. This engine extends that pattern with
// provenance, identity, price, purpose, duplicate, task-budget and rolling
// daily-cap rules.

import { formatAmount } from "../money.js"
import type {
  Decision,
  PaidRecord,
  PaymentFacts,
  PolicyConfig,
  RegisteredEndpoint,
  RegisteredMerchant,
  RuleId,
  RuleResult,
  SpendHistory,
  TaskSpec,
} from "./types.js"

export const RULE_TITLES: Record<RuleId, string> = {
  REQ_SIGNATURE: "Payment request is a validly signed ACK-Pay token",
  AGENT_IDENTITY: "Agent holds a valid ACK-ID ControllerCredential from its owner",
  REQ_PROVENANCE: "Payment request came from a 402 response to a URL the agent called",
  MERCHANT_ALLOWLIST: "Signer DID is an allowlisted merchant serving from its own host",
  RECIPIENT_BINDING: "Recipient is the merchant's registered payout account",
  PRICE_BINDING: "Amount and currency match the registered price for the endpoint",
  PURPOSE_BINDING: "Endpoint capability is one the task declared it needs",
  DUPLICATE_CHARGE: "Not a repeat purchase: same request, or more of a capability from one merchant than the task asked for",
  PER_PAYMENT_CAP: "Amount is within the per-payment cap",
  TASK_BUDGET: "Cumulative task spend stays within the task budget",
  DAILY_CAP: "Rolling 24h spend stays within the daily cap",
  HUMAN_APPROVAL: "Payments above the approval threshold need a human",
}

export const RULE_ORDER: RuleId[] = [
  "REQ_SIGNATURE",
  "AGENT_IDENTITY",
  "REQ_PROVENANCE",
  "MERCHANT_ALLOWLIST",
  "RECIPIENT_BINDING",
  "PRICE_BINDING",
  "PURPOSE_BINDING",
  "DUPLICATE_CHARGE",
  "PER_PAYMENT_CAP",
  "TASK_BUDGET",
  "DAILY_CAP",
  "HUMAN_APPROVAL",
]

/** The registered capability behind a merchant's endpoint, if any (used to record what was bought). */
export function capabilityFor(config: PolicyConfig, merchantDid: string | undefined, path: string | undefined): string | undefined {
  const m = config.merchants.find((x) => x.did === merchantDid)
  return m?.endpoints.find((e) => e.path === path)?.capability
}

export function evaluatePayment(
  facts: PaymentFacts,
  task: TaskSpec,
  config: PolicyConfig,
  history: SpendHistory,
  now: number,
): Decision {
  const checks: RuleResult[] = []
  const add = (id: RuleId, passed: boolean | null, detail: string, onFail: "deny" | "needs_approval" = "deny") =>
    checks.push({ id, title: RULE_TITLES[id], passed, onFail, detail })

  const opt = facts.option
  const amount = opt?.amount

  // 1. Signature
  add(
    "REQ_SIGNATURE",
    facts.requestSignature.ok && !!opt,
    facts.requestSignature.ok
      ? opt
        ? `signed by ${facts.requestSignature.issuer}`
        : "payment option not found in the signed request"
      : `invalid payment request token: ${facts.requestSignature.error ?? "unknown error"}`,
  )

  // 2. Identity
  add(
    "AGENT_IDENTITY",
    facts.identity.ok && facts.identity.agentDid === config.agentDid && facts.identity.controller === config.ownerDid,
    facts.identity.ok
      ? `agent ${facts.identity.agentDid} controlled by ${facts.identity.controller}`
      : `identity check failed: ${facts.identity.error ?? "unknown"}`,
  )

  // 3. Provenance
  add(
    "REQ_PROVENANCE",
    facts.provenance.ok,
    facts.provenance.ok
      ? `returned with HTTP 402 by ${facts.provenance.url}`
      : (facts.provenance.detail ?? "token was not returned by any 402 response the agent received in this task"),
  )

  // 4. Merchant allowlist (by DID, and the serving host must belong to that merchant)
  let merchant: RegisteredMerchant | undefined
  const issuer = facts.requestSignature.issuer
  if (!facts.requestSignature.ok || !issuer) {
    add("MERCHANT_ALLOWLIST", null, "no verified signer")
  } else {
    merchant = config.merchants.find((m) => m.did === issuer)
    if (!merchant) {
      add("MERCHANT_ALLOWLIST", false, `signer ${issuer} is not an allowlisted merchant`)
    } else if (facts.provenance.ok && facts.provenance.host && !merchant.hosts.includes(facts.provenance.host)) {
      add(
        "MERCHANT_ALLOWLIST",
        false,
        `${merchant.displayName}'s token was served by ${facts.provenance.host}, which is not a registered host for that merchant`,
      )
      merchant = undefined
    } else {
      add("MERCHANT_ALLOWLIST", true, `${merchant.displayName} (${merchant.did})`)
    }
  }

  // 5. Recipient binding
  if (!merchant || !opt) add("RECIPIENT_BINDING", null, "requires an allowlisted merchant")
  else
    add(
      "RECIPIENT_BINDING",
      opt.recipient === merchant.recipient,
      opt.recipient === merchant.recipient
        ? "recipient matches registered payout account"
        : `recipient ${opt.recipient} is not ${merchant.displayName}'s registered account ${merchant.recipient}`,
    )

  // 6. Price binding
  let endpoint: RegisteredEndpoint | undefined
  if (!merchant || !opt || !facts.provenance.ok) add("PRICE_BINDING", null, "requires an allowlisted merchant and provenance")
  else {
    endpoint = merchant.endpoints.find((e) => e.path === facts.provenance.path)
    if (!endpoint) add("PRICE_BINDING", false, `endpoint ${facts.provenance.path} is not registered for ${merchant.displayName}`)
    else {
      const ok = opt.amount === endpoint.price && opt.currency === endpoint.currency && opt.decimals === endpoint.decimals
      add(
        "PRICE_BINDING",
        ok,
        ok
          ? `${formatAmount(opt.amount, opt.decimals, opt.currency)} matches registered price`
          : `requested ${formatAmount(opt.amount, opt.decimals, opt.currency)} but registered price for ${endpoint.path} is ${formatAmount(endpoint.price, endpoint.decimals, endpoint.currency)}`,
      )
    }
  }

  // 7. Purpose binding (task needs are set by the human, not the LLM)
  if (!endpoint) add("PURPOSE_BINDING", null, "requires a registered endpoint")
  else
    add(
      "PURPOSE_BINDING",
      task.needs.includes(endpoint.capability),
      task.needs.includes(endpoint.capability)
        ? `capability ${endpoint.capability} is declared by the task`
        : `capability ${endpoint.capability} is not among the task's declared needs [${task.needs.join(", ")}]`,
    )

  // 8. Duplicate charge. Keyed on what is bought, not on the URL: the
  // merchant DID, the registered capability and the task. A task that needs a
  // capability more than once lists it that many times in its needs.
  if (!facts.requestSignature.ok) add("DUPLICATE_CHARGE", null, "no verified request")
  else {
    const reqId = facts.requestSignature.requestId
    const sameRequest = history.payments.find((p) => p.paymentRequestId === reqId)
    const inWindow = (p: PaidRecord) => p.taskId === task.id && p.merchantDid === issuer && now - p.ts <= config.limits.duplicateWindowMs
    let detail: string
    let repeat = false
    if (sameRequest) {
      repeat = true
      detail = `payment request ${reqId} was already paid`
    } else if (endpoint) {
      const cap = endpoint.capability
      const allowed = Math.max(1, task.needs.filter((n) => n === cap).length)
      // Records without a capability (older history) still match on the URL.
      const bought = history.payments.filter(
        (p) => inWindow(p) && (p.capability ? p.capability === cap : !!facts.provenance.url && p.url === facts.provenance.url),
      ).length
      repeat = bought >= allowed
      detail = repeat
        ? `${cap} from ${merchant?.displayName ?? issuer} was already bought ${bought} time(s) in this task; the task asks for ${allowed}`
        : `${cap} purchase ${bought + 1} of ${allowed} the task asks for`
    } else {
      const sameUrl = !!facts.provenance.url && history.payments.some((p) => inWindow(p) && p.url === facts.provenance.url)
      repeat = sameUrl
      detail = sameUrl ? `${facts.provenance.url} was already paid in this task` : "no prior payment for this request or URL"
    }
    add("DUPLICATE_CHARGE", !repeat, detail)
  }

  // 9-11. Amount limits
  if (amount === undefined) {
    add("PER_PAYMENT_CAP", null, "no amount")
    add("TASK_BUDGET", null, "no amount")
    add("DAILY_CAP", null, "no amount")
    add("HUMAN_APPROVAL", null, "no amount", "needs_approval")
  } else {
    const cap = config.limits.perPaymentCap
    add(
      "PER_PAYMENT_CAP",
      amount <= cap,
      `${formatAmount(amount)} ${amount <= cap ? "<=" : ">"} cap ${formatAmount(cap)}`,
    )
    const taskSpent = history.payments.filter((p) => p.taskId === task.id).reduce((a, p) => a + p.amount, 0n)
    add(
      "TASK_BUDGET",
      taskSpent + amount <= task.budget,
      `task spent ${formatAmount(taskSpent)} + ${formatAmount(amount)} ${taskSpent + amount <= task.budget ? "<=" : ">"} budget ${formatAmount(task.budget)}`,
    )
    const daySpent = history.payments.filter((p) => now - p.ts < 24 * 3600 * 1000).reduce((a, p) => a + p.amount, 0n)
    const dc = config.limits.dailyCap
    add(
      "DAILY_CAP",
      daySpent + amount <= dc,
      `24h spent ${formatAmount(daySpent)} + ${formatAmount(amount)} ${daySpent + amount <= dc ? "<=" : ">"} daily cap ${formatAmount(dc)}`,
    )
    const th = config.limits.approvalThreshold
    const needsHuman = amount > th
    const approved = facts.approval?.approved === true
    add(
      "HUMAN_APPROVAL",
      !needsHuman || approved,
      !needsHuman
        ? `${formatAmount(amount)} <= approval threshold ${formatAmount(th)}`
        : approved
          ? `approved by ${facts.approval?.by}`
          : `${formatAmount(amount)} > approval threshold ${formatAmount(th)}: human approval required`,
      "needs_approval",
    )
  }

  // Decide: first failing rule wins. A rule that could not be evaluated (null)
  // counts as a failure only if no earlier rule failed (fail closed).
  const firstFail = checks.find((c) => c.passed !== true)
  const base = { checks, merchant: merchant?.displayName, endpoint: endpoint?.path, amount: amount?.toString() }
  if (!firstFail) {
    return {
      ...base,
      outcome: "allow",
      rule: { id: "ALL_RULES_PASSED", title: "All rules passed", detail: `${checks.length} of ${checks.length} rules passed` },
    }
  }
  return {
    ...base,
    outcome: firstFail.onFail,
    rule: { id: firstFail.id, title: firstFail.title, detail: firstFail.detail },
  }
}
