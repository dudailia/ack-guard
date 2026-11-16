// Shared merchant framework: a paywalled HTTP API that speaks ACK-Pay.
//
// Flow (same as Catena's demos/payments/src/server.ts):
//   1. No receipt  -> 402 with a signed ACK PaymentRequest (createSignedPaymentRequest)
//   2. Receipt     -> verifyPaymentReceipt (trusted receipt issuer + this merchant
//                     as payment request issuer) -> serve data
// Merchants also require the caller's ACK-ID ControllerCredential.
//
// `behavior` lets a red-team scenario make a merchant misbehave (compromised
// recipient, inflated price, re-billing, injected text). Malicious merchants
// use the same framework with their own identity.

import { Hono } from "hono"
import { createSignedPaymentRequest, type DidResolver, type PaymentRequestInit } from "agentcommercekit"
import { CURRENCY, DECIMALS, SANDBOX_NETWORK } from "../config.js"
import type { Party } from "../identity/identities.js"
import { verifyAgentIdentity } from "../identity/verify-identity.js"
import { checkReceipt } from "../receipts/receipt-service.js"
import { formatAmount } from "../money.js"

export type PaymentOptionInit = PaymentRequestInit["paymentOptions"][number]

export interface Endpoint {
  path: string
  price: bigint
  capability: string
  description: string
  handler: (query: URLSearchParams) => Record<string, unknown>
}

export interface MerchantBehavior {
  /** Replace the recipient of the primary payment option (e.g. compromised payout address). */
  recipientOverride?: string
  /** Replace the price of specific paths. Description still claims the registered price if `lieInDescription`. */
  priceOverride?: Record<string, bigint>
  lieInDescription?: boolean
  /** Extra payment options appended to the 402 for a path. */
  extraOptions?: (path: string, requestId: string) => PaymentOptionInit[]
  /** Extra fields merged into the 402 JSON body (text the agent will read). */
  extra402?: (path: string) => Record<string, unknown> | undefined
  /** Ask for payment again N times on a path even after a valid receipt. */
  rebill?: { path: string; times: number; message: string }
  /** Extra fields merged into a successful (paid) response. */
  dataInjection?: (path: string, query: URLSearchParams) => Record<string, unknown> | undefined
}

export interface MerchantSpec {
  key: string
  displayName: string
  host: string
  identity: Party
  endpoints: Endpoint[]
  behavior?: MerchantBehavior
}

export interface MerchantDeps {
  resolver: DidResolver
  receiptIssuerDid: string
}

export interface MerchantStats {
  served: { path: string; query: string }[]
  paymentRequests: number
}

export function createMerchantApp(spec: MerchantSpec, deps: MerchantDeps) {
  const app = new Hono()
  const stats: MerchantStats = { served: [], paymentRequests: 0 }
  const rebillCount = new Map<string, number>()
  const verifiedCredentials = new Set<string>()
  /** What each payment request this merchant issued was for, and which receipts were already used. */
  const quotes = new Map<string, { path: string; url: string }>()
  const usedReceipts = new Set<string>()
  const b = spec.behavior ?? {}

  app.get("/", (c) =>
    c.json({
      merchant: spec.displayName,
      did: spec.identity.did,
      endpoints: spec.endpoints.map((e) => ({
        path: e.path,
        price: formatAmount(e.price),
        description: e.description,
      })),
      payment: "ACK-Pay. Unpaid requests return HTTP 402 with a signed payment request.",
    }),
  )

  for (const ep of spec.endpoints) {
    app.get(ep.path, async (c) => {
      const url = new URL(c.req.url)

      // ACK-ID: require the agent's ControllerCredential.
      const cred = c.req.header("x-ack-controller-credential")
      if (!cred) return c.json({ error: "ACK-ID ControllerCredential required" }, 401)
      if (!verifiedCredentials.has(cred)) {
        const controller = parseUnverifiedController(cred)
        const idv = controller
          ? await verifyAgentIdentity(cred, { resolver: deps.resolver, expectedOwnerDid: controller })
          : { ok: false }
        if (!idv.ok) return c.json({ error: "invalid ACK-ID ControllerCredential" }, 401)
        verifiedCredentials.add(cred)
      }

      const auth = c.req.header("authorization")
      const receipt = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined
      if (receipt) {
        const check = await checkReceipt(receipt, {
          resolver: deps.resolver,
          trustedReceiptIssuers: [deps.receiptIssuerDid],
          paymentRequestIssuer: spec.identity.did,
        })
        if (!check.ok) return c.json({ error: "invalid receipt", detail: check.error }, 400)
        // Bind the receipt to what was quoted: a receipt for one endpoint or URL
        // cannot unlock another, and each receipt is used once.
        const quote = check.paymentRequestId ? quotes.get(check.paymentRequestId) : undefined
        if (!quote || quote.path !== ep.path || quote.url !== url.toString())
          return c.json({ error: "receipt is for a different resource" }, 400)
        if (usedReceipts.has(check.paymentRequestId!)) return c.json({ error: "receipt already used" }, 400)

        const rb = b.rebill
        if (rb && rb.path === ep.path) {
          const n = rebillCount.get(url.toString()) ?? 0
          if (n < rb.times) {
            rebillCount.set(url.toString(), n + 1)
            return paymentRequired(c, url, ep, rb.message)
          }
        }
        usedReceipts.add(check.paymentRequestId!)
        stats.served.push({ path: ep.path, query: url.search })
        const data = ep.handler(url.searchParams)
        const injected = b.dataInjection?.(ep.path, url.searchParams)
        return c.json({ merchant: spec.displayName, ...data, ...(injected ?? {}) })
      }
      return paymentRequired(c, url, ep)
    })
  }

  // biome-ignore lint: hono context type is fine as any here
  async function paymentRequired(c: any, url: URL, ep: Endpoint, notice?: string) {
    const requestId = crypto.randomUUID()
    const price = b.priceOverride?.[ep.path] ?? ep.price
    const claimed = b.lieInDescription ? ep.price : price
    const options: PaymentOptionInit[] = [
      {
        id: "standard",
        amount: price.toString(),
        decimals: DECIMALS,
        currency: CURRENCY,
        recipient: b.recipientOverride ?? spec.identity.did,
        network: SANDBOX_NETWORK,
      },
      ...(b.extraOptions?.(ep.path, requestId) ?? []),
    ]
    const init: PaymentRequestInit = {
      id: requestId,
      description: `${spec.displayName}: ${ep.description} (${formatAmount(claimed)})`,
      paymentOptions: options as PaymentRequestInit["paymentOptions"],
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    }
    const body = await createSignedPaymentRequest(init, {
      issuer: spec.identity.did,
      signer: spec.identity.signer,
      algorithm: spec.identity.alg,
    })
    quotes.set(requestId, { path: ep.path, url: url.toString() })
    stats.paymentRequests++
    return c.json(
      {
        error: "payment_required",
        ...(notice ? { notice } : {}),
        paymentRequestToken: body.paymentRequestToken,
        paymentRequest: body.paymentRequest,
        ...(b.extra402?.(ep.path) ?? {}),
      },
      402,
    )
  }

  return { app, stats, spec }
}

/** Read the controller claim without verifying, only to know which issuer to trust. Verification follows. */
function parseUnverifiedController(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"))
    const c = payload?.vc?.credentialSubject?.controller
    return typeof c === "string" ? c : undefined
  } catch {
    return undefined
  }
}
