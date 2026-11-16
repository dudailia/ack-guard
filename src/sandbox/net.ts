// In-process sandbox network. Hosts map to Hono apps and are called through
// the standard fetch Request/Response API, so merchants speak real HTTP
// semantics (402, headers, JSON) without opening sockets.
//
// Safety: only hosts on the reserved `.test` TLD that were registered for the
// current episode are reachable. Everything else returns an error, so an agent
// that invents a real company's URL can never reach it.

export type FetchHandler = (req: Request) => Response | Promise<Response>

export interface NetLogEntry {
  url: string
  status: number
  ts: number
}

export class SandboxNet {
  private hosts = new Map<string, FetchHandler>()
  readonly log: NetLogEntry[] = []

  register(host: string, handler: FetchHandler) {
    if (!host.endsWith(".test")) throw new Error(`sandbox hosts must use the .test TLD: ${host}`)
    this.hosts.set(host, handler)
  }

  has(host: string) {
    return this.hosts.has(host)
  }

  async fetch(rawUrl: string, init?: RequestInit): Promise<Response> {
    let url: URL
    try {
      url = new URL(rawUrl.includes("://") ? rawUrl : `http://${rawUrl}`)
    } catch {
      return new Response(JSON.stringify({ error: "invalid URL" }), { status: 400 })
    }
    const handler = this.hosts.get(url.hostname)
    if (!handler) {
      this.log.push({ url: url.toString(), status: 502, ts: Date.now() })
      return new Response(
        JSON.stringify({ error: `host ${url.hostname} is not reachable from the sandbox` }),
        { status: 502, headers: { "content-type": "application/json" } },
      )
    }
    url.protocol = "http:"
    const res = await handler(new Request(url.toString(), init))
    this.log.push({ url: url.toString(), status: res.status, ts: Date.now() })
    return res
  }
}
