import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.split("=").slice(1).join("=") : fallback
}

export function flag(name: string) {
  return process.argv.includes(`--${name}`)
}

export function positional(): string[] {
  const out: string[] = []
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith("--")) {
      if (!a[i]!.includes("=") && a[i + 1] && !a[i + 1]!.startsWith("--")) i++
      continue
    }
    out.push(a[i]!)
  }
  return out
}

/** Find all audit logs under results/ and .data/, newest first. */
export function findLogs(root = process.cwd()): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir) || depth > 4) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      const s = statSync(p)
      if (s.isDirectory()) walk(p, depth + 1)
      else if (name.endsWith(".jsonl") && name.startsWith("audit")) found.push(p)
    }
  }
  walk(join(root, ".data"), 0)
  walk(join(root, "results"), 0)
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

export function defaultLog(): string {
  const l = arg("log") ?? findLogs()[0]
  if (!l) {
    console.error("No audit log found. Run `pnpm demo` or `pnpm redteam` first, or pass --log <path>.")
    process.exit(1)
  }
  return l
}

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}
