// The guard's policy configuration, loaded from policy.yaml at the repository
// root. Merchant keys resolve to this machine's merchant identities; only the
// three legit merchants are listed, so the impostors and FreeDataHub are
// absent by construction.

import type { Identities } from "../identity/identities.js"
import { loadPolicyFile, policyConfig, type LoadedPolicy } from "./policy-file.js"
import type { PolicyConfig } from "./types.js"

export function resolverFor(ids: Identities) {
  return (key: string) => {
    const p = (ids.parties as Record<string, { did: string } | undefined>)[key]
    return p ? { did: p.did, recipient: p.did } : undefined
  }
}

export function configFor(ids: Identities, policy: LoadedPolicy): PolicyConfig {
  return policyConfig(policy, { ownerDid: ids.parties.owner.did, agentDid: ids.parties.agent.did }, resolverFor(ids))
}

/** The repository policy (policy.yaml), optionally with overridden limits (tests). */
export function buildPolicyConfig(ids: Identities, limits: Partial<PolicyConfig["limits"]> = {}): PolicyConfig {
  const c = configFor(ids, loadPolicyFile())
  return { ...c, limits: { ...c.limits, ...limits } }
}
