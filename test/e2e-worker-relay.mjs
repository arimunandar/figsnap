// The hosted relay, exercised in the real workerd runtime.
//
// Starts `wrangler dev` itself so the Durable Object, the WebSocket upgrade and
// the token gate are the genuine implementations rather than stubs. Skipped when
// wrangler cannot start, so the rest of the suite stays runnable offline.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8791
const worker = spawn(
  'npx',
  ['wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--port', String(PORT), '--var', 'RELAY_TOKEN:devtoken'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
worker.stdout.on('data', () => {})
worker.stderr.on('data', () => {})

let up = false
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const probe = await fetch(`http://localhost:${PORT}/health`)
    if (probe.ok) { up = true; break }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500))
}
if (!up) {
  console.log('SKIP  wrangler dev did not start; hosted relay not exercised')
  worker.kill()
  process.exit(0)
}

const BASE = `http://localhost:${PORT}`
const TOKEN = 'devtoken'
const H = { 'content-type': 'application/json', 'x-relay-token': TOKEN }
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const out = []
const check = (n, ok, d='') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

// Auth gates everything but docs and health.
check('no token -> 401', (await fetch(`${BASE}/tree`)).status === 401)
check('bad token -> 401', (await fetch(`${BASE}/tree`, { headers: { 'x-relay-token': 'nope' } })).status === 401)
check('no plugin -> 503', (await fetch(`${BASE}/tree`, { headers: H })).status === 503)
check('/fs is local-only -> 501', (await fetch(`${BASE}/fs`, { headers: H })).status === 501)
check('/skill/install is local-only -> 501',
  (await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: '{}' })).status === 501)
check('docs stay public', (await fetch(`${BASE}/docs.md`)).status === 200)

// A fake plugin dials in, exactly as the real one does.
const socket = new WebSocket(`ws://localhost:${PORT}/plugin?token=${TOKEN}`)
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
const seen = []
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.kind !== 'request') return
  seen.push(msg.command)
  const reply = (data) => socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: true, data }))
  const ex = (id) => ({ id, name: 'Sheet', nodeType: 'FRAME', width: 375, height: 420, layerCount: 13,
    truncated: false, css: '.a{}', tsx: 'export function Sheet(){}', moduleCss: '.a{}', figmaCss: '/* Sheet */', png: PNG })
  if (msg.command === 'get_tree') reply({ page: 'Page 1', rows: [{ id: '21:1', name: 'Group 1', type: 'GROUP', childCount: 3 }] })
  else if (msg.command === 'get_selection') reply({ page: 'Page 1', rows: [{ id: '21:10384', name: 'Sheet', type: 'FRAME', childCount: 3 }] })
  else if (msg.command === 'extract') reply(ex(msg.params.nodeId ?? '21:10384'))
  else if (msg.command === 'extract_selection') reply({ results: [{ ref: '21:1', nodeId: '21:1', ok: true, extraction: ex('21:1') }] })
  else if (msg.command === 'export_png') reply({ png: PNG })
  else if (msg.command === 'list_saved') reply({ entries: [] })
  else socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: false, error: `Unknown command: ${msg.command}` }))
})
await new Promise(r => setTimeout(r, 400))

const health = await (await fetch(`${BASE}/health`, { headers: H })).json()
check('durable object sees the socket', health.pluginConnected === true, JSON.stringify(health))
check('reports storing no images', health.storesImages === false)
const anonymous = await (await fetch(`${BASE}/health`)).json()
check('unauthenticated health omits room state', anonymous.authenticated === false && !('pluginConnected' in anonymous))

const tree = await (await fetch(`${BASE}/tree`, { headers: H })).json()
check('GET /tree through the DO', tree.page === 'Page 1' && tree.rows[0].name === 'Group 1')

const extraction = await (await fetch(`${BASE}/extract`, { method: 'POST', headers: H, body: JSON.stringify({ nodeId: '21:10384', scale: 3 }) })).json()
check('POST /extract returns all four outputs',
  ['tsx','moduleCss','css','figmaCss'].every(k => typeof extraction[k] === 'string'))
check('image is a reference, not bytes', extraction.png.url.includes('/assets/21%3A10384@3x.png'), extraction.png.url)
check('reference declares no storage', extraction.png.note.includes('stores no image'))

const image = await fetch(extraction.png.url, { headers: H })
check('image renders on request', image.status === 200 && image.headers.get('content-type') === 'image/png')
check('image is not cacheable', image.headers.get('cache-control') === 'no-store')
check('rendered through the live socket', seen.includes('export_png'))

const batch = await (await fetch(`${BASE}/extract`, { method: 'POST', headers: H, body: JSON.stringify({ selection: true }) })).json()
check('batch routes through the DO', seen.at(-1) === 'extract_selection' && batch.results.length === 1)

const unknown = await fetch(`${BASE}/saved`, { method: 'POST', headers: H, body: JSON.stringify({ selection: true }) })
check('unknown plugin command surfaces as 400', unknown.status === 400, `status ${unknown.status}`)

// The docs half of the same Worker: public, and self-documenting once hosted.
const docsPage = await (await fetch(`${BASE}/docs`)).text()
check('serves a whole html document', docsPage.startsWith('<!DOCTYPE html>'))
check('hosted docs point at this origin', docsPage.includes(`${BASE}/extract`), BASE)
check('docs carry the no-data footer', docsPage.includes('No Figma file, and no design data, passes through it'))
const skill = await (await fetch(`${BASE}/skill`)).json()
check('skill files served publicly', skill.files?.length === 2)
check('single skill file route', (await (await fetch(`${BASE}/skill/SKILL.md`)).text()).startsWith('---'))
const missing = await (await fetch(`${BASE}/nope`)).json()
check('404 lists the real routes', missing.routes.includes('/extract') && missing.note.includes('local-only'))

socket.close()
await new Promise(r => setTimeout(r, 500))
check('503 again once the plugin leaves', (await fetch(`${BASE}/tree`, { headers: H })).status === 503)

worker.kill()
const failed = out.filter(v => !v).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
