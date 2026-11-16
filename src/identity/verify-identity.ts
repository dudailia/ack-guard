// Verify an agent's ACK-ID ControllerCredential: signature, issuer trust,
// the controller claim (agent DID document names the controller), and that
// the controller is the owner we expect.

import {
  getControllerClaimVerifier,
  isControllerCredential,
  parseJwtCredential,
  verifyParsedCredential,
  type DidResolver,
} from "agentcommercekit"

export interface IdentityVerification {
  ok: boolean
  agentDid?: string
  controller?: string
  issuer?: string
  error?: string
}

export async function verifyAgentIdentity(
  controllerCredentialJwt: string,
  opts: { resolver: DidResolver; expectedOwnerDid: string; expectedAgentDid?: string },
): Promise<IdentityVerification> {
  try {
    const parsed = await parseJwtCredential(controllerCredentialJwt, opts.resolver)
    const verified = await verifyParsedCredential(parsed, {
      resolver: opts.resolver,
      trustedIssuers: [opts.expectedOwnerDid],
      verifiers: [getControllerClaimVerifier()],
    })
    if (!isControllerCredential(verified)) {
      return { ok: false, error: "credential is not a ControllerCredential" }
    }
    const agentDid = verified.credentialSubject.id
    const controller = verified.credentialSubject.controller
    const issuer = typeof verified.issuer === "string" ? verified.issuer : verified.issuer.id
    if (controller !== opts.expectedOwnerDid) {
      return { ok: false, agentDid, controller, issuer, error: "controller is not the configured owner" }
    }
    if (opts.expectedAgentDid && agentDid !== opts.expectedAgentDid) {
      return { ok: false, agentDid, controller, issuer, error: "credential subject is not this agent" }
    }
    return { ok: true, agentDid, controller, issuer }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}
