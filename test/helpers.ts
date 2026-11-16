import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AuditLog } from "../src/audit/chain.js"
import { buildIdentities, type Identities } from "../src/identity/identities.js"

let cached: Promise<Identities> | undefined
export function testIdentities() {
  cached ??= buildIdentities()
  return cached
}

export function tmpLogPath(name = "audit.jsonl") {
  return join(mkdtempSync(join(tmpdir(), "ack-guard-")), name)
}

export async function tmpAudit(ids: Identities) {
  const log = new AuditLog(tmpLogPath(), ids.parties.guard)
  await log.append("genesis", { guardDid: ids.parties.guard.did, agentDid: ids.parties.agent.did })
  return log
}
