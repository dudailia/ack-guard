// A World is one isolated episode: a fresh sandbox network, ledger, merchants,
// receipt service and spend history, shared identities, and a payment path
// that is either naive (pay whatever the agent asks) or guarded (policy first).
//
// The ONLY difference between naive and guarded is inside `pay()`.

import { verifyPaymentRequestToken, type JwtString } from "agentcommercekit"
import { Hono } from "hono"
import { AGENT_STARTING_BALANCE, HOSTS } from "./config.js"
import type { AuditLog } from "./audit/chain.js"
import { verifyDelegationChain } from "./identity/delegation.js"
import type { Identities, PartyName } from "./identity/identities.js"
import { verifyAgentIdentity } from "./identity/verify-identity.js"
import { SandboxLedger } from "./ledger/sandbox-ledger.js"
import { merchantSpecs, type MerchantKey } from "./merchants/catalog.js"
import { createMerchantApp, type MerchantBehavior, type MerchantStats } from "./merchants/framework.js"
import { formatAmount, parseSubunits } from "./money.js"
import { buildPolicyConfig } from "./policy/config.js"
import { capabilityFor, evaluatePayment } from "./policy/engine.js"
import { SpendStore } from "./policy/spend-store.js"
import type { Decision, PaymentFacts, PolicyConfig, SpendHistory, TaskSpec } from "./policy/types.js"
import { checkReceipt, ReceiptService } from "./receipts/receipt-service.js"
import { SandboxNet } from "./sandbox/net.js"

export type Mode = "naive" | "guarded"

export interface Page {
  body: string
  contentType?: string
}

export interface WorldSetup {
  task: TaskSpec
  /** Content hosts (notes.test, mail.test, search.test, ...) -> path -> page */
  pages?: Record<string, Record<string, Page>>
  behaviors?: Partial<Record<MerchantKey, MerchantBehavior>>
  /** Prior spend today (for daily-cap scenarios). */
  priorSpend?: { amount: bigint; hoursAgo: number }[]
  /** The policy in force; the repository policy.yaml when absent. */
  policy?: PolicyConfig
  /**
   * A sub-agent pays through a delegation chain (root first: owner -> agent ->
   * ... -> payer). Without it the research agent pays with its own
   * ControllerCredential, as in the main benchmark.
   */
  delegation?: {
    payer: PartyName
    chain: string[]
    /** The payer's legitimate limits, root first, for scoring only (never read by the guard). */
    limits?: { budget: bigint; capabilities: string[] }[]
  }
}

export type Approver = (ctx: { decision: Decision; facts: PaymentFacts; task: TaskSpec }) => Promise<{ approved: boolean; by: string }>

export const denyAllApprover: Approver = async () => ({ approved: false, by: "scripted-approver (deny by default)" })

export interface PayInput {
  /** A short reference such as "pr_1" (assigned by the HTTP tool) or a raw ACK payment request token. */
  paymentRequest: string
  paymentOptionId?: string
  purpose: string
  /** Delegation scenarios only: a credential reference (cred_N) to pay under instead of the payer's own link. */
  credential?: string
}

export type PayResult =
  | { status: "paid"; txId: string; amount: string; recipient: string; message: string }
  | { status: "blocked"; rule: string; reason: string; message: string }
  | { status: "escalated_denied"; rule: string; reason: string; message: string }
  | { status: "error"; message: string }

interface Seen402 {
  url: string
  host: string
  path: string
}

export class World {
  readonly net = new SandboxNet()
  readonly ledger = new SandboxLedger()
  readonly receipts: ReceiptService
  readonly policy: PolicyConfig
  readonly merchantStats: Record<string, MerchantStats> = {}
  /** Payment request tokens the agent received in 402 responses, keyed by token. */
  private seen402 = new Map<string, Seen402>()
  /** Receipts obtained, keyed by URL, auto-attached on the next GET (like an x402 client). */
  private receiptsByUrl = new Map<string, string>()
  /** Short references for payment request tokens seen anywhere (pr_1, pr_2, ...). Same for both modes. */
  private refToToken = new Map<string, string>()
  private tokenToRef = new Map<string, string>()
  attemptCounter = 0
  readonly outcomes: { attemptId: string; result: PayResult; decision?: Decision }[] = []

  constructor(
    readonly ids: Identities,
    readonly setup: WorldSetup,
    readonly mode: Mode,
    readonly audit: AuditLog,
    readonly episodeId: string,
    readonly approver: Approver = denyAllApprover,
    /** Shared spend history and payment lock. A fresh one per World unless the caller shares one. */
    readonly spend: SpendStore = new SpendStore(),
  ) {
    this.receipts = new ReceiptService(ids.parties.receipts, this.ledger, ids.resolver)
    this.policy = setup.policy ?? buildPolicyConfig(ids)
    this.ledger.fund(ids.parties.agent.did, AGENT_STARTING_BALANCE)
    const now = Date.now()
    for (const p of setup.priorSpend ?? []) {
      this.spend.history.payments.push({
        ts: now - p.hoursAgo * 3600 * 1000,
        amount: p.amount,
        taskId: "earlier-task",
        paymentRequestId: `prior-${crypto.randomUUID()}`,
        merchantDid: ids.parties.lingua.did,
      })
    }
    const specs = merchantSpecs(ids, setup.behaviors)
    for (const spec of Object.values(specs)) {
      const m = createMerchantApp(spec, { resolver: ids.resolver, receiptIssuerDid: this.receipts.did })
      this.merchantStats[spec.key] = m.stats
      this.net.register(spec.host, m.app.fetch)
    }
    for (const [host, pages] of Object.entries(setup.pages ?? {})) {
      const app = new Hono()
      app.get("*", (c) => {
        const page = pages[new URL(c.req.url).pathname]
        if (!page) return c.json({ error: "not found" }, 404)
        return c.body(page.body, 200, { "content-type": page.contentType ?? "text/html; charset=utf-8" })
      })
      this.net.register(host, app.fetch)
    }
    // Hosts that exist in the catalog but have no pages still resolve (empty sites).
    for (const h of [HOSTS.notes, HOSTS.mail, HOSTS.search]) {
      if (!this.net.has(h)) {
        const app = new Hono()
        app.get("*", (c) => c.json({ error: "not found" }, 404))
        this.net.register(h, app.fetch)
      }
    }
  }

  get task() {
    return this.setup.task
  }

  get history(): SpendHistory {
    return this.spend.history
  }

  /** HTTP GET through the sandbox, presenting ACK-ID and any receipt held for this URL. */
  async httpGet(rawUrl: string): Promise<{ status: number; url: string; body: unknown }> {
    let url: string
    try {
      url = normalizeUrl(rawUrl)
    } catch (e) {
      return { status: 400, url: rawUrl, body: { error: (e as Error).message } }
    }
    const headers: Record<string, string> = { "x-ack-controller-credential": this.presentedCredential }
    const receipt = this.receiptsByUrl.get(url)
    if (receipt) headers.authorization = `Bearer ${receipt}`
    const res = await this.net.fetch(url, { headers })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      /* keep text */
    }
    if (res.status === 402 && body && typeof body === "object") {
      const token = (body as { paymentRequestToken?: string }).paymentRequestToken
      if (token) {
        const u = new URL(url)
        this.seen402.set(token, { url, host: u.hostname, path: u.pathname })
      }
    }
    if (res.status === 200 && receipt) this.receiptsByUrl.delete(url)
    return { status: res.status, url, body }
  }

  /** The ACK-ID credential this agent presents to merchants: its own link in the chain. */
  get presentedCredential(): string {
    const d = this.setup.delegation
    return d ? d.chain[d.chain.length - 1]! : this.ids.controllerCredential
  }

  get payerDid(): string {
    const d = this.setup.delegation
    return d ? this.ids.parties[d.payer].did : this.ids.parties.agent.did
  }

  /** Short references for credentials seen in content (cred_1, ...), like pr_N for payment requests. */
  private credRefToJwt = new Map<string, string>()
  private credJwtToRef = new Map<string, string>()
  credRefFor(jwt: string): string {
    let ref = this.credJwtToRef.get(jwt)
    if (!ref) {
      ref = `cred_${this.credJwtToRef.size + 1}`
      this.credJwtToRef.set(jwt, ref)
      this.credRefToJwt.set(ref, jwt)
    }
    return ref
  }

  /** The chain a payment is made under: the payer's own, or with its last link swapped for a credential the agent chose. */
  chainFor(input: PayInput): string[] | undefined {
    const d = this.setup.delegation
    if (!d) return undefined
    if (!input.credential) return d.chain
    const c = input.credential.trim()
    const jwt = this.credRefToJwt.get(c) ?? c
    return [...d.chain.slice(0, -1), jwt]
  }

  refFor(token: string): string {
    let ref = this.tokenToRef.get(token)
    if (!ref) {
      ref = `pr_${this.tokenToRef.size + 1}`
      this.tokenToRef.set(token, ref)
      this.refToToken.set(ref, token)
    }
    return ref
  }

  resolvePaymentRequest(refOrToken: string): string {
    const t = refOrToken.trim()
    return this.refToToken.get(t) ?? t
  }

  /** What the agent's http_get tool returns: payment request tokens are replaced by short references. */
  async httpGetForAgent(url: string) {
    return renderHttpForAgent(await this.httpGet(url), this)
  }

  /**
   * Payments are serialized through the spend store: the AI SDK can run
   * several tool calls from one model step concurrently, and every decision
   * must see every earlier payment (duplicate, budget and daily-cap rules),
   * including payments made by other episodes that share the store.
   */
  async pay(raw: PayInput): Promise<PayResult> {
    const attemptId = `${this.episodeId}#${++this.attemptCounter}`
    const base = { episodeId: this.episodeId, attemptId, mode: this.mode }
    const token = this.resolvePaymentRequest(raw.paymentRequest)
    const input = { ...raw, paymentRequest: token }
    await this.audit.append("payment_attempt", {
      ...base,
      paymentRequestRef: this.tokenToRef.get(token) ?? null,
      paymentRequestToken: token,
      paymentOptionId: input.paymentOptionId ?? null,
      agentPurpose: input.purpose,
      // The exact chain this payment is made under (JWTs), so anyone can re-verify it from the log.
      ...(this.setup.delegation ? { payer: this.payerDid, credentialRef: input.credential ?? null, delegationChain: this.chainFor(input) } : {}),
    })
    const first = await this.spend.run(() => this.decideAndSettle(input, base))
    if (first.kind === "done") return first.result

    // A human is needed. Wait OUTSIDE the payment lock, so one pending approval
    // never stalls the agent's other payments, then decide again from scratch
    // inside the lock with the approval as a fact (history may have changed).
    const approval = await this.approver({ decision: first.decision, facts: first.facts, task: this.task })
    await this.audit.append("approval", { ...base, ...approval })
    if (!approval.approved) {
      const result: PayResult = {
        status: "escalated_denied",
        rule: first.decision.rule.id,
        reason: first.decision.rule.detail,
        message: "A human reviewer declined this payment. Do not retry it.",
      }
      this.outcomes.push({ attemptId, result, decision: first.decision })
      return result
    }
    const second = await this.spend.run(() => this.decideAndSettle(input, base, approval))
    if (second.kind === "done") return second.result
    // Approved, yet the re-check still asks for a human: treat as declined.
    const result: PayResult = {
      status: "escalated_denied",
      rule: second.decision.rule.id,
      reason: second.decision.rule.detail,
      message: "This payment still needs approval. Do not retry it.",
    }
    this.outcomes.push({ attemptId, result, decision: second.decision })
    return result
  }

  /** Runs inside the payment lock: gather facts, decide, and settle if allowed. */
  private async decideAndSettle(
    input: PayInput,
    base: { episodeId: string; attemptId: string; mode: Mode },
    approval?: { approved: boolean; by: string },
  ): Promise<{ kind: "done"; result: PayResult } | { kind: "needs_approval"; decision: Decision; facts: PaymentFacts }> {
    const attemptId = base.attemptId
    const facts = { ...(await this.gatherFacts(input)), ...(approval ? { approval } : {}) }
    let decision: Decision | undefined
    if (this.mode === "guarded") {
      decision = evaluatePayment(facts, this.task, this.policy, this.history, Date.now())
      await this.audit.append("decision", {
        ...base,
        decision,
        facts: factsForLog(facts),
        policyVersion: this.policy.policyVersion,
        ...(approval ? { afterApproval: true } : {}),
      })
      if (decision.outcome === "needs_approval") return { kind: "needs_approval", decision, facts }
      if (decision.outcome === "deny") {
        const result: PayResult = {
          status: "blocked",
          rule: decision.rule.id,
          reason: decision.rule.detail,
          message: `Payment blocked by policy rule ${decision.rule.id}. Do not retry it.`,
        }
        this.outcomes.push({ attemptId, result, decision })
        return { kind: "done", result }
      }
    } else {
      await this.audit.append("decision", {
        ...base,
        decision: { outcome: "allow", rule: { id: "NO_GUARD", title: "Naive agent: no policy", detail: "no policy checks applied" }, checks: [] },
        facts: factsForLog(facts),
      })
    }
    return { kind: "done", result: await this.settle(input, base, facts, decision) }
  }

  private async settle(
    input: PayInput,
    base: { episodeId: string; attemptId: string; mode: Mode },
    facts: PaymentFacts,
    decision: Decision | undefined,
  ): Promise<PayResult> {
    const attemptId = base.attemptId
    // Settlement: both modes need a validly signed request with a real option.
    if (!facts.requestSignature.ok || !facts.option) {
      const result: PayResult = { status: "error", message: `Cannot pay: ${facts.requestSignature.error ?? "payment option not found"}` }
      await this.audit.append("payment_error", { ...base, error: result.message })
      this.outcomes.push({ attemptId, result, decision })
      return result
    }
    const opt = facts.option
    let tx
    try {
      tx = this.ledger.transfer({
        from: this.ids.parties.agent.did,
        to: opt.recipient,
        amount: opt.amount,
        currency: opt.currency,
        paymentRequestId: facts.requestSignature.requestId!,
        paymentOptionId: opt.id,
        url: facts.provenance.url,
      })
    } catch (e) {
      const result: PayResult = { status: "error", message: `Payment failed: ${(e as Error).message}` }
      await this.audit.append("payment_error", { ...base, error: result.message })
      this.outcomes.push({ attemptId, result, decision })
      return result
    }
    // Count the spend before anything else can fail: money has moved, so the
    // budget and daily cap must see it even if the log write below throws.
    this.spend.record({
      ts: tx.ts,
      amount: tx.amount,
      taskId: this.task.id,
      url: facts.provenance.url,
      paymentRequestId: tx.paymentRequestId,
      merchantDid: facts.requestSignature.issuer!,
      capability: capabilityFor(this.policy, facts.requestSignature.issuer, facts.provenance.path),
      ...(facts.identity.chain ? { links: facts.identity.chain.links.filter((l) => l.scope).map((l) => l.id) } : {}),
    })
    await this.audit.append("settlement", { ...base, tx: { ...tx, amount: tx.amount.toString() } })

    const receiptJwt = await this.receipts.issue({
      paymentRequestToken: input.paymentRequest,
      paymentOptionId: opt.id,
      payerDid: this.ids.parties.agent.did,
      txId: tx.txId,
    })
    const check = await checkReceipt(receiptJwt, {
      resolver: this.ids.resolver,
      trustedReceiptIssuers: [this.receipts.did],
      paymentRequestIssuer: facts.requestSignature.issuer,
    })
    await this.audit.append("receipt", { ...base, receipt: receiptJwt, receiptIssuer: this.receipts.did, verification: check })
    if (facts.provenance.url) this.receiptsByUrl.set(facts.provenance.url, receiptJwt)

    const result: PayResult = {
      status: "paid",
      txId: tx.txId,
      amount: formatAmount(tx.amount, opt.decimals, opt.currency),
      recipient: opt.recipient,
      message: facts.provenance.url
        ? `Payment complete. Call http_get on ${facts.provenance.url} again to receive the data.`
        : "Payment complete.",
    }
    this.outcomes.push({ attemptId, result, decision })
    return result
  }

  private async gatherFacts(input: PayInput): Promise<PaymentFacts> {
    const facts: PaymentFacts = {
      requestSignature: { ok: false },
      identity: { ok: false },
      provenance: { ok: false },
      agentPurpose: input.purpose,
    }
    try {
      const { paymentRequest, parsed } = await verifyPaymentRequestToken(input.paymentRequest as JwtString, {
        resolver: this.ids.resolver,
      })
      facts.requestSignature = {
        ok: true,
        issuer: parsed.issuer,
        requestId: paymentRequest.id,
        description: paymentRequest.description,
      }
      const opt =
        paymentRequest.paymentOptions.find((o) => o.id === input.paymentOptionId) ??
        (input.paymentOptionId ? undefined : paymentRequest.paymentOptions[0])
      if (opt) {
        facts.option = {
          id: opt.id,
          amount: parseSubunits(opt.amount),
          decimals: opt.decimals,
          currency: opt.currency,
          recipient: opt.recipient,
        }
      }
    } catch (e) {
      facts.requestSignature = { ok: false, error: (e as Error).message.slice(0, 200) }
    }
    // Re-verified on every payment (signature, owner, controller claim).
    const chain = this.chainFor(input)
    if (chain) {
      // Every link, every payment: signatures, expiry, controller claims, continuity from the owner to the payer.
      const v = await verifyDelegationChain(chain, {
        resolver: this.ids.resolver,
        ownerDid: this.policy.ownerDid,
        rootAgentDid: this.policy.agentDid,
        payerDid: this.payerDid,
      })
      facts.identity = {
        ok: v.ok,
        agentDid: v.links[0]?.subject,
        controller: v.links[0]?.issuer,
        error: v.error,
        chain: { payerDid: this.payerDid, links: v.links },
      }
    } else {
      // Re-verified on every payment (signature, owner, controller claim).
      facts.identity = await verifyAgentIdentity(this.ids.controllerCredential, {
        resolver: this.ids.resolver,
        expectedOwnerDid: this.policy.ownerDid,
        expectedAgentDid: this.policy.agentDid,
      })
    }
    const seen = this.seen402.get(input.paymentRequest)
    facts.provenance = seen
      ? { ok: true, ...seen }
      : { ok: false, detail: "token was not returned by any 402 response the agent received in this task (e.g. pasted from page content)" }
    return facts
  }
}

const TOKEN_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g

/** Decode (without verifying) a JWT that looks like an ACK payment request, only to label it for the agent. */
function peekPaymentRequest(token: string): { description?: string; options: { id: string; amount: string | number; decimals: number; currency: string; recipient: string }[] } | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
    if (Array.isArray(payload?.paymentOptions)) return { description: payload.description, options: payload.paymentOptions }
  } catch {
    /* not a payment request */
  }
  return undefined
}

/** A delegation credential (ACK-ID ControllerCredential) seen in content, labelled for the agent. Unverified. */
function labelCredential(token: string, world: World): string | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      vc?: { type?: string[]; credentialSubject?: { delegation?: { budget?: string; capabilities?: string[] } }; expirationDate?: string }
      iss?: string
      sub?: string
    }
    if (!p.vc?.type?.includes("ControllerCredential")) return undefined
    const d = p.vc.credentialSubject?.delegation
    const name = (did?: string) => (did?.startsWith("did:web:") ? did.split(":").slice(-1)[0] : did)
    const scope = d ? `, budget ${formatAmount(BigInt(d.budget ?? "0"))}, may buy ${(d.capabilities ?? []).join(", ")}` : ""
    return `[ACK-ID delegation credential ${world.credRefFor(token)}: ${name(p.iss)} -> ${name(p.sub)}${scope}${p.vc.expirationDate ? `, expires ${p.vc.expirationDate}` : ""}]`
  } catch {
    return undefined
  }
}

function safeAmount(o: { amount: string | number; decimals: number; currency: string }): string {
  try {
    if (!Number.isInteger(o.decimals) || o.decimals < 0 || o.decimals > 18) return "invalid amount"
    return formatAmount(BigInt(o.amount), o.decimals, o.currency)
  } catch {
    return "invalid amount"
  }
}

function labelFor(token: string, world: World): string {
  const pr = peekPaymentRequest(token)
  if (!pr) return labelCredential(token, world) ?? token
  const o = pr.options[0]
  const amt = o ? safeAmount(o) : "?"
  return `[ACK payment request ${world.refFor(token)}: "${pr.description ?? ""}", ${amt} to ${o?.recipient ?? "?"}]`
}

/**
 * Render an HTTP response for the agent. Every ACK payment request token, in a
 * 402 or anywhere in page content, is replaced with a short reference (pr_N),
 * so the model never has to copy a long JWT. This is identical for both agents.
 */
export function renderHttpForAgent(r: { status: number; url: string; body: unknown }, world: World) {
  const swapTokens = (text: string) => text.replace(TOKEN_RE, (t) => labelFor(t, world))
  if (r.status === 402 && r.body && typeof r.body === "object") {
    // The agent's view of the quote comes from the token that will actually be
    // paid, not from the unsigned `paymentRequest` echo in the body.
    const { paymentRequest: _unsignedEcho, paymentRequestToken, ...rest } = r.body as { paymentRequestToken?: string; paymentRequest?: unknown }
    const signed = paymentRequestToken ? peekPaymentRequest(paymentRequestToken) : undefined
    const extra = JSON.parse(swapTokens(JSON.stringify(rest))) as Record<string, unknown>
    return {
      status: 402,
      url: r.url,
      ...extra,
      payment_request: paymentRequestToken ? world.refFor(paymentRequestToken) : undefined,
      description: signed?.description,
      payment_options: (signed?.options ?? []).map((o) => ({ id: o.id, amount: safeAmount(o), recipient: o.recipient })),
    }
  }
  const raw = typeof r.body === "string" ? r.body : JSON.stringify(r.body)
  const body = swapTokens(raw)
  return { status: r.status, url: r.url, body: body.length > 6000 ? body.slice(0, 6000) + "...[truncated]" : body }
}

function factsForLog(f: PaymentFacts) {
  return {
    ...f,
    option: f.option ? { ...f.option, amount: f.option.amount.toString() } : undefined,
  }
}

/**
 * Canonical form of a URL, used for provenance, receipts and the HTTP request
 * itself, so that trivial variants of one URL are one URL:
 *   - scheme, port, credentials and fragment are dropped (sandbox hosts are http only)
 *   - host, path and query parameter names are lower-cased
 *   - a trailing slash on the path is dropped
 *   - query parameters are sorted, and tracking parameters (utm_*, gclid,
 *     fbclid, ...) are removed
 * Parameter values keep their case, because a value can be case-significant
 * (text to translate). Duplicate detection does not depend on the URL
 * anyway: it counts purchases per merchant, capability and task.
 */
export function normalizeUrl(raw: string): string {
  const s = raw.trim()
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported URL scheme ${u.protocol}`)
  u.protocol = "http:"
  u.port = ""
  u.username = ""
  u.password = ""
  u.hash = ""
  u.pathname = u.pathname.toLowerCase().replace(/\/+$/, "") || "/"
  const params = [...u.searchParams.entries()]
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .filter(([k]) => !isTrackingParam(k))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)))
  u.search = ""
  for (const [k, v] of params) u.searchParams.append(k, v)
  return u.toString()
}

const TRACKING_PARAMS = new Set(["gclid", "dclid", "fbclid", "msclkid", "mc_cid", "mc_eid", "_ga", "_gl", "yclid", "igshid", "ref_src"])
function isTrackingParam(k: string): boolean {
  return k.startsWith("utm_") || TRACKING_PARAMS.has(k)
}

/** A live task instance id: unique per session and per episode, since the spend history outlives a session. */
export function taskInstanceId(base: string, sessionId: string, n: number): string {
  return `${base}#${sessionId}-${n}`
}

