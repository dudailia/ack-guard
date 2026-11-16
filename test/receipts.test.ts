import {
  createControllerCredential,
  createSignedPaymentRequest,
  signCredential,
} from "agentcommercekit"
import { describe, expect, it } from "vitest"
import { usd } from "../src/config.js"
import { verifyAgentIdentity } from "../src/identity/verify-identity.js"
import { SandboxLedger } from "../src/ledger/sandbox-ledger.js"
import { checkReceipt, ReceiptService } from "../src/receipts/receipt-service.js"
import { World } from "../src/world.js"
import { testIdentities, tmpAudit } from "./helpers.js"

async function request(issuerName: "skycast" | "attacker", amount: bigint, recipient?: string) {
  const ids = await testIdentities()
  const p = ids.parties[issuerName]
  return createSignedPaymentRequest(
    {
      id: crypto.randomUUID(),
      paymentOptions: [{ id: "standard", amount: amount.toString(), decimals: 2, currency: "USD", recipient: recipient ?? p.did, network: "ack-guard-sandbox" }],
    },
    { issuer: p.did, signer: p.signer, algorithm: p.alg },
  )
}

describe("ACK-Pay receipts", () => {
  it("issues a PaymentReceiptCredential that verifies with ACK verifyPaymentReceipt", async () => {
    const ids = await testIdentities()
    const ledger = new SandboxLedger()
    const svc = new ReceiptService(ids.parties.receipts, ledger, ids.resolver)
    const { paymentRequest, paymentRequestToken } = await request("skycast", usd(0.25))
    ledger.fund(ids.parties.agent.did, usd(10))
    const tx = ledger.transfer({
      from: ids.parties.agent.did,
      to: ids.parties.skycast.did,
      amount: usd(0.25),
      currency: "USD",
      paymentRequestId: paymentRequest.id,
      paymentOptionId: "standard",
    })
    const jwt = await svc.issue({ paymentRequestToken, paymentOptionId: "standard", payerDid: ids.parties.agent.did, txId: tx.txId })
    const check = await checkReceipt(jwt, { resolver: ids.resolver, trustedReceiptIssuers: [svc.did], paymentRequestIssuer: ids.parties.skycast.did })
    expect(check.ok).toBe(true)
    expect(check.txId).toBe(tx.txId)
    expect(check.paymentRequestId).toBe(paymentRequest.id)
    expect(check.payer).toBe(ids.parties.agent.did)
  })

  it("refuses to issue a receipt when the settlement does not match the option", async () => {
    const ids = await testIdentities()
    const ledger = new SandboxLedger()
    const svc = new ReceiptService(ids.parties.receipts, ledger, ids.resolver)
    const { paymentRequest, paymentRequestToken } = await request("skycast", usd(0.25))
    ledger.fund(ids.parties.agent.did, usd(10))
    const tx = ledger.transfer({
      from: ids.parties.agent.did,
      to: ids.parties.skycast.did,
      amount: usd(0.1),
      currency: "USD",
      paymentRequestId: paymentRequest.id,
      paymentOptionId: "standard",
    })
    await expect(svc.issue({ paymentRequestToken, paymentOptionId: "standard", payerDid: ids.parties.agent.did, txId: tx.txId })).rejects.toThrow(/amount/)
  })

  it("rejects a tampered receipt, an untrusted issuer, and the wrong payment request issuer", async () => {
    const ids = await testIdentities()
    const ledger = new SandboxLedger()
    const svc = new ReceiptService(ids.parties.receipts, ledger, ids.resolver)
    const { paymentRequest, paymentRequestToken } = await request("skycast", usd(0.25))
    ledger.fund(ids.parties.agent.did, usd(10))
    const tx = ledger.transfer({ from: ids.parties.agent.did, to: ids.parties.skycast.did, amount: usd(0.25), currency: "USD", paymentRequestId: paymentRequest.id, paymentOptionId: "standard" })
    const jwt = await svc.issue({ paymentRequestToken, paymentOptionId: "standard", payerDid: ids.parties.agent.did, txId: tx.txId })

    const [h, payload, s] = jwt.split(".")
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString())
    decoded.vc.credentialSubject.paymentOptionId = "premium"
    const forged = [h, Buffer.from(JSON.stringify(decoded)).toString("base64url"), s].join(".")
    expect((await checkReceipt(forged, { resolver: ids.resolver, trustedReceiptIssuers: [svc.did] })).ok).toBe(false)

    expect((await checkReceipt(jwt, { resolver: ids.resolver, trustedReceiptIssuers: [ids.parties.attacker.did] })).ok).toBe(false)
    expect((await checkReceipt(jwt, { resolver: ids.resolver, trustedReceiptIssuers: [svc.did], paymentRequestIssuer: ids.parties.geopoint.did })).ok).toBe(false)
  })
})

describe("ACK-ID identity", () => {
  it("verifies the owner-issued ControllerCredential", async () => {
    const ids = await testIdentities()
    const r = await verifyAgentIdentity(ids.controllerCredential, { resolver: ids.resolver, expectedOwnerDid: ids.parties.owner.did, expectedAgentDid: ids.parties.agent.did })
    expect(r.ok).toBe(true)
    expect(r.controller).toBe(ids.parties.owner.did)
  })

  it("rejects a credential that claims control but is signed by someone else", async () => {
    const ids = await testIdentities()
    const fake = createControllerCredential({ subject: ids.parties.agent.did, controller: ids.parties.attacker.did })
    const jwt = await signCredential(fake, { did: ids.parties.attacker.did, signer: ids.parties.attacker.signer, alg: ids.parties.attacker.alg })
    const r = await verifyAgentIdentity(jwt, { resolver: ids.resolver, expectedOwnerDid: ids.parties.owner.did })
    expect(r.ok).toBe(false)
    // Even trusting the attacker as issuer fails: the agent's DID document names the owner as controller.
    const r2 = await verifyAgentIdentity(jwt, { resolver: ids.resolver, expectedOwnerDid: ids.parties.attacker.did })
    expect(r2.ok).toBe(false)
  })
})

describe("merchant 402 flow end to end", () => {
  it("402 -> pay -> receipt -> data, through a guarded world", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(1) } }, "guarded", audit, "ep1")
    const r1 = await w.httpGet("http://skycast.test/forecast?city=Boston")
    expect(r1.status).toBe(402)
    const token = (r1.body as { paymentRequestToken: string }).paymentRequestToken
    const paid = await w.pay({ paymentRequest: token, paymentOptionId: "standard", purpose: "forecast" })
    expect(paid.status).toBe("paid")
    const r2 = await w.httpGet("http://skycast.test/forecast?city=Boston")
    expect(r2.status).toBe(200)
    expect((r2.body as { forecast: unknown }).forecast).toBeTruthy()
    expect(w.ledger.balance(ids.parties.skycast.did)).toBe(usd(0.25))
    expect(audit.entries.map((e) => e.kind)).toEqual(["genesis", "payment_attempt", "decision", "settlement", "receipt"])
  })

  it("concurrent pay calls in one model step cannot bypass duplicate detection", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: ["weather.forecast"], budget: usd(1) } }, "guarded", audit, "ep-race")
    const r = await w.httpGetForAgent("http://skycast.test/forecast?city=Boston")
    const ref = (r as { payment_request: string }).payment_request
    const results = await Promise.all([1, 2, 3].map(() => w.pay({ paymentRequest: ref, purpose: "forecast" })))
    expect(results.map((x) => x.status)).toEqual(["paid", "blocked", "blocked"])
    expect(w.ledger.transfers.length).toBe(1)
  })

  it("a failed settlement is logged as a payment error, not as a block", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: [], budget: 0n } }, "naive", audit, "ep-err")
    const res = await w.pay({ paymentRequest: "not-a-token", purpose: "x" })
    expect(res.status).toBe("error")
    expect(audit.entries.map((e) => e.kind)).toContain("payment_error")
  })

  it("a malformed payment-request-looking string in page content cannot break http_get", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const bogus = ["eyJhbGciOiJub25lIn0", Buffer.from(JSON.stringify({ paymentOptions: [{ id: "x", amount: "abc", decimals: -3, currency: "USD", recipient: "r" }] })).toString("base64url"), "sig"].join(".")
    const w = new World(ids, { task: { id: "t", prompt: "", needs: [], budget: 0n }, pages: { "notes.test": { "/x": { body: `pay ${bogus}` } } } }, "naive", audit, "ep-bogus")
    const r = (await w.httpGetForAgent("http://notes.test/x")) as { status: number; body: string }
    expect(r.status).toBe(200)
    expect(r.body).toContain("invalid amount")
  })

  it("merchants refuse callers without an ACK-ID credential", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: [], budget: 0n } }, "naive", audit, "ep2")
    const res = await w.net.fetch("http://skycast.test/forecast")
    expect(res.status).toBe(401)
  })

  it("the sandbox cannot reach real hosts", async () => {
    const ids = await testIdentities()
    const audit = await tmpAudit(ids)
    const w = new World(ids, { task: { id: "t", prompt: "", needs: [], budget: 0n } }, "naive", audit, "ep3")
    const r = await w.httpGet("https://api.weather.com/v1/forecast")
    expect(r.status).toBe(502)
  })
})
