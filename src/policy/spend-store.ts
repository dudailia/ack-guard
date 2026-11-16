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
    if (persistPath && existsSync(persistPath)) {
      const rows = JSON.parse(readFileSync(persistPath, "utf8")) as (Omit<PaidRecord, "amount"> & { amount: string })[]
      this.history.payments.push(...rows.map((r) => ({ ...r, amount: BigInt(r.amount) })))
    }
  }

  /** Runs payment decisions one at a time, across every World sharing this store. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn)
    this.queue = p.catch(() => undefined)
    return p
  }

  record(p: PaidRecord) {
    this.history.payments.push(p)
    if (this.persistPath) {
      mkdirSync(dirname(this.persistPath), { recursive: true })
      // Keep 48h of history; older entries cannot affect any rule.
      const cutoff = Date.now() - 48 * 3600 * 1000
      const keep = this.history.payments.filter((x) => x.ts >= cutoff)
      writeFileSync(this.persistPath, JSON.stringify(keep.map((x) => ({ ...x, amount: x.amount.toString() })), null, 1))
    }
  }
}
