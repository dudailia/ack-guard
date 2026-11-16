// Identities for every party in the sandbox, built with ACK-ID primitives.
//
// - The owner (a human principal) has a did:key.
// - The agent has a did:web whose DID document names the owner as `controller`,
//   and carries an ACK-ID ControllerCredential signed by the owner. This mirrors
//   the pattern in Catena's ACK e2e demo (demos/e2e/src/agent.ts).
// - Merchants, the receipt service, the guard and attackers have did:key DIDs.
//
// Keys are generated on first run and stored in .data/keys.json (gitignored).
// Tests use ephemeral keys.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import {
  bytesToHexString,
  createControllerCredential,
  createDidDocumentFromKeypair,
  createDidKeyUri,
  createDidWebDocumentFromKeypair,
  createJwtSigner,
  curveToJwtAlgorithm,
  generateKeypair,
  generatePrivateKeyBytes,
  hexStringToBytes,
  signCredential,
  type DidDocument,
  type DidResolver,
  type DidUri,
  type JwtAlgorithm,
  type JwtSigner,
  type JwtString,
  type KeyCurve,
  type Keypair,
} from "agentcommercekit"
import { offlineDidResolver } from "./offline-resolver.js"

export interface Party {
  name: string
  did: DidUri
  keypair: Keypair
  signer: JwtSigner
  alg: JwtAlgorithm
}

export const PARTY_NAMES = [
  "owner",
  "agent",
  "guard",
  "receipts",
  "skycast",
  "lingua",
  "geopoint",
  "skycastImpostor",
  "linguaImpostor",
  "freedatahub",
  "attacker",
  // Added with delegation chains: a sub-agent the research agent delegates to.
  "subagent",
] as const
export type PartyName = (typeof PARTY_NAMES)[number]

const CURVES: Record<PartyName, KeyCurve> = {
  owner: "secp256k1",
  agent: "secp256k1",
  guard: "Ed25519",
  receipts: "secp256k1",
  skycast: "secp256k1",
  lingua: "secp256k1",
  geopoint: "secp256k1",
  skycastImpostor: "secp256k1",
  linguaImpostor: "secp256k1",
  freedatahub: "secp256k1",
  attacker: "secp256k1",
  subagent: "secp256k1",
}

export const AGENT_DID_BASE_URL = "https://agents.ack-guard.example/research-agent"

export interface Identities {
  parties: Record<PartyName, Party>
  resolver: DidResolver
  agentDidDocument: DidDocument
  /** ACK-ID ControllerCredential (JWT) proving owner controls agent. */
  controllerCredential: JwtString
}

type KeyFile = Record<string, { curve: KeyCurve; privateKeyHex: string }>

export function generateKeyFile(): KeyFile {
  const out: KeyFile = {}
  for (const name of PARTY_NAMES) {
    const curve = CURVES[name]
    out[name] = { curve, privateKeyHex: bytesToHexString(generatePrivateKeyBytes(curve)) }
  }
  return out
}

export function loadOrCreateKeyFile(path: string): KeyFile {
  // Existing keys are never replaced: logs and results are pinned to them.
  // Parties added in a later version get new keys alongside the old ones.
  const keys: KeyFile = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as KeyFile) : {}
  const missing = PARTY_NAMES.filter((n) => !keys[n])
  if (!missing.length) return keys
  for (const name of missing) keys[name] = { curve: CURVES[name], privateKeyHex: bytesToHexString(generatePrivateKeyBytes(CURVES[name])) }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 })
  return keys
}

export async function buildIdentities(keyFile: KeyFile = generateKeyFile()): Promise<Identities> {
  const resolver = offlineDidResolver()
  const parties = {} as Record<PartyName, Party>
  let agentDidDocument: DidDocument | undefined

  // Owner first: the agent's DID document references the owner as controller.
  const ordered: PartyName[] = ["owner", ...PARTY_NAMES.filter((n) => n !== "owner")]
  for (const name of ordered) {
    const entry = keyFile[name]
    if (!entry) throw new Error(`missing key for ${name}`)
    const keypair = await generateKeypair(entry.curve, hexStringToBytes(entry.privateKeyHex))
    let did: DidUri
    if (name === "agent") {
      const { did: webDid, didDocument } = createDidWebDocumentFromKeypair({
        keypair,
        baseUrl: AGENT_DID_BASE_URL,
        controller: parties.owner.did,
      })
      did = webDid
      agentDidDocument = didDocument
      // did:web would normally resolve over HTTPS. In the sandbox the document
      // is pre-registered in the resolver cache (same approach as ACK demos).
      resolver.addToCache(did, didDocument)
    } else if (name === "subagent") {
      // A did:web whose DID document names the research agent as its controller.
      const { did: webDid, didDocument } = createDidWebDocumentFromKeypair({
        keypair,
        baseUrl: `${AGENT_DID_BASE_URL}/sub/forecaster`,
        controller: parties.agent.did,
      })
      did = webDid
      resolver.addToCache(did, didDocument)
    } else {
      did = createDidKeyUri(keypair)
      resolver.addToCache(did, createDidDocumentFromKeypair({ did, keypair }))
    }
    parties[name] = { name, did, keypair, signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve) }
  }

  const owner = parties.owner
  const credential = createControllerCredential({ subject: parties.agent.did, controller: owner.did })
  const controllerCredential = await signCredential(credential, {
    did: owner.did,
    signer: owner.signer,
    alg: owner.alg,
  })

  return { parties, resolver, agentDidDocument: agentDidDocument!, controllerCredential }
}
