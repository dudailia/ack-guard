// Delegation chains on ACK-ID: owner -> agent -> sub-agent -> ...
//
// Each link is an ACK-ID ControllerCredential: the parent signs a credential
// whose subject is the child and whose controller claim is the parent (the
// child's did:web document names the parent as controller, which ACK's
// controller-claim verifier checks). A link may carry a scope: a budget and
// the capabilities the child may buy, plus an expiry. ACK's verifier checks
// the signature and expiry; this module checks that the links form one chain
// from the owner to the payer. The policy engine (DELEGATION_LIMITS) checks
// that every purchase fits every link's scope, with spend under a link
// counted across its whole subtree, so a child never exceeds what its parent
// has left.

import { createHash } from "node:crypto"
import {
  createDidWebDocumentFromKeypair,
  createJwtSigner,
  curveToJwtAlgorithm,
  generateKeypair,
  getControllerClaimVerifier,
  parseJwtCredential,
  signCredential,
  verifyParsedCredential,
  verifyJwt,
  createCredential,
  type DidResolver,
  type DidUri,
  type JwtString,
} from "agentcommercekit"
import type { Party } from "./identities.js"

export interface DelegationScope {
  /** Total the child may spend under this link, in cents. */
  budget: bigint
  currency: "USD"
  /** Capabilities the child may buy, e.g. ["weather.forecast"]. */
  capabilities: string[]
}

export interface LinkFacts {
  index: number
  id: string
  issuer?: string
  subject?: string
  scope?: { budget: string; currency: string; capabilities: string[] }
  expiresAt?: string
  ok: boolean
  error?: string
}

export interface ChainVerification {
  ok: boolean
  error?: string
  /** The verified links, root first. */
  links: LinkFacts[]
  payerDid?: string
}

export const linkId = (jwt: string) => `link:${createHash("sha256").update(jwt).digest("hex").slice(0, 16)}`

/** A parent delegates to a child: a signed ControllerCredential carrying the scope. */
export async function issueDelegation(opts: {
  parent: Party
  childDid: DidUri
  scope?: DelegationScope
  expiresAt?: Date
  issuedAt?: Date
  /** For forgery tests: sign as `parent.did` with someone else's key. */
  signWith?: Party
}): Promise<JwtString> {
  const credential = createCredential({
    type: "ControllerCredential",
    issuer: opts.parent.did,
    subject: opts.childDid,
    attestation: {
      controller: opts.parent.did,
      ...(opts.scope
        ? { delegation: { budget: opts.scope.budget.toString(), currency: opts.scope.currency, capabilities: opts.scope.capabilities } }
        : {}),
    },
    issuanceDate: opts.issuedAt,
    expirationDate: opts.expiresAt,
  })
  const signer = opts.signWith ?? opts.parent
  return signCredential(credential, { did: opts.parent.did, signer: signer.signer, alg: signer.alg })
}

/** A sub-agent identity: a did:web whose DID document names its parent as controller. */
export async function createSubAgent(name: string, parentDid: DidUri, resolver: DidResolver, baseUrl: string, privateKey?: Uint8Array): Promise<Party> {
  const keypair = await generateKeypair("secp256k1", privateKey)
  const { did, didDocument } = createDidWebDocumentFromKeypair({ keypair, baseUrl: `${baseUrl}/sub/${name}`, controller: parentDid })
  resolver.addToCache(did, didDocument)
  return { name, did, keypair, signer: createJwtSigner(keypair), alg: curveToJwtAlgorithm(keypair.curve) }
}

/** Unverified labels (issuer, subject, expiry) so an error can say which link failed. Never trusted. */
function peekLink(jwt: string): Pick<LinkFacts, "issuer" | "subject" | "expiresAt"> {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { iss?: string; sub?: string; exp?: number; vc?: { expirationDate?: string } }
    return { issuer: p.iss, subject: p.sub, expiresAt: p.vc?.expirationDate ?? (p.exp ? new Date(p.exp * 1000).toISOString() : undefined) }
  } catch {
    return {}
  }
}

function short(did?: string) {
  if (!did) return "?"
  const parts = did.split(":")
  return did.startsWith("did:web:") ? parts.slice(-1)[0]! : `${did.slice(0, 16)}...`
}

/**
 * Verifies a delegation chain, root first. Link 0 must be issued by the owner;
 * each later link by the previous link's subject; the last link's subject is
 * the payer. Every link must pass ACK's credential verification (signature,
 * expiry, controller claim).
 */
export async function verifyDelegationChain(
  chain: string[],
  opts: { resolver: DidResolver; ownerDid: string; rootAgentDid: string; payerDid: string },
): Promise<ChainVerification> {
  const links: LinkFacts[] = []
  let expectedIssuer = opts.ownerDid
  let firstError: string | undefined
  for (let i = 0; i < chain.length; i++) {
    const jwt = chain[i]!
    const lf: LinkFacts = { index: i, id: linkId(jwt), ok: false, ...peekLink(jwt) }
    links.push(lf)
    try {
      const parsed = await parseJwtCredential(jwt as JwtString, opts.resolver)
      lf.issuer = typeof parsed.issuer === "string" ? parsed.issuer : parsed.issuer.id
      lf.subject = parsed.credentialSubject?.id as string | undefined
      lf.expiresAt = parsed.expirationDate
      const d = (parsed.credentialSubject as { delegation?: { budget?: unknown; currency?: unknown; capabilities?: unknown } }).delegation
      if (d) {
        if (typeof d.budget !== "string" || !/^\d+$/.test(d.budget) || d.currency !== "USD" || !Array.isArray(d.capabilities) || !d.capabilities.every((x) => typeof x === "string"))
          throw new Error("malformed delegation scope")
        lf.scope = { budget: d.budget, currency: d.currency, capabilities: d.capabilities as string[] }
      }
      const verified = await verifyParsedCredential(parsed, {
        resolver: opts.resolver,
        trustedIssuers: [expectedIssuer],
        verifiers: [getControllerClaimVerifier()],
      })
      const controller = (verified.credentialSubject as { controller?: string }).controller
      if (controller !== expectedIssuer) throw new Error(`controller ${short(controller)} is not the parent ${short(expectedIssuer)}`)
      if (i === 0 && lf.subject !== opts.rootAgentDid) throw new Error(`the root link is for ${short(lf.subject)}, not the configured agent`)
      lf.ok = true
      expectedIssuer = lf.subject!
    } catch (e) {
      const msg = (e as Error).message
      const why = /expired/i.test(msg)
        ? `expired${lf.expiresAt ? ` at ${lf.expiresAt}` : ""}`
        : /not trusted/i.test(msg)
          ? `issued by ${short(lf.issuer)}, not by the parent ${short(expectedIssuer)}`
          : /signature|proof|invalid/i.test(msg)
            ? "signature does not verify for the issuer it names"
            : msg
      lf.error = why
      firstError ??= `link ${i} (${short(lf.issuer)} -> ${short(lf.subject)}): ${why}`
      break
    }
  }
  if (!firstError && links[links.length - 1]?.subject !== opts.payerDid) firstError = `the chain ends at ${short(links[links.length - 1]?.subject)}, not at the paying agent ${short(opts.payerDid)}`
  if (!firstError && !chain.length) firstError = "empty delegation chain"
  return { ok: !firstError, error: firstError, links, payerDid: opts.payerDid }
}

/**
 * Verifies a chain as of a past moment (the payment time), for dispute
 * evidence that must still check out after its links expire. Each link's JWT
 * signature and expiry are checked by ACK's verifyJwt with the clock set to
 * `at`, then ACK's controller-claim verifier runs on the credential subject.
 */
export async function verifyDelegationChainAt(
  chain: string[],
  opts: { resolver: DidResolver; ownerDid: string; rootAgentDid: string; payerDid: string; at: Date },
): Promise<ChainVerification> {
  const links: LinkFacts[] = []
  let expectedIssuer = opts.ownerDid
  let firstError: string | undefined
  const now = Math.floor(opts.at.getTime() / 1000)
  for (let i = 0; i < chain.length; i++) {
    const jwt = chain[i]!
    const lf: LinkFacts = { index: i, id: linkId(jwt), ok: false, ...peekLink(jwt) }
    links.push(lf)
    try {
      const v = await verifyJwt(jwt, { resolver: opts.resolver, issuer: expectedIssuer, policies: { now, aud: false } })
      const vc = (v.payload as { vc?: { type?: string[]; credentialSubject?: Record<string, unknown>; expirationDate?: string } }).vc
      if (!vc?.type?.includes("ControllerCredential")) throw new Error("not a ControllerCredential")
      const subject: Record<string, unknown> & { id: string } = { ...vc.credentialSubject, id: v.payload.sub as string }
      if (vc.expirationDate && Date.parse(vc.expirationDate) < opts.at.getTime()) throw new Error(`expired at ${vc.expirationDate}`)
      if (subject.controller !== expectedIssuer) throw new Error(`controller ${short(subject.controller as string)} is not the parent ${short(expectedIssuer)}`)
      await getControllerClaimVerifier().verify(subject, opts.resolver)
      const d = subject.delegation as { budget: string; currency: string; capabilities: string[] } | undefined
      if (d) lf.scope = { budget: d.budget, currency: d.currency, capabilities: d.capabilities }
      if (i === 0 && lf.subject !== opts.rootAgentDid) throw new Error(`the root link is for ${short(lf.subject)}, not the configured agent`)
      lf.ok = true
      expectedIssuer = lf.subject!
    } catch (e) {
      const msg = (e as Error).message
      lf.error = /expired/i.test(msg) ? msg : /issuer/i.test(msg) ? `issued by ${short(lf.issuer)}, not by the parent ${short(expectedIssuer)}` : /signature/i.test(msg) ? "signature does not verify for the issuer it names" : msg
      firstError = `link ${i} (${short(lf.issuer)} -> ${short(lf.subject)}): ${lf.error}`
      break
    }
  }
  if (!firstError && links[links.length - 1]?.subject !== opts.payerDid) firstError = `the chain ends at ${short(links[links.length - 1]?.subject)}, not at the paying agent ${short(opts.payerDid)}`
  return { ok: !firstError, error: firstError, links, payerDid: opts.payerDid }
}
