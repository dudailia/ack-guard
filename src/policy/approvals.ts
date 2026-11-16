// Policy changes are approved, signed and logged before they take effect.
//
//   1. A proposed policy is diffed against a signed audit log (diff.ts).
//   2. The owner approves: the owner's key signs a JWT over the old and new
//      policy hashes and a digest of the diff that was shown.
//   3. The guard appends a policy_change entry (with the policy text and the
//      owner's signature) to a hash-chained policy log it signs, and writes
//      the new policy as the active policy.
//   4. The live demo loads the active policy only if the policy log verifies
//      and its last approved change is exactly that file, signed by the owner.
//
// In this demo the owner's key sits in .data/keys.json next to the guard's, so
// both signatures come from one machine. In production the owner signs on
// their own device and the guard only verifies.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createJwt, verifyJwt } from "agentcommercekit"
import { AuditLog, canonicalJson, type AuditEntry } from "../audit/chain.js"
import { readEntries, verifyLog } from "../audit/verify.js"
import type { Identities, Party } from "../identity/identities.js"
import { offlineDidResolver } from "../identity/offline-resolver.js"
import type { PolicyDiffReport } from "./diff.js"
import { loadPolicyFile, parsePolicy, type LoadedPolicy } from "./policy-file.js"

export const POLICY_DIR = join(".data", "policy")
export const policyLogPath = (dir = POLICY_DIR) => join(dir, "audit.jsonl")
export const activePolicyPath = (dir = POLICY_DIR) => join(dir, "active.yaml")

/** What an approval commits to about the diff the owner saw. */
export function diffDigest(d: PolicyDiffReport): string {
  const summary = {
    log: d.log,
    logHeadHash: d.logHeadHash,
    from: d.from.hash,
    to: d.to.hash,
    decisionsReplayed: d.decisionsReplayed,
    changes: d.changes.map((c) => [c.attemptId, c.current.outcome, c.current.rule, c.proposed.outcome, c.proposed.rule]),
  }
  return createHash("sha256").update(canonicalJson(summary)).digest("hex")
}

export interface ApprovalClaims {
  type: "ack-guard-policy-approval"
  from: string
  to: string
  diff: string
  log?: string
  logHeadHash?: string
}

export async function approvePolicyChange(opts: {
  ids: Identities
  current: LoadedPolicy
  proposed: LoadedPolicy
  diff: PolicyDiffReport
  /** Who approves; the owner in this demo. */
  approver?: Party
  dir?: string
  note?: string
}): Promise<{ entry: AuditEntry; jwt: string }> {
  const { ids, current, proposed, diff } = opts
  if (diff.from.hash !== current.hash || diff.to.hash !== proposed.hash) throw new Error("the diff shown was for a different policy change; run the diff again")
  if (!diff.logVerified) throw new Error("the diff was computed on a log that does not verify; refusing to approve")
  const approver = opts.approver ?? ids.parties.owner
  const dir = opts.dir ?? POLICY_DIR
  const claims: ApprovalClaims = { type: "ack-guard-policy-approval", from: current.hash, to: proposed.hash, diff: diffDigest(diff), log: diff.log, logHeadHash: diff.logHeadHash }
  const jwt = await createJwt(claims as unknown as Record<string, unknown>, { issuer: approver.did, signer: approver.signer }, { alg: approver.alg })
  mkdirSync(dir, { recursive: true })
  const log = await AuditLog.open(policyLogPath(dir), ids.parties.guard)
  const entry = await log.append("policy_change", {
    from: diff.from,
    to: diff.to,
    policyText: proposed.text,
    policyChanges: diff.policyChanges,
    diff: { log: diff.log, logHeadHash: diff.logHeadHash, decisionsReplayed: diff.decisionsReplayed, counts: diff.counts, digest: claims.diff },
    approval: { by: approver.did, jwt },
    note: opts.note,
  })
  writeFileSync(activePolicyPath(dir), proposed.text)
  return { entry, jwt }
}

export interface ActivePolicy {
  policy: LoadedPolicy
  source: "repository" | "approved"
  /** The policy log entry that approved it, when approved. */
  approvedAt?: string
  approvedBy?: string
}

/**
 * The policy the live guard runs. Without an approved change it is the
 * repository's policy.yaml. With one, the active file must be exactly the last
 * change the signed policy log records, approved by the configured owner.
 */
export async function loadActivePolicy(ids: Identities, dir = POLICY_DIR): Promise<ActivePolicy> {
  const active = activePolicyPath(dir)
  const logPath = policyLogPath(dir)
  if (!existsSync(active) && !existsSync(logPath)) return { policy: loadPolicyFile(), source: "repository" }
  if (!existsSync(logPath)) throw new Error(`${active} exists but there is no policy log approving it; delete it or approve a change`)
  const v = await verifyLog(logPath, { expectedSignerDid: ids.parties.guard.did })
  if (!v.ok) throw new Error(`the policy log ${logPath} does not verify (${v.problems[0]?.detail}); refusing to load an unapproved policy`)
  const changes = readEntries(logPath).entries.filter((e): e is AuditEntry => !!e && e.kind === "policy_change")
  const last = changes[changes.length - 1]
  if (!last) {
    if (existsSync(active)) throw new Error(`${active} exists but the policy log records no approved change`)
    return { policy: loadPolicyFile(), source: "repository" }
  }
  const policy = parsePolicy(readFileSync(active, "utf8"))
  const p = last.payload as { to: { hash: string }; approval: { by: string; jwt: string } }
  if (policy.hash !== p.to.hash) throw new Error(`${active} is not the last approved policy (hash ${policy.hash.slice(0, 12)}, approved ${p.to.hash.slice(0, 12)})`)
  if (p.approval.by !== ids.parties.owner.did) throw new Error("the last policy change was not approved by the configured owner")
  const resolver = offlineDidResolver()
  const vj = await verifyJwt(p.approval.jwt, { resolver, issuer: ids.parties.owner.did, policies: { aud: false } }).catch(() => undefined)
  if (!vj || (vj.payload as unknown as ApprovalClaims).to !== policy.hash) throw new Error("the owner's approval signature does not cover the active policy")
  return { policy, source: "approved", approvedAt: last.ts, approvedBy: p.approval.by }
}

/** Every approved change, oldest first, for the dashboard. */
export function policyHistory(dir = POLICY_DIR) {
  const logPath = policyLogPath(dir)
  if (!existsSync(logPath)) return []
  return readEntries(logPath)
    .entries.filter((e): e is AuditEntry => !!e && e.kind === "policy_change")
    .map((e) => ({ seq: e.seq, ts: e.ts, from: e.payload.from, to: e.payload.to, changes: e.payload.policyChanges, diff: e.payload.diff, by: (e.payload.approval as { by: string }).by }))
}

