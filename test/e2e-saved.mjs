import { spawn } from 'node:child_process'

const PORT = 3096
const BASE = `http://127.0.0.1:${PORT}`
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

const relay = spawn('node', [new URL('../server/relay.mjs', import.meta.url).pathname], { env: { ...process.env, RELAY_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] })
relay.stderr.on('data', (d) => console.error('[relay]', d.toString().trim()))
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break } catch { await new Promise((r) => setTimeout(r, 100)) } }

// Fake plugin with a real in-memory saved set, so ordering and dedupe are exercised.
let store = []
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/plugin`)
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
const seen = []
const ex = (name, id) => ({ id, name, nodeType: 'FRAME', width: 375, height: 812, layerCount: 9, truncated: false, css: '.a{}', tsx: `export function ${name}(){}`, moduleCss: '.a{}', png: PNG })
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.kind !== 'request') return
  seen.push(msg.command)
  const reply = (data) => socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: true, data }))
  const add = (ids) => { for (const id of ids) if (!store.some((e) => e.id === id)) store.push({ id, name: `Node ${id}`, type: 'FRAME', addedAt: Date.now() }) }
  switch (msg.command) {
    case 'export_png': return reply({ png: PNG })
    case 'save_selection': add(['1:1', '1:2']); return reply({ added: store.length, entries: store })
    case 'save_nodes': add(msg.params.nodeIds.map(String)); return reply({ added: msg.params.nodeIds.length, entries: store })
    case 'list_saved': return reply({ entries: store })
    case 'unsave': store = store.filter((e) => !msg.params.nodeIds.includes(e.id)); return reply({ entries: store })
    case 'clear_saved': store = []; return reply({ entries: store })
    case 'extract_saved': return reply({ results: store.map((e) => ({ ref: e.id, nodeId: e.id, ok: true, extraction: ex(e.name, e.id) })) })
    default: socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: false, error: 'unknown' }))
  }
})
await new Promise((r) => setTimeout(r, 200))

const call = (path, method, body) => fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json())

let r = await call('/saved', 'POST', { selection: true })
check('POST /saved -> save_selection', seen.at(-1) === 'save_selection' && r.entries.length === 2, seen.at(-1))

r = await call('/saved', 'POST', { nodeIds: ['21:10314', '1:1'] })
check('POST /saved with ids -> save_nodes', seen.at(-1) === 'save_nodes')
check('dedupes an already-saved id', r.entries.length === 3, `${r.entries.length} entries`)

r = await call('/saved', 'GET')
check('GET /saved lists the set', r.entries.map((e) => e.id).join(',') === '1:1,1:2,21:10314', r.entries.map((e) => e.id).join(','))

const batch = await call('/extract', 'POST', { saved: true })
check('extract saved:true -> extract_saved', seen.at(-1) === 'extract_saved', seen.at(-1))
check('one result per saved node', batch.results?.length === 3)
check('png urls issued for saved batch', batch.results.every((x) => x.extraction.png.url.startsWith('http')))
const png = await fetch(batch.results[0].extraction.png.url)
check('saved asset downloadable', png.status === 200 && png.headers.get('content-type') === 'image/png')

r = await call('/saved', 'DELETE', { nodeIds: ['1:2'] })
check('DELETE one id', seen.at(-1) === 'unsave' && r.entries.length === 2 && !r.entries.some((e) => e.id === '1:2'))

r = await call('/saved', 'DELETE', { all: true })
check('DELETE all', seen.at(-1) === 'clear_saved' && r.entries.length === 0)

const bad = await fetch(`${BASE}/saved`, { method: 'PUT' })
check('405 on unsupported method', bad.status === 405, `status ${bad.status}`)

relay.kill()
const failed = out.filter((v) => !v).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
