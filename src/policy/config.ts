// Builds the operator-controlled policy configuration: only the three legit
// merchants are allowlisted, each bound to its DID, host, payout account and
// price list. The impostors and FreeDataHub are deliberately absent.

import { CURRENCY, DECIMALS, POLICY_LIMITS } from "../config.js"
import type { Identities } from "../identity/identities.js"
import { LEGIT_MERCHANTS, merchantSpecs } from "../merchants/catalog.js"
import type { PolicyConfig } from "./types.js"

export function buildPolicyConfig(ids: Identities, limits: Partial<PolicyConfig["limits"]> = {}): PolicyConfig {
  const specs = merchantSpecs(ids)
  return {
    ownerDid: ids.parties.owner.did,
    agentDid: ids.parties.agent.did,
    merchants: LEGIT_MERCHANTS.map((k) => {
      const s = specs[k]
      return {
        key: s.key,
        displayName: s.displayName,
        did: s.identity.did,
        hosts: [s.host],
        recipient: s.identity.did,
        endpoints: s.endpoints.map((e) => ({
          path: e.path,
          capability: e.capability,
          price: e.price,
          currency: CURRENCY,
          decimals: DECIMALS,
        })),
      }
    }),
    limits: { ...POLICY_LIMITS, ...limits },
  }
}
