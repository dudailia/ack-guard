// One-page PDF summary of a dispute evidence pack (pdf-lib, standard fonts).
// The PDF is for people; the signed JSON pack is the evidence.

import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib"
import type { DisputePack } from "./pack.js"

const INK = rgb(0.07, 0.23, 0.23)
const MUTED = rgb(0.36, 0.42, 0.41)
const GREEN = rgb(0.12, 0.42, 0.28)
const RED = rgb(0.64, 0.15, 0.17)
const AMBER = rgb(0.66, 0.42, 0.07)

/** Standard PDF fonts only cover WinAnsi; replace anything else. */
const safe = (s: unknown) => String(s ?? "").replace(/[^\x20-\x7e -ÿ]/g, "?")
const shortDid = (d?: string) => (!d ? "?" : d.startsWith("did:web:") ? d.split(":").slice(-1)[0]! : d.length > 28 ? `${d.slice(0, 20)}...${d.slice(-6)}` : d)

export async function renderDisputePdf(pack: DisputePack): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Dispute evidence: ${pack.subject.attemptId}`)
  doc.setProducer("ACK Guard")
  doc.setCreator("ACK Guard (pnpm dispute)")
  const page = doc.addPage([612, 792])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const mono = await doc.embedFont(StandardFonts.Courier)
  const M = 44
  const W = 612 - 2 * M
  let y = 792 - M

  const lines = (text: string, f: PDFFont, size: number, width: number) => {
    const out: string[] = []
    for (const para of safe(text).split("\n")) {
      let cur = ""
      for (const word of para.split(/\s+/)) {
        const next = cur ? `${cur} ${word}` : word
        if (f.widthOfTextAtSize(next, size) <= width) cur = next
        else {
          if (cur) out.push(cur)
          // Break words longer than the line (DIDs, hashes).
          let w = word
          while (f.widthOfTextAtSize(w, size) > width) {
            let n = w.length
            while (n > 1 && f.widthOfTextAtSize(w.slice(0, n), size) > width) n--
            out.push(w.slice(0, n))
            w = w.slice(n)
          }
          cur = w
        }
      }
      out.push(cur)
    }
    return out
  }
  const text = (t: string, o: { f?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; x?: number; width?: number; max?: number } = {}) => {
    const f = o.f ?? font
    const size = o.size ?? 8.5
    const ls = lines(t, f, size, o.width ?? W - (o.x ?? 0))
    for (const l of ls.slice(0, o.max ?? 99)) {
      page.drawText(l, { x: M + (o.x ?? 0), y, size, font: f, color: o.color ?? INK })
      y -= size * 1.32
    }
  }
  const heading = (t: string) => {
    y -= 5
    page.drawText(safe(t), { x: M, y, size: 9.5, font: bold, color: INK })
    y -= 3
    page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.5, color: rgb(0.81, 0.85, 0.84) })
    y -= 10
  }
  const kv = (k: string, v: string, color?: ReturnType<typeof rgb>) => {
    page.drawText(safe(k), { x: M, y, size: 8, font: bold, color: MUTED })
    const yy = y
    text(v, { x: 110, size: 8, color, max: 3 })
    if (y === yy) y -= 10.5
  }

  const s = pack.subject
  const paid = s.outcome === "paid"
  page.drawText("Payment dispute evidence", { x: M, y, size: 17, font: bold, color: INK })
  y -= 15
  text(`ACK Guard evidence pack, ${pack.format}. Generated ${pack.generatedAt.slice(0, 19).replace("T", " ")} UTC. Sandbox: fictional merchants, no real money.`, { size: 8, color: MUTED })
  y -= 4

  // Outcome banner
  const bannerColor = paid ? (s.mode !== "guarded" ? AMBER : GREEN) : s.outcome === "needs_approval" ? AMBER : RED
  const naive = s.mode !== "guarded" || s.decidingRule === "NO_GUARD"
  const verdict = paid
    ? `PAID ${s.amount ?? ""} to ${s.merchant ?? "the merchant"} ${s.endpoint ?? ""}: ${naive ? "naive agent, no policy was applied" : "every policy rule passed"}`
    : s.outcome === "failed"
      ? "NOT PAID: the guard allowed it, but settlement failed"
      : `NOT PAID: ${s.outcome === "needs_approval" ? "held for a human, who declined" : `blocked by ${s.decidingRule}`}`
  page.drawRectangle({ x: M, y: y - 30, width: W, height: 36, color: rgb(0.97, 0.98, 0.97), borderColor: bannerColor, borderWidth: 1.2 })
  y -= 12
  text(verdict, { f: bold, size: 11, color: bannerColor, x: 10, width: W - 20, max: 1 })
  text(`${s.decidingDetail ?? ""}`, { size: 8, x: 10, width: W - 20, max: 1 })
  y -= 10

  heading("Payment")
  kv("Attempt", `${s.attemptId} at ${s.attemptedAt.replace("T", " ").slice(0, 19)} UTC`)
  kv("Paid by", `${shortDid(s.payer)} (${s.mode} agent)`)
  if (s.txId) kv("Ledger tx", s.txId)

  heading("Task, as set by the owner")
  const t = (pack.task.task ?? {}) as { prompt?: string; needs?: string[]; budget?: string }
  text(t.prompt ?? "", { size: 8, max: 4 })
  kv("Declared needs", (t.needs ?? []).join(", "))
  kv("Budget", `$${(Number(t.budget ?? 0) / 100).toFixed(2)}`)

  heading("Delegation chain (ACK-ID ControllerCredentials)")
  for (const l of pack.delegation.links) {
    const sc = l.scope ? `budget $${(Number(l.scope.budget) / 100).toFixed(2)}, may buy ${l.scope.capabilities.join(", ")}` : "no limits on this link"
    text(`${l.index}. ${shortDid(l.issuer)} -> ${shortDid(l.subject)}: ${sc}${l.expiresAt ? `, expires ${l.expiresAt.slice(0, 16)}` : ""}. ${l.ok ? "Valid at payment time." : `INVALID: ${l.error}`}`, {
      size: 8,
      color: l.ok ? INK : RED,
      max: 2,
    })
  }
  if (!pack.delegation.ok && pack.delegation.error) text(pack.delegation.error, { size: 8, color: RED, max: 2 })

  heading(`Policy ${pack.policy.version ?? "(version recorded in genesis)"} and the rule that decided`)
  const checks = pack.policy.checks as { id: string; passed: boolean | null; detail: string }[]
  const col = W / 2
  const startY = y
  checks.forEach((c, i) => {
    const x = i < Math.ceil(checks.length / 2) ? 0 : col
    if (i === Math.ceil(checks.length / 2)) y = startY
    const mark = c.passed === true ? "pass" : c.passed === false ? "FAIL" : "skip"
    page.drawText(mark, { x: M + x, y, size: 7.5, font: bold, color: c.passed === false ? RED : c.passed ? GREEN : MUTED })
    page.drawText(safe(`${c.id}${c.id === s.decidingRule ? "  (decided)" : ""}`), { x: M + x + 26, y, size: 7.5, font: c.id === s.decidingRule ? bold : font, color: INK })
    y -= 10
  })
  y = startY - Math.ceil(checks.length / 2) * 10 - 2

  heading("What the agent did before paying")
  const steps = pack.agentReasoning.flatMap((r) => (r.toolCalls as { toolName: string; input: unknown }[] | undefined)?.map((tc) => `${tc.toolName} ${JSON.stringify(tc.input)}`) ?? [])
  for (const st of steps.slice(-5)) text(st, { f: mono, size: 7, max: 1 })
  if (steps.length > 5) text(`(${steps.length - 5} earlier steps in the pack)`, { size: 7, color: MUTED })

  heading("ACK receipt and payment request")
  kv("Payment request", `${pack.paymentRequest.ok ? "verifies" : "does NOT verify"}: signed by ${shortDid(pack.paymentRequest.issuer)}, "${pack.paymentRequest.description ?? ""}"`)
  kv("Receipt", pack.receipt ? `${pack.receipt.ok ? "verifies" : "does NOT verify"}: PaymentReceiptCredential from ${shortDid(pack.receipt.issuer)} for ${pack.receipt.txId ?? "?"}` : "none (no money moved)")

  heading("Verification results when the pack was built (pnpm dispute-verify re-runs them)")
  for (const [k, c] of Object.entries(pack.verification)) {
    page.drawText(c.ok ? "OK" : "FAIL", { x: M, y, size: 7.5, font: bold, color: c.ok ? GREEN : RED })
    page.drawText(safe(k), { x: M + 24, y, size: 7.5, font: bold, color: INK })
    const yy = y
    text(c.detail, { x: 112, size: 7.5, max: 1 })
    if (y === yy) y -= 10
  }

  heading("Check it yourself")
  text(pack.verifyCommand.replace("<this file>", "<pack.json>"), { f: mono, size: 7.5, max: 2 })
  text(`Pack hash ${pack.packHash ?? "?"}, signed by guard ${pack.signedBy}. Log ${pack.evidence.log}: ${pack.evidence.head.seq + 1} entries, signed head ${pack.evidence.head.hash}.`, { size: 7, color: MUTED, max: 3 })
  text("The pack proves what the guard recorded and signed for this attempt. To rule out a rolled-back or swapped log, compare the head hash with an independently published copy (pnpm verify-log --expect-head).", { size: 7, color: MUTED, max: 2 })

  drawFooter(page, font)
  return doc.save()
}

function drawFooter(page: PDFPage, font: PDFFont) {
  page.drawText("ACK Guard, built by Ilia Duda with Claude Code. Independent project, not affiliated with or endorsed by Catena Labs. Built on Agent Commerce Kit (MIT).", {
    x: 44,
    y: 24,
    size: 6.5,
    font,
    color: MUTED,
  })
}
