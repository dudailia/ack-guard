// pnpm verify-log [--log path] [--signer did]
import { verifyLog } from "../audit/verify.js"
import { arg, c, defaultLog } from "./util.js"

const path = defaultLog()
const r = await verifyLog(path, { expectedSignerDid: arg("signer") })
console.log(c.bold(`Audit log: ${path}`))
console.log(`entries: ${r.entries}   signer: ${r.signerDid ?? "unknown"}`)
if (r.ok) {
  console.log(c.green("VERIFIED: chain links, hashes, signatures and signed head are all intact."))
} else {
  console.log(c.red(`TAMPERING DETECTED. First bad seq: ${r.firstBadSeq ?? "n/a"}`))
  for (const p of r.problems.slice(0, 20)) console.log(c.red(`  seq ${p.seq ?? "?"} (line ${p.line}): ${p.kind}: ${p.detail}`))
  if (r.problems.length > 20) console.log(c.dim(`  ... ${r.problems.length - 20} more`))
  process.exitCode = 2
}
