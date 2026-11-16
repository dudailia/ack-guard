// Which key should a log be verified against?
//
// A log's genesis entry names the guard DID that signed it, but a forger can
// write a whole new log under their own key and name that key instead. So the
// expected signer must come from outside the log: an explicit --signer, or this
// machine's operator key (.data/keys.json). Otherwise verification is reported
// as "not pinned": the chain is internally consistent, but that alone does not
// prove who wrote it.

import { readFileSync } from "node:fs"
import type { AuditEntry } from "./chain.js"

export interface TrustedSigner {
  did?: string
  pinned: boolean
  source: string
}

export function genesisGuardDid(logPath: string): string | undefined {
  try {
    const first = readFileSync(logPath, "utf8").split("\n", 1)[0]
    const e = JSON.parse(first ?? "") as AuditEntry
    return e.kind === "genesis" ? (e.payload.guardDid as string) : undefined
  } catch {
    return undefined
  }
}

export function trustedSignerFor(logPath: string, opts: { explicit?: string; operatorGuardDid?: string } = {}): TrustedSigner {
  if (opts.explicit) return { did: opts.explicit, pinned: true, source: "pinned by --signer" }
  const declared = genesisGuardDid(logPath)
  if (opts.operatorGuardDid && declared === opts.operatorGuardDid)
    return { did: declared, pinned: true, source: "pinned to this machine's guard key (.data/keys.json)" }
  return { did: undefined, pinned: false, source: `not pinned: only the key the log declares (${declared ?? "none"}) was checked` }
}
