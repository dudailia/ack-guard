// A DID resolver that never touches the network. did:key resolves locally;
// did:web documents must already be in the cache (addToCache). A forged log
// that names some did:web as its signer therefore cannot make the verifier
// fetch a real host.

import { getDidResolver, type DidResolver } from "agentcommercekit"

export function offlineDidResolver(): DidResolver {
  const refuse = async (input: unknown): Promise<Response> => {
    throw new Error(`offline resolver: refusing to fetch ${String(input)}`)
  }
  return getDidResolver({ webOptions: { fetch: refuse as typeof fetch, allowedHttpHosts: [] } })
}
