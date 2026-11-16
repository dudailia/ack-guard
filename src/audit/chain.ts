// Hash-chained, signed, append-only decision log.
//
// Each line of the JSONL file is an entry:
//   { seq, ts, kind, payload, prevHash, hash, sig }
// hash = sha256(canonicalJSON({ seq, ts, kind, payload, prevHash }))
// sig  = a JWT signed by the guard's DID (EdDSA) whose payload is { seq, hash }.
//
// A separate head file holds a signed { seq, hash } for the latest entry, so
// truncating the tail of the log is detectable too.

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createJwt } from "agentcommercekit"
import type { Party } from "../identity/identities.js"

export const GENESIS_PREV = "0".repeat(64)

export type EntryKind =
  | "genesis"
  | "task"
  | "agent_step"
  | "payment_attempt"
  | "decision"
  | "approval"
  | "settlement"
  | "receipt"
  | "payment_error"
  | "episode_end"

export interface AuditEntry {
  seq: number
  ts: string
  kind: EntryKind
  payload: Record<string, unknown>
  prevHash: string
  hash: string
  sig: string
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString()
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === "object") {
    // Object.fromEntries defines own properties, so a "__proto__" key is kept
    // (and hashed) instead of silently changing the prototype.
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

export function entryHash(e: Pick<AuditEntry, "seq" | "ts" | "kind" | "payload" | "prevHash">): string {
  return createHash("sha256")
    .update(canonicalJson({ seq: e.seq, ts: e.ts, kind: e.kind, payload: e.payload, prevHash: e.prevHash }))
    .digest("hex")
}

export function headPath(logPath: string) {
  return logPath.replace(/\.jsonl$/, "") + ".head.json"
}

export class AuditLog {
  private seq = -1
  private prev = GENESIS_PREV
  private queue: Promise<unknown> = Promise.resolve()
  readonly entries: AuditEntry[] = []
  private listeners = new Set<(e: AuditEntry) => void>()

  constructor(
    readonly path: string,
    private readonly signer: Party,
  ) {
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue
        const e = JSON.parse(line) as AuditEntry
        this.entries.push(e)
        this.seq = e.seq
        this.prev = e.hash
      }
    }
  }

  get signerDid() {
    return this.signer.did
  }

  onAppend(fn: (e: AuditEntry) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Appends are serialized so seq and prevHash stay consistent under concurrency. */
  append(kind: EntryKind, payload: Record<string, unknown>): Promise<AuditEntry> {
    const p = this.queue.then(() => this.doAppend(kind, payload))
    this.queue = p.catch(() => undefined)
    return p
  }

  private async doAppend(kind: EntryKind, payload: Record<string, unknown>): Promise<AuditEntry> {
    const seq = this.seq + 1
    const ts = new Date().toISOString()
    const cleanPayload = JSON.parse(canonicalJson(payload)) as Record<string, unknown>
    const base = { seq, ts, kind, payload: cleanPayload, prevHash: this.prev }
    const hash = entryHash(base)
    const sig = await createJwt({ seq, hash }, { issuer: this.signer.did, signer: this.signer.signer }, { alg: this.signer.alg })
    const head = await createJwt({ seq, hash, head: true }, { issuer: this.signer.did, signer: this.signer.signer }, { alg: this.signer.alg })
    const entry: AuditEntry = { ...base, hash, sig }
    // Both writes happen synchronously after signing, so a reader never sees
    // a new entry without its matching head.
    appendFileSync(this.path, JSON.stringify(entry) + "\n")
    writeFileSync(headPath(this.path), JSON.stringify({ seq, hash, sig: head }) + "\n")
    this.seq = seq
    this.prev = hash
    this.entries.push(entry)
    for (const l of this.listeners) l(entry)
    return entry
  }

  async flush() {
    await this.queue
  }
}
