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
 * How much base64 may ride inline in a tool result at all.
 *
 * `pngData` is off the tool schema — see TOOL_FORMATS in lib/tools.mjs — but the
 * /tool route takes a body, not a validated argument list, so this is the floor
 * under it. A screen at scale 3 is ~141 kB of base64, which exceeds what a tool
 * result may carry: the call is then wasted, and the caller is handed a file to
 * slice rather than an answer. Below the cap an icon still inlines fine.
 */
const MAX_INLINE_BASE64 = 32_000

/** `pngData` as it goes out: the bytes if they are small, a signpost if not. */
function inlineImage(png) {
  const bytes = base64Bytes(png)
  return png.length > MAX_INLINE_BASE64
    ? {
        bytes,
        note:
          `Too large to inline (${Math.round(bytes / 1024)} kB). Ask for "png" instead — it comes back as a ` +
          'real image block rather than base64 text — or use figma_export_png, and lower the scale.',
      }
    : { dataUri: `data:image/png;base64,${png}`, bytes }
}

/** The wording for the one thing no amount of plumbing can fix. */
export const PANEL_CLOSED =
  'The Figsnap plugin is not open in Figma. The daemon is running, but the Figma Plugin API only exists while ' +
  'the plugin does — so there is nothing to read until it is open. Ask the designer to open the file and run ' +
  'Plugins > Development > Figsnap.'

/**
 * One entry of a batch extraction, with the image handled as it is for a single
 * node: `png` dropped, `pngData` inlined while it is small enough to read, and
 * `outputs` left alone as the record of what was asked for.
 */
function shapeBatchEntry(entry) {
  const extraction = entry?.extraction
  if (extraction === null || typeof extraction !== 'object' || typeof extraction.png !== 'string') return entry
  const { png, ...rest } = extraction
  const outputs = Array.isArray(rest.outputs) ? rest.outputs : ['png']
  if (outputs.includes('pngData')) rest.pngData = inlineImage(png)
  return { ...entry, extraction: rest }
}

/**
 * One tool call, from the MCP server through the panel and into `figma.*`.
 *
 * The mutating half is gated here rather than at the plugin, because this is
 * the one place that knows both which tools write and whether the designer has
 * turned writing on. A harness running without permission prompts still cannot
 * get past it.
 */
export async function runTool({ plugin, runner, account, name, args }) {
  const tool = TOOLS_BY_NAME.get(name)
  if (tool === undefined) throw new Error(`Unknown tool: ${name}`)

  // Who, before what. Re-read on every call rather than on a timer: it costs one
  // small file read, it means `figsnap-agent login` in another terminal takes
  // effect in a running daemon, and it means revoking a token on the relay stops
  // the tools rather than stopping them at the next restart. The network is only
  // touched when the last answer has gone stale.
  if (account !== undefined) {
    await account.refresh()
    const refused = account.refuse()
    if (refused !== null) throw new Error(refused)
  }

  if (tool.mutates && !runner.writesAllowed()) {
    throw new Error(
      'Editing the file is switched off. The designer turns it on with "Allow edits" in the plugin\'s Agent tab, ' +
        'or by starting the daemon with `figsnap-agent --allow-edits`.',
    )
  }
  // The one limit that cannot be engineered around: `figma.*` exists only while
  // the plugin is running, so a daemon with no panel attached has nothing to
  // forward to. Saying that costs nothing; the alternative is a 30-second
  // timeout the caller has to interpret.
  if (!plugin.connected()) throw new Error(PANEL_CLOSED)

  // A tool that answers several commands names which from its arguments; most
  // name one and are a plain string.
  const command = typeof tool.command === 'function' ? tool.command(args ?? {}) : tool.command
  const data = await plugin.request(command, tool.params(args ?? {}))

  if (tool.image === true) {
    if (typeof data?.png !== 'string') throw new Error('The plugin returned no image')
    return [{ type: 'image', data: data.png, mimeType: 'image/png' }]
  }

  // One export serves both image outputs, so which was asked for is read off
  // `outputs` rather than off the payload. `png` becomes a real image block —
  // a model that can see should be looking at the design, not at base64 in the
  // middle of a JSON blob. `pngData` stays inline only while it is small enough
  // to be worth reading; see inlineImage.
  if (data !== null && typeof data === 'object' && typeof data.png === 'string') {
    const { png, ...rest } = data
    const outputs = Array.isArray(rest.outputs) ? rest.outputs : ['png']
    if (outputs.includes('pngData')) rest.pngData = inlineImage(png)
    const text = { type: 'text', text: JSON.stringify(rest, null, 2) }
    return outputs.includes('png') ? [text, { type: 'image', data: png, mimeType: 'image/png' }] : [text]
  }

  // A batch answers one entry per input, each with an extraction of its own, so
  // the same rule has to hold per entry: twenty base64 images stringified into
  // one tool result is not an answer anybody can read. Twenty image blocks are
  // not much better, which is why a batch never returns one — figma_export_png
  // is the tool for a picture, and it takes a node at a time.
  if (Array.isArray(data?.results)) {
    const results = data.results.map(shapeBatchEntry)
    return [{ type: 'text', text: JSON.stringify({ ...data, results }, null, 2) }]
  }

  return [{ type: 'text', text: JSON.stringify(data, null, 2) }]
}

export function createHttpHandler({ plugin, runner, account, token, version }) {
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
          // Whether an account is needed is not a secret — it is the thing a
          // caller has to know before it can do anything — so it is on the open
          // half. Who is signed in is not, and rides with the session.
          loginRequired: account?.state().required === true,
          ...(plugin.authorized(String(supplied))
            ? { session: runner.state(), ...(account === undefined ? {} : { account: account.state() }) }
            : {}),
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
          const content = await runTool({ plugin, runner, account, name: body.name, args: body.arguments })
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
