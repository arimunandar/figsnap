#!/usr/bin/env node
// Smoke test against a deployed relay.
//
// Kept out of `npm test` on purpose: it talks to a real Worker over the internet
// and needs a token. A WebSocket client stands in for the Figma plugin, so the
// whole hosted path — upgrade, Durable Object, token gate, on-demand rendering —
// is exercised without Figma being open.
//
//   node scripts/smoke-hosted.mjs wss://<host>/plugin
//
// The token comes from RELAY_TOKEN, or ./.relay-token if that file exists.

import { readFileSync, existsSync } from 'node:fs'

const socketUrl = process.argv[2]
if (!socketUrl) {
  console.error('Usage: node scripts/smoke-hosted.mjs wss://<host>/plugin')
  process.exit(2)
}
// A token file keeps the credential out of shell history and out of any
// transcript; both names are gitignored.
const tokenFile = ['.figsnap-token', '.relay-token'].find((name) => existsSync(name))
const token = process.env.RELAY_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '')
if (token === '') {
  console.error('No token. Sign in at <relay>/login, copy the token, then:')
  console.error('  pbpaste > .figsnap-token')
  process.exit(2)
}

const base = socketUrl.replace(/^ws/, 'http').replace(/\/plugin$/, '')
const headers = { 'content-type': 'application/json', 'x-relay-token': token }
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

console.log(`relay: ${base}\n`)

const before = await (await fetch(`${base}/health`)).json()
check('health reachable', before.ok === true && before.hosted === true)
check('token required', before.tokenRequired === true)
check('declares storing no images', before.storesImages === false)

// Stand in for the plugin.
const socket = new WebSocket(`${socketUrl}?token=${encodeURIComponent(token)}`)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('socket refused')))
})
const seen = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.kind !== 'request') return
  seen.push(message.command)
  const reply = (data) => socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data }))
  const extraction = (id) => ({
    id,
    name: 'Smoke Frame',
    nodeType: 'FRAME',
    width: 375,
    height: 420,
    layerCount: 3,
    truncated: false,
    css: '.smoke{}',
    tsx: 'export function SmokeFrame() {}',
    moduleCss: '.smoke{}',
    figmaCss: '/* Smoke Frame */',
    png: PNG,
  })
  if (message.command === 'get_tree') reply({ page: 'Page 1', rows: [{ id: '1:1', name: 'Frame', type: 'FRAME', childCount: 0 }] })
  else if (message.command === 'extract') reply(extraction(message.params.nodeId ?? '1:1'))
  else if (message.command === 'export_png') reply({ png: PNG })
  else socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: false, error: `Unknown command: ${message.command}` }))
})
await new Promise((resolve) => setTimeout(resolve, 600))

const after = await (await fetch(`${base}/health`)).json()
check('durable object holds the socket', after.pluginConnected === true, JSON.stringify(after))

const tree = await (await fetch(`${base}/tree`, { headers })).json()
check('GET /tree round trip', tree.page === 'Page 1')

const extraction = await (
  await fetch(`${base}/extract`, { method: 'POST', headers, body: JSON.stringify({ nodeId: '1:1', scale: 2 }) })
).json()
check('POST /extract returns four outputs', ['tsx', 'moduleCss', 'css', 'figmaCss'].every((key) => typeof extraction[key] === 'string'))
check('image is a reference', typeof extraction.png?.url === 'string', extraction.png?.url)

const image = await fetch(extraction.png.url, { headers })
check('image renders on request', image.status === 200 && image.headers.get('content-type') === 'image/png')
check('image is not cacheable', image.headers.get('cache-control') === 'no-store')
check('rendered through the socket', seen.includes('export_png'))

check('local-only route refused', (await fetch(`${base}/fs`, { headers })).status === 501)
check('docs public', (await fetch(`${base}/docs.md`)).status === 200)

socket.close()
await new Promise((resolve) => setTimeout(resolve, 1200))
check('closes down cleanly', (await fetch(`${base}/tree`, { headers })).status === 503)

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
