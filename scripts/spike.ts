// Spike: confirm the ACK 0.11.0 APIs work end to end, locally, with did:key.
import {
  createControllerCredential,
  createDidDocumentFromKeypair,
  createDidKeyUri,
  createDidWebDocumentFromKeypair,
  createJwtSigner,
  createPaymentReceipt,
  createSignedPaymentRequest,
  curveToJwtAlgorithm,
  generateKeypair,
  getControllerClaimVerifier,
  getDidResolver,
  parseJwtCredential,
  signCredential,
  verifyParsedCredential,
  verifyPaymentReceipt,
  verifyPaymentRequestToken,
} from "agentcommercekit"

const resolver = getDidResolver()

async function party() {
  const keypair = await generateKeypair("secp256k1")
  const did = createDidKeyUri(keypair)
  resolver.addToCache(did, createDidDocumentFromKeypair({ did, keypair }))
  return { keypair, did, signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve) }
}

const owner = await party()
const agentKeypair = await generateKeypair("secp256k1")
const { did: agentDid, didDocument: agentDoc } = createDidWebDocumentFromKeypair({
  keypair: agentKeypair,
  baseUrl: "https://agents.ack-guard.example/research-agent",
  controller: owner.did,
})
resolver.addToCache(agentDid, agentDoc)
const agent = { did: agentDid }
console.log("agent did:", agentDid)
const merchant = await party()
const receiptSvc = await party()

const cc = createControllerCredential({ subject: agent.did, controller: owner.did })
const ccJwt = await signCredential(cc, { did: owner.did, signer: owner.signer, alg: owner.alg })
const parsedCc = await parseJwtCredential(ccJwt, resolver)
const verifiedCc = await verifyParsedCredential(parsedCc, {
  resolver,
  trustedIssuers: [owner.did],
  verifiers: [getControllerClaimVerifier()],
})
console.log("controller credential ok:", verifiedCc.credentialSubject)

const { paymentRequest, paymentRequestToken } = await createSignedPaymentRequest(
  {
    id: crypto.randomUUID(),
    description: "spike",
    paymentOptions: [
      { id: "opt-1", amount: "250", decimals: 2, currency: "USD", recipient: merchant.did, network: "ack-guard-sandbox" },
    ],
  },
  { issuer: merchant.did, signer: merchant.signer, algorithm: merchant.alg },
)
const vpr = await verifyPaymentRequestToken(paymentRequestToken, { resolver })
console.log("payment request ok:", vpr.paymentRequest.paymentOptions[0], "iss:", vpr.parsed?.issuer ?? "(n/a)")

const receipt = createPaymentReceipt({
  paymentRequestToken,
  paymentOptionId: "opt-1",
  issuer: receiptSvc.did,
  payerDid: agent.did,
  metadata: { network: "ack-guard-sandbox", txId: "tx_1" },
})
const receiptJwt = await signCredential(receipt, { did: receiptSvc.did, signer: receiptSvc.signer, alg: receiptSvc.alg })
const vr = await verifyPaymentReceipt(receiptJwt, {
  resolver,
  trustedReceiptIssuers: [receiptSvc.did],
  paymentRequestIssuer: merchant.did,
})
console.log("receipt ok:", vr.receipt.credentialSubject.paymentOptionId, vr.paymentRequest?.id === paymentRequest.id)

try {
  await verifyPaymentReceipt(receiptJwt, { resolver, trustedReceiptIssuers: [agent.did], paymentRequestIssuer: merchant.did })
  console.log("UNEXPECTED: untrusted issuer accepted")
} catch (e) {
  console.log("untrusted receipt issuer rejected:", (e as Error).message)
}
const parts = receiptJwt.split(".")
const tampered = [parts[0], parts[1]!.slice(0, -4) + "AAAA", parts[2]].join(".")
try {
  await verifyPaymentReceipt(tampered, { resolver, trustedReceiptIssuers: [receiptSvc.did] })
  console.log("UNEXPECTED: tampered receipt accepted")
} catch (e) {
  console.log("tampered receipt rejected:", (e as Error).message.slice(0, 80))
}
