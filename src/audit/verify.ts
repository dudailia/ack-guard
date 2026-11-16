// Verify a hash-chained audit log: sequence, chain links, hashes, signatures
// (pinned to the expected guard DID) and the signed head checkpoint.

import { existsSync, readFileSync } from "node:fs"
import { verifyJwt, type DidResolver } from "agentcommercekit"
import { offlineDidResolver } from "../identity/offline-resolver.js"
import { GENESIS_PREV, entryHash, headPath, type AuditEntry } from "./chain.js"

export type ProblemKind =
  | "parse_error"
  | "seq_gap"
  | "prev_mismatch"
  | "hash_mismatch"
  | "bad_signature"
  | "signer_mismatch"
  | "head_missing"
  | "head_mismatch"
  | "bad_head_signature"
  | "anchor_mismatch"

export interface VerifyProblem {
  seq: number | null
  line: number
  kind: ProblemKind
  detail: string
}

export interface VerifyReport {
  ok: boolean
  entries: number
  signerDid?: string
  /** True only when the expected signer came from outside the log (operator config or --signer). */
  pinned: boolean
  /** Hash of the last entry, to be anchored outside the log. */
  headHash?: string
  /**
   * The first position in the chain (0-based, equal to the seq an untouched
   * entry there would have) where verification breaks. For an edited entry this
   * is its seq; for a deletion or reorder, the first displaced position; for a
   * truncated tail, the first missing position.
   */
  firstBadSeq: number | null
  problems: VerifyProblem[]
}

export function readEntries(path: string): { entries: (AuditEntry | null)[]; raw: string[] } {
  const raw = readFileSync(path, "utf8").split("\n").filter((l) => l.trim().length > 0)
  return {
    raw,
    entries: raw.map((l) => {
      try {
        return JSON.parse(l) as AuditEntry
      } catch {
        return null
      }
    }),
  }
}

async function sigOk(jwt: string, did: string, resolver: DidResolver): Promise<Record<string, unknown> | null> {
  try {
    const v = await verifyJwt(jwt, { resolver, issuer: did, policies: { aud: false } })
    return v.payload as Record<string, unknown>
  } catch {
    return null
  }
}

export async function verifyLog(
  path: string,
  opts: {
    expectedSignerDid?: string
    resolver?: DidResolver
    checkHead?: boolean
    /**
     * Hash of the last entry as recorded somewhere outside the log (a published
     * README, a git tag, a transparency log). Detects rolling the log back to an
     * older state together with an older, genuine head file.
     */
    expectedHeadHash?: string
  } = {},
): Promise<VerifyReport> {
  const resolver = opts.resolver ?? offlineDidResolver()
  const problems: VerifyProblem[] = []
  const { entries } = readEntries(path)
  // The signer is pinned by the caller (operator config). If not provided we
  // fall back to the genesis entry's declared guard DID and say so.
  const genesis = entries[0]
  const signerDid =
    opts.expectedSignerDid ?? (genesis?.kind === "genesis" ? (genesis.payload.guardDid as string) : undefined)

  let prev = GENESIS_PREV
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) {
      problems.push({ seq: null, line: i + 1, kind: "parse_error", detail: "line is not valid JSON" })
      continue
    }
    if (e.seq !== i) problems.push({ seq: e.seq, line: i + 1, kind: "seq_gap", detail: `expected seq ${i}, found ${e.seq}` })
    if (e.prevHash !== prev)
      problems.push({ seq: e.seq, line: i + 1, kind: "prev_mismatch", detail: "prevHash does not link to the previous entry" })
    const recomputed = entryHash(e)
    if (recomputed !== e.hash)
      problems.push({ seq: e.seq, line: i + 1, kind: "hash_mismatch", detail: "entry content does not match its hash" })
    if (!signerDid) {
      problems.push({ seq: e.seq, line: i + 1, kind: "signer_mismatch", detail: "no expected signer DID" })
    } else {
      const payload = await sigOk(e.sig, signerDid, resolver)
      if (!payload) problems.push({ seq: e.seq, line: i + 1, kind: "bad_signature", detail: `signature does not verify for ${signerDid}` })
      else if (payload.hash !== e.hash || payload.seq !== e.seq)
        problems.push({ seq: e.seq, line: i + 1, kind: "bad_signature", detail: "signature covers a different hash or seq" })
    }
    prev = e.hash
  }

  if (opts.checkHead !== false) {
    const hp = headPath(path)
    const last = entries[entries.length - 1]
    if (!existsSync(hp)) {
      problems.push({ seq: null, line: entries.length + 1, kind: "head_missing", detail: "signed head checkpoint is missing" })
    } else {
      let head: { seq: number; hash: string; sig: string }
      try {
        head = JSON.parse(readFileSync(hp, "utf8"))
      } catch {
        head = { seq: -1, hash: "", sig: "" }
      }
      const payload = signerDid && typeof head.sig === "string" ? await sigOk(head.sig, signerDid, resolver) : null
      // Require the head marker: an ordinary entry signature over {seq, hash}
      // must not be usable as a head checkpoint after truncating the log.
      if (!payload || payload.head !== true || payload.hash !== head.hash || payload.seq !== head.seq) {
        problems.push({ seq: head.seq, line: entries.length + 1, kind: "bad_head_signature", detail: "head checkpoint signature invalid" })
      } else if (!last || last.seq !== head.seq || last.hash !== head.hash) {
        problems.push({
          seq: last?.seq ?? null,
          line: entries.length + 1,
          kind: "head_mismatch",
          detail: `log ends at seq ${last?.seq ?? "none"} but signed head is seq ${head.seq} (entries removed or appended without the guard key)`,
        })
      }
    }
  }

  const firstBad = problems.length ? Math.min(...problems.map((p) => p.line)) - 1 : null
  if (opts.expectedHeadHash) {
    const last = entries[entries.length - 1]
    if (!last || last.hash !== opts.expectedHeadHash) {
      const at = entries.findIndex((e) => e?.hash === opts.expectedHeadHash)
      problems.push({
        seq: last?.seq ?? null,
        line: at >= 0 ? at + 2 : entries.length + 1,
        kind: "anchor_mismatch",
        detail:
          at >= 0
            ? `the anchored head is entry ${at}, but the log continues past it`
            : "the anchored head hash does not appear in this log (rolled back, swapped or rewritten)",
      })
    }
  }

  return {
    ok: problems.length === 0,
    entries: entries.length,
    signerDid,
    pinned: opts.expectedSignerDid !== undefined,
    headHash: entries[entries.length - 1]?.hash,
    firstBadSeq: firstBad,
    problems,
  }
}
