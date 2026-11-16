import { existsSync } from "node:fs"
import { join } from "node:path"
import { buildIdentities, loadOrCreateKeyFile } from "../identity/identities.js"

export function loadEnv() {
  const p = join(process.cwd(), ".env")
  if (existsSync(p)) process.loadEnvFile(p)
}

export const KEY_FILE = join(process.cwd(), ".data", "keys.json")

/** Persistent local identities (keys in .data/keys.json, gitignored). */
export function localIdentities() {
  return buildIdentities(loadOrCreateKeyFile(KEY_FILE))
}

export function modelSlug(id: string) {
  return id.replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()
}
