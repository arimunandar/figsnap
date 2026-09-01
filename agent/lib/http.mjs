// The daemon's HTTP face.
//
// Two callers, both on loopback. The MCP server this daemon spawns posts every
// tool call to `/tool`, and the panel reads `/health`, `/harnesses` and `/fs`
// to fill in its own chrome — the last of those being the working-directory
// picker, which is a filesystem question a plugin iframe cannot answer itself.
//
// CORS is here for the panel only, and only for Figma's origins: a plugin
// iframe is a sandboxed document that sends `null`, the editor sends figma.com,
// and any other page stays blocked, so a site the designer happens to have open
// cannot drive this. The WebSocket does the same check by hand, because CORS
// does not apply to an upgrade.

import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { base64Bytes } from '../../shared/shape.mjs'
import { TOOLS_BY_NAME, toolManifest } from './tools.mjs'
import { surveyHarnesses } from './harnesses.mjs'

const BODY_LIMIT = 1_000_000

export function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin === undefined) return
  const allowed = origin === 'null' || origin === 'https://www.figma.com' || origin === 'https://figma.com'
  if (!allowed) return
  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type, x-figsnap-token')
  res.setHeader('access-control-max-age', '600')
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
  return new Promise((settle, fail) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        fail(new Error('Request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') {
        settle({})
        return
      }
      try {
        settle(JSON.parse(raw))
      } catch {
        fail(new Error('Body is not valid JSON'))
      }
    })
    req.on('error', fail)
  })
}

/**
 * One tool call, from the MCP server through the panel and into `figma.*`.
 *
 * The mutating half is gated here rather than at the plugin, because this is
 * the one place that knows both which tools write and whether the designer has
 * turned writing on. A harness running without permission prompts still cannot
 * get past it.
 */
export async function runTool({ plugin, runner, name, args }) {
  const tool = TOOLS_BY_NAME.get(name)
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`)
  if (tool.mutates && !runner.writesAllowed()) {
    throw new Error(
      'Editing the file is switched off. The designer turns it on with "Allow edits" in the plugin\'s Agent tab.',
    )
  }

  const data = await plugin.request(tool.command, tool.params(args ?? {}))

  if (tool.image === true) {
    if (typeof data?.png !== 'string') throw new Error('The plugin returned no image')
    return [{ type: 'image', data: data.png, mimeType: 'image/png' }]
  }

  // One export serves both image outputs, so which was asked for is read off
  // `outputs` rather than off the payload. `png` becomes a real image block —
  // a model that can see should be looking at the design, not at base64 in the
  // middle of a JSON blob. `pngData` stays inline, because asking for it means
  // wanting the bytes in the answer.
  if (data !== null && typeof data === 'object' && typeof data.png === 'string') {
    const { png, ...rest } = data
    const outputs = Array.isArray(rest.outputs) ? rest.outputs : ['png']
    if (outputs.includes('pngData')) {
      rest.pngData = { dataUri: `data:image/png;base64,${png}`, bytes: base64Bytes(png) }
    }
    const text = { type: 'text', text: JSON.stringify(rest, null, 2) }
    return outputs.includes('png') ? [text, { type: 'image', data: png, mimeType: 'image/png' }] : [text]
  }

  return [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

export function createHttpHandler({ plugin, runner, token, version }) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', `http://127.0.0.1`)
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const supplied = req.headers['x-figsnap-token'] ?? url.searchParams.get('token') ?? ''
    // /health is the one route a panel can reach before it has been paired, so
    // it alone is open. What it answers depends on the token; see below.
    const open = url.pathname === '/health'
    if (!open && !plugin.authorized(String(supplied))) {
      sendJson(res, 401, { error: 'Bad or missing agent token' })
      return
    }

    try {
      if (url.pathname === '/health') {
        // Open so the panel can probe before it has been paired. That is also
        // why it says nothing about the session: `cwd` is a path on this
        // machine, and an unauthenticated route is the wrong place for it.
        sendJson(res, 200, {
          ok: true,
          version,
          panelConnected: plugin.connected(),
          pendingRequests: plugin.pendingCount(),
          tokenRequired: token !== '',
          ...(plugin.authorized(String(supplied)) ? { session: runner.state() } : {}),
        })
        return
      }

      if (url.pathname === '/harnesses' && req.method === 'GET') {
        sendJson(res, 200, { harnesses: await surveyHarnesses() })
        return
      }

      if (url.pathname === '/tools' && req.method === 'GET') {
        sendJson(res, 200, { tools: toolManifest() })
        return
      }

      // Read-only and directories only: enough to choose a working directory
      // for a session, and nothing more.
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
        })
        return
      }

      if (url.pathname === '/tool' && req.method === 'POST') {
        const body = await readBody(req)
        try {
          const content = await runTool({ plugin, runner, name: body.name, args: body.arguments })
          sendJson(res, 200, { content })
        } catch (error) {
          // A tool that failed is news for the agent, not a broken transport:
          // 200 with an error field, which mcp-stdio turns into isError.
          sendJson(res, 200, { error: error instanceof Error ? error.message : String(error) })
        }
        return
      }

      sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, message.includes('not connected') ? 503 : 400, { error: message })
    }
  }
}
