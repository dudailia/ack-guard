// ACK-Pay receipt service for the sandbox ledger.
//
// Mirrors the structure of Catena's demo receipt service
// (demos/payments/src/receipt-service.ts): verify the payment request token,
// find the selected option, verify the settlement matches the option
// (recipient, amount, currency, payer), then issue a signed
// PaymentReceiptCredential. Here "settlement" is a sandbox ledger transfer
// instead of an on-chain transaction.

import {
  createPaymentReceipt,
  signCredential,
  verifyPaymentReceipt,
  verifyPaymentRequestToken,
  type DidResolver,
  type DidUri,
  type JwtString,
} from "agentcommercekit"
import { SANDBOX_NETWORK } from "../config.js"
import type { Party } from "../identity/identities.js"
import type { SandboxLedger } from "../ledger/sandbox-ledger.js"
import { parseSubunits } from "../money.js"

export class ReceiptService {
  constructor(
    private readonly identity: Party,
    private readonly ledger: SandboxLedger,
    private readonly resolver: DidResolver,
  ) {}

  get did() {
    return this.identity.did
  }

  async issue(params: {
    paymentRequestToken: string
    paymentOptionId: string
    payerDid: DidUri
    txId: string
  }): Promise<JwtString> {
    const { paymentRequest } = await verifyPaymentRequestToken(params.paymentRequestToken, { resolver: this.resolver })
    const option = paymentRequest.paymentOptions.find((o) => o.id === params.paymentOptionId)
    if (!option) throw new Error("payment option not found")
    const tx = this.ledger.find(params.txId)
    if (!tx) throw new Error("settlement not found on ledger")
    if (tx.to !== option.recipient) throw new Error("settlement recipient does not match payment option")
    if (tx.amount !== parseSubunits(option.amount)) throw new Error("settlement amount does not match payment option")
    if (tx.currency !== option.currency) throw new Error("settlement currency does not match payment option")
    if (tx.from !== params.payerDid) throw new Error("settlement payer does not match")
    if (tx.paymentRequestId !== paymentRequest.id) throw new Error("settlement is for a different payment request")

    const receipt = createPaymentReceipt({
      paymentRequestToken: params.paymentRequestToken,
      paymentOptionId: option.id,
      issuer: this.identity.did,
      payerDid: params.payerDid,
      metadata: { network: SANDBOX_NETWORK, txId: tx.txId },
    })
    return signCredential(receipt, { did: this.identity.did, signer: this.identity.signer, alg: this.identity.alg })
  }
}

export interface ReceiptCheck {
  ok: boolean
  paymentRequestId?: string
  paymentOptionId?: string
  payer?: string
  txId?: string
  error?: string
}

/** Verify an ACK PaymentReceiptCredential with ACK's own verifyPaymentReceipt. */
export async function checkReceipt(
  receiptJwt: string,
  opts: { resolver: DidResolver; trustedReceiptIssuers: string[]; paymentRequestIssuer?: string },
): Promise<ReceiptCheck> {
  try {
    const r = await verifyPaymentReceipt(receiptJwt, {
      resolver: opts.resolver,
      trustedReceiptIssuers: opts.trustedReceiptIssuers,
      paymentRequestIssuer: opts.paymentRequestIssuer,
    })
    const subject = r.receipt.credentialSubject as { id?: string; paymentOptionId?: string; metadata?: { txId?: string } }
    return {
      ok: true,
      paymentRequestId: r.paymentRequest?.id,
      paymentOptionId: subject.paymentOptionId,
      payer: subject.id,
      txId: subject.metadata?.txId,
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
