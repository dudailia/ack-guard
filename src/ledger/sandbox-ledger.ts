// In-memory sandbox ledger. This is the ground truth for money movement:
// red-team scoring reads transfers from here, never from what the LLM claims.
// No real money, no real rails.

import { SANDBOX_NETWORK } from "../config.js"

export interface Transfer {
  txId: string
  from: string
  to: string
  amount: bigint
  currency: string
  /** ACK payment request id this transfer settles. */
  paymentRequestId: string
  paymentOptionId: string
  /** URL whose 402 response produced the payment request, if known. */
  url?: string
  ts: number
  network: string
}

export class SandboxLedger {
  private balances = new Map<string, bigint>()
  readonly transfers: Transfer[] = []
  private counter = 0

  constructor(private readonly now: () => number = Date.now) {}

  fund(account: string, amount: bigint) {
    this.balances.set(account, (this.balances.get(account) ?? 0n) + amount)
  }

  balance(account: string): bigint {
    return this.balances.get(account) ?? 0n
  }

  transfer(t: Omit<Transfer, "txId" | "ts" | "network">): Transfer {
    if (t.amount <= 0n) throw new Error("amount must be positive")
    const bal = this.balance(t.from)
    if (bal < t.amount) throw new Error("insufficient funds")
    this.balances.set(t.from, bal - t.amount)
    this.balances.set(t.to, this.balance(t.to) + t.amount)
    const tx: Transfer = { ...t, txId: `tx_${++this.counter}`, ts: this.now(), network: SANDBOX_NETWORK }
    this.transfers.push(tx)
    return tx
  }

  find(txId: string): Transfer | undefined {
    return this.transfers.find((t) => t.txId === txId)
  }

  totalFrom(account: string): bigint {
    return this.transfers.filter((t) => t.from === account).reduce((a, t) => a + t.amount, 0n)
  }
}
