// Fails if anything that looks like a secret is tracked, or if .env / .data are tracked.
// (Audit logs contain JWS signatures and DIDs, which are public by design.)
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

const tracked = execSync("git ls-files -co --exclude-standard", { encoding: "utf8" }).split("\n").filter(Boolean)
const problems: string[] = []
for (const f of tracked) {
  if (f === ".env" || f.startsWith(".env.") && f !== ".env.example") problems.push(`${f}: env file must not be committed`)
  if (f.startsWith(".data/")) problems.push(`${f}: .data holds private keys and must not be committed`)
}
const PATTERNS: [string, RegExp][] = [
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["hex private key field", /"privateKeyHex"\s*:\s*"[0-9a-f]{32,}"/i],
]
for (const f of tracked) {
  if (f.endsWith("pnpm-lock.yaml") || f.startsWith("node_modules/")) continue
  let text: string
  try {
    text = readFileSync(f, "utf8")
  } catch {
    continue
  }
  for (const [name, re] of PATTERNS) if (re.test(text)) problems.push(`${f}: looks like a ${name}`)
}
if (problems.length) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`No secrets found in ${tracked.length} files.`)
