// Fails if any file we wrote contains an em dash (U+2014).
// Raw recorded model output under results/**.jsonl is excluded: it is data,
// reproduced verbatim, and editing it would falsify the record.
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const EM_DASH = String.fromCharCode(0x2014)
const files = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !/^results\/.*\.jsonl$/.test(f) && !f.endsWith("pnpm-lock.yaml"))
  .filter((f) => /\.(ts|js|mjs|json|md|html|css|txt|yaml|yml|example)$/.test(f) || !f.includes("."))

let bad = 0
for (const f of files) {
  let text: string
  try {
    text = readFileSync(f, "utf8")
  } catch {
    continue
  }
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) {
      bad++
      console.log(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`)
    }
  })
}
if (bad) {
  console.error(`\n${bad} line(s) contain an em dash.`)
  process.exit(1)
}
console.log(`No em dashes in ${files.length} files.`)
