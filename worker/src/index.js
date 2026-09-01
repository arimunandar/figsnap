// The Figsnap relay, hosted.
//
// Two halves. The docs and the Claude Code skill files are public and pure
// functions of this repository. The relay API is gated behind RELAY_TOKEN and
// forwards to a Durable Object holding the plugin's WebSocket, because a Worker
// cannot hold a socket between requests.
//
// Nothing about a design is stored: images are re-rendered through the live
// socket instead of cached, and the plugin owns the saved set. Two local-only
// routes are refused outright — a Worker has no filesystem, so it can neither
// browse directories nor install the skill into a project.

import { docsSections, renderDocsHtml, renderDocsMarkdown } from '../../shared/docs.mjs'
import { skillFiles } from '../../shared/skill.mjs'
import {
  shapeExtraction,
  requestedScale,
  batchCommand,
  savedAddCommand,
  savedDeleteCommand,
  folderWriteCommand,
  requestedDepth,
} from '../../shared/shape.mjs'

import { authPage } from './auth-page.js'

export { Room } from './room.js'
export { Accounts } from './accounts.js'
export { Library } from './library.js'

const LOCAL_ONLY = {
  '/fs': 'Browsing directories needs a filesystem. Run the relay locally for that.',
  '/skill/install':
    'Writing files needs a filesystem. Run the relay locally, or fetch /skill and write the files yourself.',
}

// The plugin panel is a sandboxed iframe, so every call it makes is
// cross-origin with the literal origin "null" and needs CORS. Credentials are
// never cached, so the two headers always travel together.
const PRIVATE = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' }

function accounts(env) {
  return env.ACCOUNTS.getByName('accounts')
}

function presentedToken(request, url) {
  return request.headers.get('x-relay-token') ?? url.searchParams.get('token') ?? ''
}

/**
 * Works out which room a caller may use. A per-account token gets that account's
 * own room and nothing else, so one person's token cannot read another's designs.
 * The shared RELAY_TOKEN, when set, keeps working and maps to a single room.
 */
/** An account's own saved-set store, reachable only with that account's token. */
function libraryFor(env, room) {
  return env.LIBRARY.getByName(room)
}

async function authorise(request, env) {
  const url = new URL(request.url)
  const token = presentedToken(request, url)
  const shared = env.RELAY_TOKEN

  if (shared && token === shared) return { room: 'default' }

  if (token !== '') {
    const account = await accounts(env).resolve(token)
    if (account) return { room: account.room, email: account.email }
  }

  if (!shared) {
    return {
      denied: Response.json(
        {
          error:
            'Sign in to get a token: use Sign in inside the plugin, or open /login on this relay. An operator can also set a shared token with: wrangler secret put RELAY_TOKEN',
        },
        { status: 401, headers: PRIVATE },
      ),
    }
  }
  return { denied: Response.json({ error: 'Bad or missing relay token' }, { status: 401, headers: PRIVATE }) }
}

function roomFor(env, name) {
  return env.ROOM.getByName(name)
}

async function readBody(request) {
  const raw = await request.text()
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('Body is not valid JSON')
  }
}

function failed(error) {
  const message = error instanceof Error ? error.message : String(error)
  const status = message.includes('not connected') ? 503 : message.includes('Timed out') ? 504 : 400
  return Response.json({ error: message }, { status })
}

const CACHE = 'public, max-age=300'

function origin(url) {
  return `${url.protocol}//${url.host}`
}

function context(env, url) {
  return {
    // A deployed relay is always the relay: it documents its own address.
    httpBase: origin(url),
    relayState: 'off',
    nodeId: '21:10314',
    surface: 'public',
  }
}

/** The API routes, each returning a Response from the room. */
function matchApi(path, method) {
  const json = (data) => Response.json(data, { headers: { 'access-control-allow-origin': '*' } })

  if (path === '/tree' && method === 'GET') {
    return async (stub, request, url) => json(await stub.command('get_tree', requestedDepth(url.searchParams)))
  }
  if (path === '/selection' && method === 'GET') return async (stub) => json(await stub.command('get_selection'))

  if (path === '/saved' && method === 'GET') {
    return async (stub, request, url) => {
      const folder = url.searchParams.get('folder')
      return json(await stub.command('list_saved', folder === null ? {} : { folder }))
    }
  }

  if (path === '/folders' && method === 'GET') return async (stub) => json(await stub.command('list_folders'))

  // The library is the account's, not the room's: it answers whether or not a
  // plugin is connected, which is the point of it following you between devices.
  const library = path.match(/^\/library(?:\/(.+))?$/)
  if (library) {
    const fileId = library[1] ? decodeURIComponent(library[1]) : null
    if (method === 'GET' && fileId === null) {
      return async (_stub, _request, _url, _base, shelf) => json({ files: await shelf.files() })
    }
    if (method === 'GET') {
      return async (_stub, _request, _url, _base, shelf) => json(await shelf.read(fileId))
    }
    if (method === 'PUT' && fileId !== null) {
      return async (_stub, request, _url, _base, shelf) => {
        const body = await readBody(request)
        return json(await shelf.write(fileId, body.folders, body.entries, body.updatedAt))
      }
    }
    if (method === 'DELETE' && fileId !== null) {
      return async (_stub, _request, _url, _base, shelf) => json(await shelf.forget(fileId))
    }
  }

  if (path === '/folders' && method === 'POST') {
    return async (stub, request) => {
      const body = await readBody(request)
      return json(await stub.command(folderWriteCommand(body), body))
    }
  }

  if (path === '/folders' && method === 'DELETE') {
    return async (stub, request) => json(await stub.command('delete_folder', await readBody(request)))
  }

  // Its own route rather than a PATCH on /saved: it is the only write that
  // changes where an entry lives without adding or removing one.
  if (path === '/saved/move' && method === 'POST') {
    return async (stub, request) => json(await stub.command('move_saved', await readBody(request)))
  }

  const children = path.match(/^\/children\/(.+)$/)
  if (children && method === 'GET') {
    return async (stub, request, url) =>
      json(await stub.command('get_children', {
        id: decodeURIComponent(children[1]),
        ...requestedDepth(url.searchParams),
      }))
  }

  // Images are a reference, not a stored object: fetching one renders it again.
  const asset = path.match(/^\/assets\/(.+?)(?:@([1-4])x)?\.png$/)
  if (asset && method === 'GET') {
    return async (stub) => {
      const data = await stub.command('export_png', {
        nodeId: decodeURIComponent(asset[1]),
        scale: asset[2] ? Number(asset[2]) : 2,
      })
      if (typeof data?.png !== 'string') return Response.json({ error: 'The plugin returned no image' }, { status: 502 })
      const bytes = Uint8Array.from(atob(data.png), (char) => char.charCodeAt(0))
      return new Response(bytes, {
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
      })
    }
  }

  if (path === '/extract' && method === 'POST') {
    return async (stub, request, url, base) => {
      const body = await readBody(request)
      const scale = requestedScale(body)
      const batch = batchCommand(body)
      if (batch) {
        const data = await stub.command(batch, body)
        return json({
          results: (data?.results ?? []).map((entry) =>
            entry.ok ? { ...entry, extraction: shapeExtraction(entry.extraction, base, scale) } : entry,
          ),
        })
      }
      return json(shapeExtraction(await stub.command('extract', body), base, scale))
    }
  }

  if (path === '/resolve' && method === 'POST') {
    return async (stub, request) => json(await stub.command('resolve_urls', await readBody(request)))
  }

  if (path === '/saved' && method === 'POST') {
    return async (stub, request) => {
      const body = await readBody(request)
      return json(await stub.command(savedAddCommand(body), body))
    }
  }

  if (path === '/saved' && method === 'DELETE') {
    return async (stub, request) => {
      const body = await readBody(request)
      return json(await stub.command(savedDeleteCommand(body), body))
    }
  }

  return null
}

function headers(type, extra = {}) {
  return {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': CACHE,
    // Documentation is meant to be read from anywhere; there is nothing to guard.
    'access-control-allow-origin': '*',
    ...extra,
  }
}

function page(context) {
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
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre.doc-code { margin: 12px 0; padding: 12px 14px; overflow-x: auto; border: 1px solid var(--line);
    border-radius: 8px; background: var(--code);
    font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  table.doc-table { width: 100%; margin: 12px 0; border-collapse: collapse; font-size: 14px; }
  .doc-table th, .doc-table td { padding: 7px 10px; border-bottom: 1px solid var(--line);
    text-align: left; vertical-align: top; }
  .doc-table th { color: var(--muted); white-space: nowrap; }
  .doc-table code { white-space: nowrap; }
  ul { padding-left: 22px; }
  li { margin: 4px 0; }
  footer { max-width: 74ch; margin: 48px auto 0; padding-top: 16px;
    border-top: 1px solid var(--line); color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
${renderDocsHtml(context)}
<footer>
  This page is documentation only. No Figma file, and no design data, passes through it.
</footer>
</body>
</html>
`
}

export default {
  /**
   * @param {Request} request
   * @param {{ RELAY_TOKEN?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
          'access-control-allow-headers': 'content-type, x-relay-token',
        },
      })
    }
    const docs = context(env, url)

    // ---------------------------------------------------------------- relay

    // ----------------------------------------------------------------- auth

    if (path === '/auth/pair/start' && request.method === 'POST') {
      const pairing = await accounts(env).startPairing()
      return Response.json(
        { ...pairing, url: `${origin(url)}/login?pair=${encodeURIComponent(pairing.code)}` },
        { headers: PRIVATE },
      )
    }

    if (path === '/auth/pair/claim' && request.method === 'POST') {
      try {
        const body = await readBody(request)
        const claimed = await accounts(env).claimPairing(body.code, presentedToken(request, url))
        return Response.json(claimed, { headers: PRIVATE })
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400, headers: PRIVATE },
        )
      }
    }

    if (path === '/auth/pair/status' && request.method === 'GET') {
      const result = await accounts(env).takePairing(url.searchParams.get('id'))
      return Response.json(result, { headers: PRIVATE })
    }

    if (path === '/login' || path === '/register') {
      return new Response(authPage(), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (path === '/auth/register' || path === '/auth/login') {
      if (request.method !== 'POST') {
        return Response.json({ error: 'Use POST' }, { status: 405, headers: { allow: 'POST', ...PRIVATE } })
      }
      try {
        const body = await readBody(request)
        const stub = accounts(env)
        const result =
          path === '/auth/register'
            ? await stub.register(body.email, body.password)
            : await stub.login(body.email, body.password)
        // A token is a credential: never cached, never in a URL.
        return Response.json(result, { headers: PRIVATE })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message.includes('Too many') ? 429 : 400
        return Response.json({ error: message }, { status, headers: PRIVATE })
      }
    }

    if (path === '/auth/me' && request.method === 'GET') {
      const account = await accounts(env).resolve(presentedToken(request, url))
      if (!account) return Response.json({ error: 'Session expired' }, { status: 401, headers: PRIVATE })
      return Response.json(account, { headers: PRIVATE })
    }

    if (path === '/auth/revoke' && request.method === 'POST') {
      const token = presentedToken(request, url)
      const account = await accounts(env).resolve(token)
      if (!account) return Response.json({ error: 'Session expired' }, { status: 401, headers: PRIVATE })
      return Response.json(await accounts(env).revoke(token), { headers: PRIVATE })
    }

    // ---------------------------------------------------------------- relay

    if (path === '/plugin' || path === '/events') {
      const auth = await authorise(request, env)
      if (auth.denied) return auth.denied
      return roomFor(env, auth.room).fetch(request)
    }

    if (path === '/health') {
      // Reachability is public; the state of a room is not. An unauthenticated
      // caller gets no pluginConnected field rather than a misleading false.
      const auth = await authorise(request, env)
      const registry = await accounts(env).stats()
      const relay = {
        ok: true,
        hosted: true,
        storesImages: false,
        accounts: registry.users,
        hashing: await accounts(env).hashingParameters(),
        sharedToken: Boolean(env.RELAY_TOKEN),
        authenticated: !auth.denied,
      }
      const body = auth.denied
        ? relay
        : { ...relay, ...(await roomFor(env, auth.room).status()), signedIn: auth.email ?? null }
      return Response.json(body, { headers: { 'access-control-allow-origin': '*' } })
    }

    if (LOCAL_ONLY[path]) {
      return Response.json({ error: LOCAL_ONLY[path] }, { status: 501 })
    }

    const api = matchApi(path, request.method)
    if (api) {
      const auth = await authorise(request, env)
      if (auth.denied) return auth.denied
      try {
        return await api(roomFor(env, auth.room), request, url, origin(url), libraryFor(env, auth.room))
      } catch (error) {
        return failed(error)
      }
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return Response.json(
        { error: `No route for ${request.method} ${path}` },
        { status: 405, headers: { allow: 'GET, HEAD, OPTIONS' } },
      )
    }

    if (path === '/' || path === '/docs') {
      const wantsMarkdown =
        url.searchParams.get('format') === 'md' ||
        (request.headers.get('accept') ?? '').includes('text/markdown')
      return wantsMarkdown
        ? new Response(renderDocsMarkdown(docs), { headers: headers('text/markdown') })
        : new Response(page(docs), { headers: headers('text/html') })
    }

    if (path === '/docs.md') {
      return new Response(renderDocsMarkdown(docs), { headers: headers('text/markdown') })
    }

    if (path === '/docs.json') {
      return Response.json({ sections: docsSections(docs) }, { headers: headers('application/json') })
    }

    if (path === '/skill') {
      const files = skillFiles({ httpBase: docs.httpBase })
      return Response.json(
        {
          note: 'Install these into a project as-is. The relay address they contain is your local one.',
          files: files.map((file) => ({ path: file.path, bytes: file.contents.length, contents: file.contents })),
        },
        { headers: headers('application/json') },
      )
    }

    // A single file, so it can be piped straight into place.
    const single = path.match(/^\/skill\/(SKILL\.md|figsnap-extractor\.md)$/)
    if (single) {
      const files = skillFiles({ httpBase: docs.httpBase })
      const file = files.find((entry) => entry.path.endsWith(single[1]))
      if (file) return new Response(file.contents, { headers: headers('text/markdown') })
    }

    return Response.json(
      {
        error: `No route for ${path}`,
        routes: [
          '/login', '/auth/login', '/auth/register', '/auth/me', '/auth/revoke',
          '/auth/pair/start', '/auth/pair/claim', '/auth/pair/status',
          '/docs', '/docs.md', '/docs.json', '/skill',
          '/health', '/tree', '/children/:id', '/selection', '/extract', '/resolve',
          '/saved', '/saved/move', '/folders', '/library', '/library/:fileId',
          '/assets/:nodeId@2x.png', '/events',
        ],
        note: '/fs and /skill/install need a filesystem and are local-only.',
      },
      { status: 404, headers: headers('application/json') },
    )
  },
}
