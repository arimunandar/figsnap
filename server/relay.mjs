#!/usr/bin/env node
// Relay between the Figma plugin and an AI agent.
//
// The plugin cannot be reached from outside Figma, so it dials in over a
// WebSocket and this process holds that socket. Agents talk plain HTTP to the
// endpoints below; each request is forwarded over the socket and awaited.
//
//   GET  /health              relay + plugin connection state
//   GET  /docs[.md|.json]     the plugin's manual, no token required
//   GET  /skill               the Claude Code skill files, no token required
//   GET  /fs?path=            directories under a path, for choosing a project
//   POST /skill/install       { directory, force? } writes the skill into a project
//   GET  /tree                top-level layers of the current page
//   GET  /children/:id        children of one node
//   GET  /selection           what is selected on canvas right now
//   POST /extract             one node:  { nodeId } | { url } | {} (canvas selection)
//                             a batch:   { urls } | { nodeIds } | { selection: true } | { saved: true }
//   GET/POST/DELETE /saved    the set the designer curated in the panel
//   POST /resolve             { url | urls } -> what each link points at, no export
//   GET  /assets/<nodeId>@2x.png  renders that node again; nothing is cached
//   GET  /events              SSE stream of plugin events

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { readdir, stat, mkdir, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, dirname, isAbsolute } from 'node:path'
import { docsSections, renderDocsHtml, renderDocsMarkdown } from '../shared/docs.mjs'
import { skillFiles } from '../shared/skill.mjs'
import {
  shapeExtraction,
  requestedScale,
  batchCommand,
  savedAddCommand,
  savedDeleteCommand,
  folderWriteCommand,
  requestedDepth,
} from '../shared/shape.mjs'

const PORT = Number(process.env.RELAY_PORT ?? 3055)
const HOST = '127.0.0.1'
const TOKEN = process.env.RELAY_TOKEN ?? ''
const REQUEST_TIMEOUT_MS = 30_000

/** @type {import('ws').WebSocket | null} */
let plugin = null
// Two plugin windows will each replace the other forever if both keep retrying.
// The client no longer retries after being replaced, but an older build might,
// so the relay refuses to keep feeding the loop.
const REPLACE_WINDOW_MS = 10_000
const REPLACE_LIMIT = 5
let replacements = []
/** @type {Map<string, { resolve: (value: unknown) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
const pending = new Map()
/** @type {Set<import('node:http').ServerResponse>} */
const sseClients = new Set()

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args)
}

function authorized(token) {
  return TOKEN === '' || token === TOKEN
}

// ------------------------------------------------------------------ requests

function request(command, params = {}) {
  if (!plugin || plugin.readyState !== plugin.OPEN) {
    return Promise.reject(new Error('Figma plugin is not connected'))
  }
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`Timed out after ${REQUEST_TIMEOUT_MS}ms waiting for the plugin`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    plugin.send(JSON.stringify({ kind: 'request', id, command, params }))
  })
}

function settle(id, ok, payload) {
  const entry = pending.get(id)
  if (!entry) return
  clearTimeout(entry.timer)
  pending.delete(id)
  if (ok) entry.resolve(payload)
  else entry.reject(new Error(String(payload)))
}

function broadcast(event) {
  const frame = `event: ${event.event}\ndata: ${JSON.stringify(event.data ?? {})}\n\n`
  for (const client of sseClients) client.write(frame)
}

// ------------------------------------------------------------------ http

/** Best effort: a real node id makes the examples runnable, but is optional. */
async function selectedNodeId() {
  if (!plugin || plugin.readyState !== plugin.OPEN) return '21:10314'
  try {
    const data = await request('get_selection')
    return data?.rows?.[0]?.id ?? '21:10314'
  } catch {
    return '21:10314'
  }
}

/** The panel supplies its own chrome; a browser needs a whole document. */
function docsHtmlPage(context) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figsnap</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #19191a; --muted: #6e7781; --line: #e6e6e6; --code: #f6f7f9; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1e1e1e; --fg: #e6e6e6; --muted: #9a9a9f; --line: #333; --code: #262626; }
  }
  body { margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
    font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  .doc { max-width: 74ch; margin: 0 auto; }
  h1 { font-size: 28px; margin: 0 0 8px; }
  h2 { font-size: 19px; margin: 36px 0 8px; padding-top: 16px; border-top: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 22px 0 6px; }
  .doc-lead { color: var(--muted); font-size: 16px; }
  code { padding: 1px 5px; border-radius: 4px; background: var(--code);
    font: 13px/1.5 SFMono-Regular, Menlo, Consolas, monospace; }
  pre.doc-code { margin: 12px 0; padding: 12px 14px; overflow-x: auto; border: 1px solid var(--line);
    border-radius: 8px; background: var(--code);
    font: 13px/1.6 SFMono-Regular, Menlo, Consolas, monospace; }
  pre.doc-code code { padding: 0; background: none; }
  table.doc-table { width: 100%; margin: 12px 0; border-collapse: collapse; font-size: 14px; }
  .doc-table th, .doc-table td { padding: 7px 10px; border-bottom: 1px solid var(--line);
    text-align: left; vertical-align: top; }
  .doc-table th { color: var(--muted); white-space: nowrap; }
  .doc-table code { white-space: nowrap; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
</style>
</head>
<body>
${renderDocsHtml(context)}
</body>
</html>
`
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('Body is not valid JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * A plugin UI iframe is a cross-origin caller, so fetch (unlike the WebSocket)
 * needs CORS. Only Figma's own origins are allowed: a sandboxed plugin iframe
 * sends "null", the editor sends figma.com. Any other website stays blocked, so
 * a page the user happens to visit cannot drive this relay.
 */
function applyCors(req, res) {
  const requestOrigin = req.headers.origin
  if (requestOrigin === undefined) return
  const allowed =
    requestOrigin === 'null' ||
    requestOrigin === 'https://www.figma.com' ||
    requestOrigin === 'https://figma.com'
  if (!allowed) return
  res.setHeader('access-control-allow-origin', requestOrigin)
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-relay-token')
  res.setHeader('access-control-max-age', '600')
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${HOST}:${PORT}`}`)
  const origin = url.origin
  applyCors(req, res)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const token = req.headers['x-relay-token'] ?? url.searchParams.get('token') ?? ''

  // Reading docs or the skill text reveals nothing about the file; browsing the
  // filesystem and writing files stay behind the token.
  const openPath =
    url.pathname === '/health' || url.pathname.indexOf('/docs') === 0 || url.pathname === '/skill'
  if (!openPath && !authorized(String(token))) {
    sendJson(res, 401, { error: 'Bad or missing relay token' })
    return
  }

  try {
    if (url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        pluginConnected: plugin?.readyState === plugin?.OPEN && plugin !== null,
        pendingRequests: pending.size,
        sseClients: sseClients.size,
        storesImages: false,
        tokenRequired: TOKEN !== '',
      })
      return
    }

    if (url.pathname === '/docs' || url.pathname === '/docs.md' || url.pathname === '/docs.json') {
      // Docs describe the API, not the file, so they are readable without a token
      // and without the plugin being connected.
      const context = {
        httpBase: origin,
        relayState: plugin !== null ? 'open' : 'off',
        nodeId: await selectedNodeId(),
        surface: 'http',
      }
      const wantsMarkdown =
        url.pathname === '/docs.md' ||
        url.searchParams.get('format') === 'md' ||
        (url.pathname === '/docs' && (req.headers.accept ?? '').indexOf('text/markdown') !== -1)

      if (url.pathname === '/docs.json') {
        sendJson(res, 200, { sections: docsSections(context) })
        return
      }
      const body = wantsMarkdown ? renderDocsMarkdown(context) : docsHtmlPage(context)
      res.writeHead(200, {
        'content-type': `${wantsMarkdown ? 'text/markdown' : 'text/html'}; charset=utf-8`,
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
      return
    }

    if (url.pathname === '/skill' && req.method === 'GET') {
      const files = skillFiles({ httpBase: origin })
      sendJson(res, 200, {
        files: files.map((file) => ({ path: file.path, bytes: Buffer.byteLength(file.contents), contents: file.contents })),
      })
      return
    }

    // Browsing is read-only and lists directories only: enough to choose a
    // project root, and nothing more.
    if (url.pathname === '/fs' && req.method === 'GET') {
      const requested = url.searchParams.get('path')
      const target = requested && requested !== '' ? resolve(requested) : homedir()
      const info = await stat(target).catch(() => null)
      if (!info || !info.isDirectory()) {
        sendJson(res, 400, { error: `Not a directory: ${target}` })
        return
      }
      const entries = await readdir(target, { withFileTypes: true })
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((name) => name === '.claude' || !name.startsWith('.'))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, 300)
      const parent = dirname(target)
      sendJson(res, 200, {
        path: target,
        parent: parent === target ? null : parent,
        home: homedir(),
        directories,
        isProject: entries.some((entry) => ['package.json', '.git', 'CLAUDE.md'].indexOf(entry.name) !== -1),
        hasSkill: entries.some((entry) => entry.name === '.claude'),
      })
      return
    }

    if (url.pathname === '/skill/install' && req.method === 'POST') {
      const body = await readBody(req)
      const directory = typeof body.directory === 'string' ? body.directory : ''
      if (directory === '' || !isAbsolute(directory)) {
        sendJson(res, 400, { error: 'Pass an absolute directory path.' })
        return
      }
      const root = resolve(directory)
      const info = await stat(root).catch(() => null)
      if (!info || !info.isDirectory()) {
        sendJson(res, 400, { error: `Not a directory: ${root}` })
        return
      }

      const files = skillFiles({ httpBase: origin })
      const existing = []
      for (const file of files) {
        const full = join(root, file.path)
        if (await access(full).then(() => true, () => false)) existing.push(file.path)
      }
      if (existing.length > 0 && body.force !== true) {
        sendJson(res, 409, {
          error: 'Already installed. Send force: true to overwrite.',
          existing,
          directory: root,
        })
        return
      }

      const written = []
      for (const file of files) {
        const full = join(root, file.path)
        await mkdir(dirname(full), { recursive: true })
        await writeFile(full, file.contents, 'utf8')
        written.push(file.path)
      }
      log(`installed skill into ${root}`)
      sendJson(res, 200, { directory: root, written, overwritten: existing })
      return
    }

    if (url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(`event: hello\ndata: ${JSON.stringify({ pluginConnected: plugin !== null })}\n\n`)
      sseClients.add(res)
      // Comment frames keep intermediaries from closing an idle stream.
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000)
      req.on('close', () => {
        clearInterval(heartbeat)
        sseClients.delete(res)
      })
      return
    }

    const assetMatch = url.pathname.match(/^\/assets\/(.+?)(?:@([1-4])x)?\.png$/)
    if (assetMatch) {
      const nodeId = decodeURIComponent(assetMatch[1])
      const scale = assetMatch[2] ? Number(assetMatch[2]) : 2
      const data = await request('export_png', { nodeId, scale })
      if (typeof data?.png !== 'string') {
        sendJson(res, 502, { error: 'The plugin returned no image' })
        return
      }
      const buffer = Buffer.from(data.png, 'base64')
      res.writeHead(200, {
        'content-type': 'image/png',
        'content-length': buffer.length,
        // Nothing is retained here, and nothing should be retained downstream.
        'cache-control': 'no-store',
      })
      res.end(buffer)
      return
    }

    if (url.pathname === '/tree' && req.method === 'GET') {
      sendJson(res, 200, await request('get_tree', requestedDepth(url.searchParams)))
      return
    }

    const childrenMatch = url.pathname.match(/^\/children\/(.+)$/)
    if (childrenMatch && req.method === 'GET') {
      sendJson(res, 200, await request('get_children', {
        id: decodeURIComponent(childrenMatch[1]),
        ...requestedDepth(url.searchParams),
      }))
      return
    }

    if (url.pathname === '/selection' && req.method === 'GET') {
      sendJson(res, 200, await request('get_selection'))
      return
    }

    if (url.pathname === '/extract' && req.method === 'POST') {
      const body = await readBody(req)
      const batch = batchCommand(body)
      if (batch) {
        const data = await request(batch, body)
        const scale = requestedScale(body)
        const results = (data.results ?? []).map((entry) =>
          entry.ok ? { ...entry, extraction: shapeExtraction(entry.extraction, origin, scale) } : entry,
        )
        sendJson(res, 200, { results })
        return
      }
      // Single node: by url, by nodeId, or whatever is selected on canvas.
      const data = await request('extract', body)
      sendJson(res, 200, shapeExtraction(data, origin, requestedScale(body)))
      return
    }

    if (url.pathname === '/saved') {
      if (req.method === 'GET') {
        const folder = url.searchParams.get('folder')
        sendJson(res, 200, await request('list_saved', folder === null ? {} : { folder }))
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        sendJson(res, 200, await request(savedAddCommand(body), body))
        return
      }
      if (req.method === 'DELETE') {
        const body = await readBody(req)
        sendJson(res, 200, await request(savedDeleteCommand(body), body))
        return
      }
      sendJson(res, 405, { error: `Use GET, POST or DELETE on /saved, not ${req.method}` })
      return
    }

    // Moving is its own route rather than a PATCH on /saved: it is the only
    // write that changes where an entry lives without adding or removing one.
    if (url.pathname === '/saved/move' && req.method === 'POST') {
      sendJson(res, 200, await request('move_saved', await readBody(req)))
      return
    }

    // Syncing belongs to an account, and a local relay has none: it binds to
    // 127.0.0.1, where the set already lives in this machine's Figma.
    if (url.pathname === '/library' || url.pathname.startsWith('/library/')) {
      sendJson(res, 501, {
        error: 'Syncing the saved set needs an account. Sign in to a hosted relay for that.',
      })
      return
    }

    if (url.pathname === '/folders') {
      if (req.method === 'GET') {
        sendJson(res, 200, await request('list_folders'))
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        sendJson(res, 200, await request(folderWriteCommand(body), body))
        return
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, await request('delete_folder', await readBody(req)))
        return
      }
      sendJson(res, 405, { error: `Use GET, POST or DELETE on /folders, not ${req.method}` })
      return
    }

    if (url.pathname === '/resolve' && req.method === 'POST') {
      sendJson(res, 200, await request('resolve_urls', await readBody(req)))
      return
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes('not connected') ? 503 : message.includes('Timed out') ? 504 : 400
    sendJson(res, status, { error: message })
  }
})

// ------------------------------------------------------------------ websocket

const wss = new WebSocketServer({ server, path: '/plugin', maxPayload: 64 * 1024 * 1024 })

wss.on('connection', (socket, req) => {
  const token = new URL(req.url ?? '/', `http://${HOST}`).searchParams.get('token') ?? ''
  if (!authorized(token)) {
    socket.close(4001, 'Bad relay token')
    return
  }

  if (plugin && plugin.readyState === plugin.OPEN) {
    const now = Date.now()
    replacements = replacements.filter((at) => now - at < REPLACE_WINDOW_MS)
    if (replacements.length >= REPLACE_LIMIT) {
      socket.close(4002, 'Too many reconnections. Close the duplicate plugin window.')
      log('refused a replacement storm')
      return
    }
    replacements.push(now)
    // A reloaded plugin opens a second socket; the newest one wins.
    plugin.close(4000, 'Replaced by a newer plugin connection')
  }
  plugin = socket
  log('plugin connected')
  broadcast({ event: 'plugin_connected', data: {} })

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      log('dropped malformed frame')
      return
    }
    // Answering a ping is what tells the plugin the socket is still whole; see
    // the same handler in the Worker's Room.
    if (message.kind === 'ping') {
      socket.send(JSON.stringify({ kind: 'pong', at: Date.now() }))
      return
    }
    if (message.kind === 'response') {
      settle(message.id, message.ok !== false, message.ok === false ? message.error : message.data)
      return
    }
    if (message.kind === 'event') {
      broadcast({ event: message.event, data: message.data })
    }
  })

  socket.on('close', () => {
    if (plugin === socket) plugin = null
    log('plugin disconnected')
    broadcast({ event: 'plugin_disconnected', data: {} })
    for (const id of Array.from(pending.keys())) settle(id, false, 'Plugin disconnected')
  })

  socket.on('error', (error) => log('socket error:', error.message))
})

server.listen(PORT, HOST, () => {
  log(`relay on http://${HOST}:${PORT}`)
  log(`plugin websocket: ws://${HOST}:${PORT}/plugin`)
  if (TOKEN === '') log('no RELAY_TOKEN set: any local process can drive the plugin')
})
