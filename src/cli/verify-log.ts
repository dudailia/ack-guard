// pnpm verify-log [--log path] [--signer did]
import { trustedSignerFor } from "../audit/trust.js"
import { verifyLog } from "../audit/verify.js"
import { operatorGuardDid } from "./env.js"
import { arg, c, defaultLog } from "./util.js"

const path = defaultLog()
const trust = trustedSignerFor(path, { explicit: arg("signer"), operatorGuardDid: await operatorGuardDid() })
const r = await verifyLog(path, { expectedSignerDid: trust.did })
console.log(c.bold(`Audit log: ${path}`))
console.log(`entries: ${r.entries}   signer: ${r.signerDid ?? "unknown"}   (${trust.source})`)
if (!r.ok) {
  console.log(c.red(`TAMPERING DETECTED. First bad seq: ${r.firstBadSeq ?? "n/a"}`))
  for (const p of r.problems.slice(0, 20)) console.log(c.red(`  seq ${p.seq ?? "?"} (line ${p.line}): ${p.kind}: ${p.detail}`))
  if (r.problems.length > 20) console.log(c.dim(`  ... ${r.problems.length - 20} more`))
  process.exitCode = 2
} else if (r.pinned) {
  console.log(c.green("VERIFIED: chain links, hashes, signatures and signed head are all intact, signed by the expected guard key."))
} else {
  console.log(c.yellow("CHAIN INTACT, SIGNER NOT PINNED: the log is internally consistent and signed by the key it declares,"))
  console.log(c.yellow("but nothing outside the log says that key is the right one. Re-run with --signer <guard DID> to pin it."))
  process.exitCode = 3
}
