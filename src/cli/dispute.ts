// pnpm dispute <attemptId> [--log path] [--out dir]
//   Builds a signed dispute evidence pack (JSON) and a one-page PDF for one
//   payment attempt. The log must be signed by this machine's guard key.
// pnpm dispute-verify <pack.json> [--signer did]
//   Re-checks a pack from the file alone: pack signature, every signed log
//   entry, the signed head, the summary against the entries, and the ACK
//   payment request, receipt and delegation chain (as of the payment time).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { DidDocument } from "agentcommercekit"
import { buildDisputePack, verifyDisputePack, type DisputePack } from "../dispute/pack.js"
import { renderDisputePdf } from "../dispute/pdf.js"
import { localIdentities } from "./env.js"
import { arg, c, defaultLog, positional } from "./util.js"

const cmd = process.argv[2]
const target = positional()[1]

if (cmd === "verify") {
  if (!target) {
    console.error("usage: pnpm dispute-verify <pack.json> [--signer did]")
    process.exit(1)
  }
  const pack = JSON.parse(readFileSync(target, "utf8")) as DisputePack
  const signer = arg("signer")
  const v = await verifyDisputePack(pack, { signer })
  console.log(c.bold(`Dispute pack ${target}: ${pack.subject.attemptId} (${pack.subject.outcome}${pack.subject.decidingRule ? ` by ${pack.subject.decidingRule}` : ""})`))
  for (const [k, ch] of Object.entries(v.checks)) console.log(`  ${ch.ok ? c.green("OK  ") : c.red("FAIL")} ${k}: ${ch.detail}`)
  if (!v.ok) {
    console.log(c.red("NOT VERIFIED: at least one check failed."))
    process.exit(2)
  }
  if (!v.pinned) {
    console.log(c.yellow(`Everything checks out against the key the pack names (${pack.signedBy}), but nothing outside the pack says that key is the guard's.`))
    console.log(c.yellow("Re-run with --signer <guard DID>, taken from a source you trust (for example the published results)."))
    process.exit(3)
  }
  console.log(c.green(`VERIFIED against guard ${signer}.`))
  process.exit(0)
}

if (cmd !== "build" || !target) {
  console.error("usage: pnpm dispute <attemptId> [--log path] [--out dir]   |   pnpm dispute-verify <pack.json> [--signer did]")
  process.exit(1)
}
const ids = await localIdentities()
const log = defaultLog()
// did:web documents the pack needs to resolve offline (in production they resolve over HTTPS).
const docs: Record<string, DidDocument> = {}
for (const p of [ids.parties.agent, ids.parties.subagent]) {
  const r = await ids.resolver.resolve(p.did)
  if (r.didDocument) docs[p.did] = r.didDocument as DidDocument
}
const pack = await buildDisputePack(log, target, { guard: ids.parties.guard, didDocuments: docs, logLabel: relative(process.cwd(), log) })
const out = arg("out") ?? join(".data", "disputes")
mkdirSync(out, { recursive: true })
const base = join(out, `dispute-${target.replace(/[^A-Za-z0-9._-]+/g, "_")}`)
writeFileSync(`${base}.json`, JSON.stringify(pack, null, 2) + "\n")
writeFileSync(`${base}.pdf`, await renderDisputePdf(pack))
console.log(c.bold(`Dispute pack for ${target}: ${pack.subject.outcome}${pack.subject.decidingRule ? ` (${pack.subject.decidingRule})` : ""}`))
for (const [k, ch] of Object.entries(pack.verification)) console.log(`  ${ch.ok ? c.green("OK  ") : c.red("FAIL")} ${k}: ${ch.detail}`)
console.log(`Wrote ${base}.json (signed) and ${base}.pdf`)
console.log(c.dim(`Anyone can check it: pnpm dispute-verify ${base}.json --signer ${ids.parties.guard.did}`))
