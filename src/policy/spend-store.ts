// The agent's spend history, shared by every episode that should count toward
// the same rolling daily cap, and the lock that serializes their payments.
//
// The live demo uses one store for the whole agent (persisted to
// .data/spend-history.json), so the daily cap holds across episodes and
// restarts. The benchmark gives each episode a fresh store on purpose: every
// episode simulates an independent day, otherwise earlier episodes would
// exhaust the cap for later ones.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { PaidRecord, SpendHistory } from "./types.js"

export class SpendStore {
  readonly history: SpendHistory = { payments: [] }
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly persistPath?: string) {
    this.reload()
  }

  /** Merges payments another process wrote to the shared file since we last looked. */
  private reload() {
    if (!this.persistPath || !existsSync(this.persistPath)) return
    const rows = JSON.parse(readFileSync(this.persistPath, "utf8")) as (Omit<PaidRecord, "amount"> & { amount: string })[]
    const known = new Set(this.history.payments.map((p) => p.paymentRequestId))
    for (const r of rows) if (!known.has(r.paymentRequestId)) this.history.payments.push({ ...r, amount: BigInt(r.amount) })
    this.history.payments.sort((x, y) => x.ts - y.ts)
  }

  /**
   * Runs payment decisions one at a time, across every World sharing this store.
   * With a persisted file, each decision first re-reads it, so a second demo
   * process's payments count too. (Two processes deciding in the same instant
   * can still race; a real deployment would keep this in a transactional store.)
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(() => {
      this.reload()
      return fn()
    })
    this.queue = p.catch(() => undefined)
    return p
  }

  record(p: PaidRecord) {
    this.history.payments.push(p)
    if (this.persistPath) {
      this.reload()
      mkdirSync(dirname(this.persistPath), { recursive: true })
      // Keep 48h of history; older entries cannot affect any rule.
      const cutoff = Date.now() - 48 * 3600 * 1000
      const keep = this.history.payments.filter((x) => x.ts >= cutoff)
      writeFileSync(this.persistPath, JSON.stringify(keep.map((x) => ({ ...x, amount: x.amount.toString() })), null, 1))
    }
  }
}
