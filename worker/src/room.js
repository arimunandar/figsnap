// One Durable Object per room, holding the plugin's WebSocket.
//
// A Worker is stateless, and the relay's whole job is keeping one socket open and
// matching replies to requests, so this has to live in a Durable Object. Nothing
// is written to storage: the plugin owns every piece of state worth keeping (the
// file, the saved set), and images are re-rendered on request rather than cached,
// so no part of anyone's design is ever at rest here.

import { DurableObject } from 'cloudflare:workers'

const REQUEST_TIMEOUT_MS = 30_000

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    /** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: number }>} */
    this.pending = new Map()
    this.counter = 0
    // See the local relay: a duplicate plugin window must not be able to start a
    // replacement loop, whatever the client build does.
    this.replacements = []
    /** @type {Set<WritableStreamDefaultWriter>} */
    this.listeners = new Set()
  }

  /** The hibernation API keeps the socket across evictions; in-memory state does not. */
  socket() {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) return ws
    }
    return null
  }

  // ------------------------------------------------------------------ rpc

  async status() {
    return {
      pluginConnected: this.socket() !== null,
      pendingRequests: this.pending.size,
      sseClients: this.listeners.size,
    }
  }

  /** Issues one command to the plugin and waits for its reply. */
  async command(name, params = {}) {
    const ws = this.socket()
    if (!ws) throw new Error('Figma plugin is not connected')

    const id = `${Date.now()}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for the plugin`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ kind: 'request', id, command: name, params }))
    })
  }

  // --------------------------------------------------------------- sockets

  async fetch(request) {
    const url = new URL(request.url)

    if (url.pathname === '/plugin') {
      if (request.headers.get('upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426 })
      }
      const existing = this.ctx.getWebSockets()
      if (existing.length > 0) {
        const now = Date.now()
        this.replacements = this.replacements.filter((at) => now - at < 10_000)
        if (this.replacements.length >= 5) {
          return new Response('Too many reconnections. Close the duplicate plugin window.', { status: 429 })
        }
        this.replacements.push(now)
      }

      const pair = new WebSocketPair()
      // A reloaded plugin opens a second socket; the newest one wins.
      for (const socket of existing) {
        socket.close(4000, 'Replaced by a newer plugin connection')
      }
      this.ctx.acceptWebSocket(pair[1])
      this.broadcast('plugin_connected', {})
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    if (url.pathname === '/events') return this.stream()

    return new Response('Not found', { status: 404 })
  }

  webSocketMessage(ws, raw) {
    let message
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return
    }

    // A silent socket can be dropped by anything between here and Figma without
    // either end noticing. The plugin pings; answering is what proves the path is
    // still whole, so it never has to guess from silence.
    if (message.kind === 'ping') {
      ws.send(JSON.stringify({ kind: 'pong', at: Date.now() }))
      return
    }

    if (message.kind === 'response') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      clearTimeout(entry.timer)
      this.pending.delete(message.id)
      if (message.ok === false) entry.reject(new Error(String(message.error)))
      else entry.resolve(message.data)
      return
    }

    if (message.kind === 'event') this.broadcast(message.event, message.data)
  }

  webSocketClose() {
    this.broadcast('plugin_disconnected', {})
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.reject(new Error('Plugin disconnected'))
    }
  }

  webSocketError() {
    this.webSocketClose()
  }

  // ------------------------------------------------------------------- sse

  stream() {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    writer.write(
      encoder.encode(`event: hello\ndata: ${JSON.stringify({ pluginConnected: this.socket() !== null })}\n\n`),
    )
    this.listeners.add(writer)

    // Dropping the writer when the reader goes away is the only way a stream
    // ends here; there is no request 'close' event to hook.
    writer.closed.then(
      () => this.listeners.delete(writer),
      () => this.listeners.delete(writer),
    )

    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    })
  }

  broadcast(event, data) {
    const encoder = new TextEncoder()
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`)
    for (const writer of this.listeners) {
      writer.write(frame).catch(() => this.listeners.delete(writer))
    }
  }
}
