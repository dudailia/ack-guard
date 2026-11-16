// The static demo: the build produces a verifiable log with one paid and one
// blocked attempt, and the in-browser verifier (site/verify.js, run here in
// Node's WebCrypto) catches every kind of edit at the right position.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
// @ts-expect-error plain browser JavaScript module, no type declarations
import { entryHash, verifyEntries } from "../site/verify.js"

type Entry = { seq: number; kind: string; hash: string; prevHash: string; sig: string; payload: Record<string, any> }
let data: { log: Entry[]; head: { seq: number; hash: string; sig: string }; guardDid: string; steps: Record<string, { attemptId: string; replay: any }> }

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), "ack-guard-site-test-"))
  execFileSync("npx", ["tsx", "scripts/build-site.ts", out], { stdio: "pipe" })
  data = JSON.parse(readFileSync(join(out, "data", "demo.json"), "utf8"))
}, 120_000)

describe("static demo", () => {
  it("contains one paid and one blocked attempt, with trusted replays", () => {
    expect(data.steps.legit!.replay.finalOutcome).toBe("paid")
    expect(data.steps.legit!.replay.receipt.verifiedNow.ok).toBe(true)
    expect(data.steps.attack!.replay.finalOutcome).toBe("deny")
    expect(data.steps.attack!.replay.decisions.at(-1).rule.id).toBe("REQ_PROVENANCE")
    expect(data.steps.legit!.replay.trusted && data.steps.attack!.replay.trusted).toBe(true)
  })

  it("the browser verifier accepts the log, signatures included", async () => {
    const v = await verifyEntries(data.log, data.head, data.guardDid)
    expect(v).toMatchObject({ ok: true, signaturesChecked: true })
  })

  it("catches edits, deletions, swaps, truncation and re-hashed forgeries at the right position", async () => {
    const check = async (log: Entry[]) => (await verifyEntries(log, data.head, data.guardDid)).firstBadPosition
    const i = data.log.findIndex((e) => e.kind === "decision" && e.payload.attemptId === data.steps.attack!.attemptId)
    const edited = structuredClone(data.log)
    edited[i]!.payload.decision.outcome = "allow"
    expect(await check(edited)).toBe(i)

    const deleted = structuredClone(data.log)
    deleted.splice(5, 1)
    expect(await check(deleted)).toBe(5)

    const swapped = structuredClone(data.log)
    ;[swapped[7], swapped[8]] = [swapped[8]!, swapped[7]!]
    expect(await check(swapped)).toBe(7)

    expect(await check(structuredClone(data.log).slice(0, 10))).toBe(10)

    // Forger without the key: edit, recompute this hash and every later link. Only signatures can catch it.
    const forged = structuredClone(data.log)
    forged[i]!.payload.decision.outcome = "allow"
    for (let k = i; k < forged.length; k++) {
      if (k > i) forged[k]!.prevHash = forged[k - 1]!.hash
      forged[k]!.hash = await entryHash(forged[k])
    }
    const v = await verifyEntries(forged, { ...data.head, hash: forged.at(-1)!.hash }, data.guardDid)
    expect(v.firstBadPosition).toBe(i)
    expect(v.problems[0].kind).toBe("bad_signature")

    // A log checked against the wrong key fails everywhere.
    expect(await check.call(null, data.log)).toBeNull()
    expect((await verifyEntries(data.log, data.head, "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")).firstBadPosition).toBe(0)
  })
})
