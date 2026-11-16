// Renders MEMO-for-Catena.md to docs/memo.pdf: one US Letter page, for attaching to an email.
// The Markdown is the source; this script handles only the subset the memo uses
// (title, paragraphs, bold, italics, inline code, one table, bullet and numbered lists)
// and fails if the result is not exactly one page.
// Requires: `npx playwright install chromium`.

import { readFileSync, writeFileSync } from "node:fs"
import { PDFDocument } from "pdf-lib"
import { chromium } from "playwright"

const SRC = "MEMO-for-Catena.md"
const OUT = "docs/memo.pdf"

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const inline = (s: string) =>
  esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/(github\.com\/dudailia\/ack-guard|dudailia\.github\.io\/ack-guard)/g, (u) => `<a href="https://${u}${u.endsWith("ack-guard") && u.startsWith("dudailia") ? "/" : ""}">${u}</a>`)

function toHtml(md: string): { title: string; body: string } {
  const lines = md.split("\n")
  let title = ""
  const out: string[] = []
  let i = 0
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
  while (i < lines.length) {
    const l = lines[i]!
    if (!l.trim()) {
      i++
      continue
    }
    if (l.startsWith("# ")) {
      title = l.slice(2)
      out.push(`<h1>${inline(title)}</h1>`)
      i++
    } else if (l.startsWith("|")) {
      const head = cells(l)
      i += 2 // header and separator
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.startsWith("|")) rows.push(cells(lines[i++]!))
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      )
    } else if (/^- /.test(l) || /^\d+\. /.test(l)) {
      const ordered = /^\d+\. /.test(l)
      const items: string[] = []
      while (i < lines.length && (ordered ? /^\d+\. /.test(lines[i]!) : /^- /.test(lines[i]!))) items.push(lines[i++]!.replace(/^(- |\d+\. )/, ""))
      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${tag}>`)
    } else {
      const para: string[] = []
      while (i < lines.length && lines[i]!.trim() && !/^(#|\||- |\d+\. )/.test(lines[i]!)) para.push(lines[i++]!)
      out.push(`<p>${inline(para.join(" "))}</p>`)
    }
  }
  return { title, body: out.join("\n") }
}

const { title, body } = toHtml(readFileSync(SRC, "utf8"))
if (/\u2014/.test(body)) throw new Error("the memo contains an em dash")

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  @page { size: Letter; margin: 0.45in 0.6in 0.45in; }
  :root { --ink: #14302f; --muted: #52605e; --rule: #c9d3d1; --accent: #1f6b47; }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: var(--ink); font: 8.5pt/1.34 "Helvetica Neue", Helvetica, Arial, sans-serif; }
  h1 { font-size: 14.5pt; line-height: 1.2; margin: 0 0 3pt; letter-spacing: -0.01em; }
  h1 + p { color: var(--muted); margin: 0 0 7pt; padding-bottom: 6pt; border-bottom: 1.2pt solid var(--accent); }
  p { margin: 0 0 5pt; }
  strong { font-weight: 700; }
  em { font-style: italic; }
  a { color: inherit; text-decoration: none; border-bottom: 0.5pt solid var(--rule); white-space: nowrap; }
  code { font: 7.9pt/1 Menlo, "SF Mono", Consolas, monospace; background: #eef3f2; padding: 0 2pt; border-radius: 2pt; }
  table { border-collapse: collapse; width: 100%; margin: 3pt 0 7pt; font-size: 7.8pt; line-height: 1.3; }
  th { text-align: left; font-weight: 700; border-bottom: 0.9pt solid var(--ink); padding: 2pt 5pt 2pt 0; }
  td { vertical-align: top; border-bottom: 0.5pt solid var(--rule); padding: 2.5pt 6pt 2.5pt 0; }
  td:first-child { font-weight: 600; width: 19%; }
  td:last-child { color: var(--muted); width: 17%; }
  ul, ol { margin: 0 0 5pt; padding-left: 13pt; }
  li { margin: 0 0 2.5pt; }
</style></head><body>${body}</body></html>`

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  await page.setViewportSize({ width: 701, height: 970 })
  await page.setContent(html, { waitUntil: "load" })
  const used = await page.evaluate(() => document.body.scrollHeight)
  console.log(`content height ${used}px of 970px available`)
  const pdf = await page.pdf({ format: "Letter", printBackground: true, preferCSSPageSize: true })
  const doc = await PDFDocument.load(pdf)
  if (doc.getPageCount() !== 1) throw new Error(`the memo renders to ${doc.getPageCount()} pages; it must fit on one`)
  doc.setTitle(title)
  doc.setAuthor("Ilia Duda")
  doc.setCreator("ACK Guard (pnpm memo-pdf)")
  writeFileSync(OUT, await doc.save())
  console.log(`Wrote ${OUT} (1 page) from ${SRC}`)
} finally {
  await browser.close()
}
