// pnpm policy-diff <proposed.yaml> [--log path] [--signer did] [--json]
//   Replays a signed audit log under the proposed policy and lists every past
//   payment decision that would change. Nothing is approved.
// pnpm policy-approve <proposed.yaml> [--log path] [--signer did] --yes
//   Shows the same diff, then signs the approval with the owner's key, logs it
//   in the signed policy log, and makes it the live demo's active policy.
// pnpm policy-show
//   Prints the active policy and the approval history.

import { trustedSignerFor } from "../audit/trust.js"
import { approvePolicyChange, loadActivePolicy, policyHistory } from "../policy/approvals.js"
import { changeLine, policyDiff } from "../policy/diff.js"
import { loadPolicyFile } from "../policy/policy-file.js"
import { localIdentities, operatorGuardDid } from "./env.js"
import { arg, c, defaultLog, flag, positional } from "./util.js"

const cmd = process.argv[2]
const ids = await localIdentities()
const active = await loadActivePolicy(ids)

if (cmd === "show") {
  const p = active.policy
  console.log(c.bold(`${p.doc.name} ${p.version} (${active.source === "approved" ? `approved ${active.approvedAt}` : "repository policy.yaml"})`))
  for (const r of p.doc.rules) console.log(`  ${r.enabled === false ? c.dim("off ") : r.on_fail === "escalate" ? c.yellow("ask ") : c.green("deny")} ${r.id}: ${r.plain}`)
  const h = policyHistory()
  console.log(c.bold(`\nApproved changes: ${h.length}`))
  for (const e of h) console.log(`  ${e.ts} ${String((e.from as { version: string }).version)} -> ${String((e.to as { version: string }).version)}: ${(e.changes as string[]).join("; ")}`)
  process.exit(0)
}

if (cmd !== "diff" && cmd !== "approve") {
  console.error("usage: pnpm policy-diff <proposed.yaml> | pnpm policy-approve <proposed.yaml> --yes | pnpm policy-show")
  process.exit(1)
}
const file = positional()[1]
if (!file) {
  console.error(`usage: pnpm policy-${cmd} <proposed.yaml> [--log path] [--signer did]`)
  process.exit(1)
}
const proposed = loadPolicyFile(file)
const log = defaultLog()
const trust = trustedSignerFor(log, { explicit: arg("signer"), operatorGuardDid: await operatorGuardDid() })
if (!trust.pinned || !trust.did) {
  console.error(c.red(`The log's signer is not pinned (${trust.source}). Pass --signer <guard DID> so the replay rests on a verified log.`))
  process.exit(3)
}
const d = await policyDiff(log, active.policy, proposed, { expectedSignerDid: trust.did })
if (flag("json")) {
  console.log(JSON.stringify(d, null, 2))
  process.exit(0)
}
console.log(c.bold(`Policy change ${d.from.version} -> ${d.to.version}`))
for (const l of d.policyChanges) console.log(`  ${l}`)
if (!d.policyChanges.length) console.log(c.dim("  (no differences in limits, merchants or rules)"))
console.log(c.bold(`\nReplayed against ${log}`))
console.log(`  log ${d.logVerified ? c.green("verifies") : c.red("FAILS verification")} (${d.logEntries} entries, ${trust.source}), head ${d.logHeadHash}`)
console.log(`  ${d.decisionsReplayed} past guarded decisions replayed, ${d.unchanged} unchanged`)
console.log(`  now allowed: ${d.counts["now allowed"]}   now blocked: ${d.counts["now blocked"]}   now held for a human: ${d.counts["now escalated"]}   same outcome, different rule: ${d.counts["different rule"]}`)
for (const ch of d.changes.slice(0, 40)) {
  const color = ch.change === "now allowed" ? c.red : ch.change === "now blocked" ? c.green : c.yellow
  console.log(color(`  ${changeLine(ch)}`))
}
if (d.changes.length > 40) console.log(c.dim(`  ... ${d.changes.length - 40} more (use --json)`))
for (const n of d.notes) console.log(c.dim(`  note: ${n}`))

if (cmd === "approve") {
  if (!d.logVerified) process.exit(2)
  if (!flag("yes")) {
    console.log(c.yellow("\nNot approved. Re-run with --yes to sign this change with the owner's key and make it active."))
    process.exit(0)
  }
  const { entry } = await approvePolicyChange({ ids, current: active.policy, proposed, diff: d, note: arg("note") })
  console.log(c.green(`\nApproved and signed by the owner (${ids.parties.owner.did}); logged as policy log entry ${entry.seq}. Active policy: ${proposed.version}.`))
}
