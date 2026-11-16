import type { Identities } from "../identity/identities.js"
import type { PolicyConfig } from "../policy/types.js"
import type { AuditLog } from "./chain.js"

/** First entry of every log: who signs it, who the agent and owner are, and the policy in force. */
export async function writeGenesis(audit: AuditLog, ids: Identities, policy: PolicyConfig, meta: Record<string, unknown> = {}) {
  if (audit.entries.length > 0) return audit.entries[0]
  return audit.append("genesis", {
    guardDid: ids.parties.guard.did,
    ownerDid: ids.parties.owner.did,
    agentDid: ids.parties.agent.did,
    agentDidDocument: ids.agentDidDocument,
    controllerCredential: ids.controllerCredential,
    receiptServiceDid: ids.parties.receipts.did,
    policy: {
      merchants: policy.merchants.map((m) => ({ ...m, endpoints: m.endpoints.map((e) => ({ ...e, price: e.price.toString() })) })),
      limits: Object.fromEntries(Object.entries(policy.limits).map(([k, v]) => [k, v.toString()])),
    },
    ...meta,
  })
}
