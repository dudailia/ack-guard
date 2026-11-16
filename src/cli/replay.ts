// pnpm replay [attemptId] [--log path] [--json]
//   no id: list payment attempts in the log
//   id:    reconstruct task, reasoning, policy rule, identity, receipt, verification
import { listAttempts, replayAttempt } from "../audit/replay.js"
import { trustedSignerFor } from "../audit/trust.js"
import { operatorGuardDid } from "./env.js"
import { arg, c, defaultLog, flag, positional } from "./util.js"

const path = defaultLog()
const id = positional()[0]

if (!id) {
  const rows = listAttempts(path)
  console.log(c.bold(`Payment attempts in ${path}`) + c.dim(` (${rows.length})`))
  for (const r of rows) {
    const color = r.outcome === "paid" ? (r.mode === "naive" ? c.yellow : c.green) : c.red
    console.log(`${r.attemptId.padEnd(44)} ${r.mode.padEnd(8)} ${(r.scenarioId ?? "").padEnd(8)} ${color(r.outcome.padEnd(15))} ${r.rule}`)
  }
  console.log(c.dim("\nReplay one: pnpm replay <attemptId> [--log path]"))
} else {
  const trust = trustedSignerFor(path, { explicit: arg("signer"), operatorGuardDid: await operatorGuardDid() })
  const r = await replayAttempt(path, id, { expectedSignerDid: trust.did })
  if (flag("json")) {
    console.log(JSON.stringify(r, null, 2))
  } else {
    const ok = (b: boolean) => (b ? c.green("OK") : c.red("FAIL"))
    const t = r.task as { task?: { prompt?: string; needs?: string[]; budget?: string }; scenarioId?: string; category?: string; model?: string } | undefined
    console.log(c.bold(`\nReplay of ${r.attemptId}`) + c.dim(`  (${r.mode} agent)`))
    console.log(c.bold("\n1. Task"))
    console.log(`   scenario: ${t?.scenarioId ?? "-"} ${t?.category ? `(${t.category})` : ""}   model: ${t?.model ?? "-"}`)
    console.log(`   prompt:   ${t?.task?.prompt ?? "-"}`)
    console.log(`   needs:    [${(t?.task?.needs ?? []).join(", ")}]   budget: ${t?.task?.budget ?? "-"} cents`)
    console.log(c.bold("\n2. Identity (ACK-ID)"))
    console.log(`   agent ${r.identity.agentDid}`)
    console.log(`   owner ${r.identity.ownerDid}`)
    console.log(`   ControllerCredential re-verified: ${ok(r.identity.controllerCredentialValid)} ${c.dim(r.identity.detail ?? "")}`)
    console.log(c.bold("\n3. What the agent said and did before the payment"))
    for (const s of r.reasoning) {
      if (s.text) console.log(`   [${s.seq}] ${c.cyan(s.text.slice(0, 400))}`)
      for (const tc of (s.toolCalls ?? []) as { toolName: string; input: unknown }[])
        console.log(`   [${s.seq}] tool ${tc.toolName} ${c.dim(JSON.stringify(tc.input).slice(0, 160))}`)
    }
    console.log(c.bold("\n4. Proposed payment"))
    console.log(`   agent's stated purpose: "${r.proposed.agentPurpose ?? ""}"`)
    if (r.proposed.request?.error) console.log(`   request: ${c.red(r.proposed.request.error)}`)
    else {
      console.log(`   signed by: ${r.proposed.request?.issuer}`)
      console.log(`   description: ${r.proposed.request?.description}`)
      for (const o of (r.proposed.request?.options ?? []) as { id: string; amount: string; recipient: string }[])
        console.log(`   option ${o.id}: ${o.amount} cents -> ${o.recipient}`)
    }
    console.log(c.bold("\n5. Policy decision"))
    for (const d of r.decisions) {
      const rule = d.rule as { id: string; detail: string }
      const col = d.outcome === "allow" ? c.green : d.outcome === "deny" ? c.red : c.yellow
      console.log(`   [${d.seq}] ${col(d.outcome.toUpperCase())} by ${c.bold(rule.id)}: ${rule.detail}${d.afterApproval ? " (after approval)" : ""}`)
      for (const ch of d.checks as { id: string; passed: boolean | null; detail: string }[])
        console.log(`        ${ch.passed === true ? c.green("pass") : ch.passed === false ? c.red("FAIL") : c.dim("skip")} ${ch.id.padEnd(20)} ${c.dim(ch.detail)}`)
    }
    if (r.approval) console.log(`   human approval: ${r.approval.approved ? c.green("approved") : c.red("declined")} by ${r.approval.by}`)
    console.log(c.bold("\n6. Settlement and ACK receipt"))
    if (r.error) console.log(`   ${c.red(`payment failed: ${r.error}`)}`)
    if (r.settlement) console.log(`   ledger tx ${r.settlement.tx.txId}: ${r.settlement.tx.amount} cents -> ${r.settlement.tx.to}`)
    else console.log("   no money moved")
    if (r.receipt) console.log(`   PaymentReceiptCredential re-verified (ACK verifyPaymentReceipt): ${ok(r.receipt.verifiedNow.ok)} ${c.dim(r.receipt.verifiedNow.error ?? `tx ${r.receipt.verifiedNow.txId}`)}`)
    console.log(c.bold("\n7. Log integrity"))
    console.log(`   whole log (${r.chain.entries} entries): ${ok(r.chain.ok)}${r.chain.ok ? "" : c.red(` first bad seq ${r.chain.firstBadSeq}`)}`)
    console.log(`   entries used in this replay (${r.chain.relatedSeqs.length}): ${ok(r.chain.relatedEntriesIntact)}`)
    console.log(`   signer: ${r.chain.pinned ? c.green(trust.source) : c.yellow(`${trust.source}. Identity and receipt checks above rely on the log's own genesis entry; pass --signer <guard DID> to pin.`)}`)
    if (!r.chain.ok) console.log(c.red(c.bold("\nThe log FAILS verification, so nothing above is trustworthy evidence.")))
    console.log(c.bold(`\nFinal outcome: ${r.finalOutcome}${r.trusted ? "" : " (unverified)"}\n`))
  }
}
