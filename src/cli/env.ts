import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createDidKeyUri, generateKeypair, hexStringToBytes, type KeyCurve } from "agentcommercekit"
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

/** This machine's guard DID, derived from .data/keys.json, without creating keys. */
export async function operatorGuardDid(): Promise<string | undefined> {
  if (!existsSync(KEY_FILE)) return undefined
  try {
    const keys = JSON.parse(readFileSync(KEY_FILE, "utf8")) as Record<string, { curve: KeyCurve; privateKeyHex: string }>
    const g = keys.guard
    if (!g) return undefined
    return createDidKeyUri(await generateKeypair(g.curve, hexStringToBytes(g.privateKeyHex)))
  } catch {
    return undefined
  }
}
