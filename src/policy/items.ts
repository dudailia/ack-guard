// Item binding: does the resource being paid for carry exactly the parameters
// the task asked for? Pure, no I/O, no LLM.
//
// The paid resource is the URL that answered with the 402 (REQ_PROVENANCE),
// already in canonical form (world.ts normalizeUrl): parameter names lower-
// cased, sorted, percent-encoding decoded by URLSearchParams, tracking
// parameters dropped. That URL is also exactly what the merchant serves, since
// the receipt only unlocks the URL it was quoted for.
//
// A URL matches an item when:
//   - every parameter the item names appears exactly once (a repeat is refused,
//     because two services can read different copies),
//   - no other parameter appears (an extra one can change what is served),
//   - each value equals the item's value, ignoring letter case only. No
//     trimming and no Unicode folding: "Boston " and "Bostоn" (Cyrillic o) are
//     different items.

import type { ItemSpec } from "./types.js"

export interface ItemMatch {
  ok: boolean
  detail: string
}

export function describeItem(item: ItemSpec): string {
  const ps = Object.entries(item.params)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
  return `${item.capability}${ps.length ? ` (${ps.join(", ")})` : " (no parameters)"}`
}

/** Does the URL (query string) carry exactly this item's parameters? */
export function matchItem(item: ItemSpec, url: string): ItemMatch {
  let params: URLSearchParams
  try {
    params = new URL(url).searchParams
  } catch {
    return { ok: false, detail: `cannot parse ${url}` }
  }
  const want = new Map(Object.entries(item.params).map(([k, v]) => [k.toLowerCase(), v]))
  const counts = new Map<string, number>()
  for (const [k] of params) counts.set(k.toLowerCase(), (counts.get(k.toLowerCase()) ?? 0) + 1)
  for (const [k, n] of counts) {
    if (n > 1) return { ok: false, detail: `parameter ${k} appears ${n} times` }
    if (!want.has(k)) return { ok: false, detail: `parameter ${k} is not part of the item` }
  }
  for (const [k, v] of want) {
    if (!counts.has(k)) return { ok: false, detail: `parameter ${k} is missing (the item needs ${k}=${v})` }
    let got: string | null = null
    for (const [pk, pv] of params) if (pk.toLowerCase() === k) got = pv
    if (got!.toLowerCase() !== v.toLowerCase()) return { ok: false, detail: `${k}=${got} but the item needs ${k}=${v}` }
  }
  return { ok: true, detail: "parameters match" }
}

/**
 * The item a URL may be bought as, given the items the task lists and what it
 * already bought. Each listed item can be bought once; a task that needs the
 * same item twice lists it twice.
 */
export function bindItem(
  items: ItemSpec[] | undefined,
  capability: string,
  url: string | undefined,
  boughtUrls: string[],
): { ok: boolean | null; detail: string; specified: boolean } {
  const mine = (items ?? []).filter((i) => i.capability === capability)
  if (!mine.length) return { ok: true, specified: false, detail: `the task does not say which ${capability} item it needs, so its parameters are not checked` }
  if (!url) return { ok: null, specified: true, detail: "requires the URL that returned the payment request" }
  // Items still open: remove one listed item for each earlier purchase that matched it.
  const open = [...mine]
  for (const b of boughtUrls) {
    const i = open.findIndex((it) => matchItem(it, b).ok)
    if (i >= 0) open.splice(i, 1)
  }
  const hit = open.find((it) => matchItem(it, url).ok)
  if (hit) return { ok: true, specified: true, detail: `${url} is the item the task asked for: ${describeItem(hit)}` }
  const already = mine.find((it) => matchItem(it, url).ok)
  if (already) return { ok: false, specified: true, detail: `${describeItem(already)} was already bought in this task` }
  const why = mine.map((it) => `${describeItem(it)}: ${matchItem(it, url).detail}`).join("; ")
  return { ok: false, specified: true, detail: `${url} is not an item the task asked for. ${why}` }
}
