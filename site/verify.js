// In-browser verifier for an ACK Guard audit log (also runs in Node 22+).
// It re-implements src/audit/verify.ts without any server: it recomputes every
// entry's SHA-256 hash over canonical JSON, checks the chain links and the
// sequence, verifies each entry's EdDSA (Ed25519) JWT signature against the
// guard's did:key, and checks the signed head. No network access.

const GENESIS_PREV = "0".repeat(64)
const enc = new TextEncoder()

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .filter((k) => v[k] !== undefined)
        .map((k) => [k, sortDeep(v[k])]),
    )
  }
  return v
}
export const canonicalJson = (v) => JSON.stringify(sortDeep(v))

async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("")
}
export const entryHash = (e) => sha256hex(canonicalJson({ seq: e.seq, ts: e.ts, kind: e.kind, payload: e.payload, prevHash: e.prevHash }))

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
function base58decode(s) {
  let n = 0n
  for (const c of s) {
    const i = B58.indexOf(c)
    if (i < 0) throw new Error("bad base58")
    n = n * 58n + BigInt(i)
  }
  const bytes = []
  while (n > 0n) {
    bytes.unshift(Number(n % 256n))
    n /= 256n
  }
  for (const c of s) {
    if (c !== "1") break
    bytes.unshift(0)
  }
  return new Uint8Array(bytes)
}
function b64url(s) {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(b, (c) => c.charCodeAt(0))
}

/** The raw Ed25519 public key of a did:key (multicodec 0xed01). */
export function ed25519KeyFromDidKey(did) {
  if (!did.startsWith("did:key:z")) throw new Error("not a did:key")
  const bytes = base58decode(did.slice("did:key:z".length))
  if (bytes[0] !== 0xed || bytes[1] !== 0x01 || bytes.length !== 34) throw new Error("not an Ed25519 did:key")
  return bytes.slice(2)
}

const keyCache = new Map()
async function importKey(did) {
  if (!keyCache.has(did)) keyCache.set(did, crypto.subtle.importKey("raw", ed25519KeyFromDidKey(did), { name: "Ed25519" }, false, ["verify"]))
  return keyCache.get(did)
}

/** Feature check only: whether this browser's WebCrypto has Ed25519. */
let supported
export async function ed25519Supported() {
  supported ??= crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]).then(
    () => true,
    () => false,
  )
  return supported
}

/** Verifies an EdDSA JWT from `did` and returns its payload, or null. */
async function jwtPayload(jwt, did) {
  if (typeof jwt !== "string") return null
  const parts = jwt.split(".")
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(new TextDecoder().decode(b64url(parts[0])))
    if (header.alg !== "EdDSA") return null
    const payload = JSON.parse(new TextDecoder().decode(b64url(parts[1])))
    if (payload.iss !== did) return null
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, await importKey(did), b64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`))
    return ok ? payload : null
  } catch {
    return null
  }
}

/**
 * entries: parsed log lines in file order (null for a line that is not JSON)
 * head: the signed head { seq, hash, sig }
 * Returns { ok, problems: [{ position, seq, kind, detail }], firstBadPosition, signaturesChecked }.
 * Positions count from 0 like seq, so a clean log has position === seq.
 */
export async function verifyEntries(entries, head, guardDid) {
  const problems = []
  const sigs = await ed25519Supported()
  let prev = GENESIS_PREV
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const p = (kind, detail) => problems.push({ position: i, seq: e?.seq ?? null, kind, detail })
    if (!e || typeof e !== "object") {
      p("parse_error", "line is not a log entry")
      continue
    }
    if (e.seq !== i) p("seq_gap", `expected entry ${i}, found ${e.seq}`)
    if (e.prevHash !== prev) p("prev_mismatch", "does not link to the previous entry")
    if ((await entryHash(e)) !== e.hash) p("hash_mismatch", "entry content does not match its hash")
    if (sigs) {
      const payload = await jwtPayload(e.sig, guardDid)
      if (!payload) p("bad_signature", "signature does not verify for the guard key")
      else if (payload.hash !== e.hash || payload.seq !== e.seq) p("bad_signature", "signature covers a different entry")
    }
    prev = e.hash
  }
  const last = entries[entries.length - 1]
  const end = entries.length
  if (!head) problems.push({ position: end, seq: null, kind: "head_missing", detail: "signed head is missing" })
  else {
    if (sigs) {
      const hp = await jwtPayload(head.sig, guardDid)
      if (!hp || hp.head !== true || hp.seq !== head.seq || hp.hash !== head.hash)
        problems.push({ position: end, seq: head.seq, kind: "bad_head_signature", detail: "head signature invalid" })
    }
    if (!last || head.seq !== last.seq || head.hash !== last.hash)
      problems.push({ position: end, seq: head.seq, kind: "head_mismatch", detail: `the signed head says the log ends at entry ${head.seq}, but it ends at ${last?.seq ?? "nothing"}` })
  }
  const firstBadPosition = problems.length ? Math.min(...problems.map((x) => x.position)) : null
  return { ok: problems.length === 0, problems, firstBadPosition, signaturesChecked: sigs }
}
