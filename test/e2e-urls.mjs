import { requireRelay, account, authenticateFetch } from './support/relay.mjs'

const BASE = requireRelay('urls')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

const { token, headers } = await account(BASE, 'urls')
authenticateFetch(BASE, headers)

const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/plugin?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
const seen = []
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.kind !== 'request') return
  seen.push({ command: msg.command, params: msg.params })
  const reply = (data) => socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: true, data }))
  const make = (name, node) => ({ id: node, name, nodeType: 'FRAME', width: 375, height: 812, layerCount: 12, truncated: false, css: '.a{}', tsx: `export function ${name}(){}`, moduleCss: '.a{}', png: PNG })
  if (msg.command === 'export_png') {
    reply({ png: PNG })
  } else if (msg.command === 'extract_urls') {
    reply({ results: [
      { url: 'u1', nodeId: '21:10314', ok: true, extraction: make('Search', '21:10314') },
      { url: 'u2', nodeId: '21:10384', ok: true, extraction: make('Sheet', '21:10384') },
      { url: 'u3', nodeId: '9:9', ok: false, error: 'No node 9:9 in this file.' },
    ] })
  } else if (msg.command === 'resolve_urls') {
    reply({ fileKey: 'efJbUBpP4kyU3pr0CuX6eK', rows: [{ url: 'u1', nodeId: '21:10314', ok: true, node: { id: '21:10314', name: 'Search', type: 'FRAME', childCount: 7 } }] })
  } else if (msg.command === 'extract') {
    reply(make('FromUrl', '21:10314'))
  } else socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: false, error: 'unknown' }))
})
await new Promise((r) => setTimeout(r, 200))

const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const batch = await (await post('/extract', { urls: ['https://www.figma.com/design/K/N?node-id=21-10314', 'https://www.figma.com/design/K/N?node-id=21-10384'] })).json()
check('batch routes to extract_urls', seen.at(-1).command === 'extract_urls', seen.at(-1).command)
check('batch returns 3 results', batch.results?.length === 3)
check('each ok result got a png url', batch.results.filter((r) => r.ok).every((r) => typeof r.extraction.png.url === 'string'), batch.results[0].extraction.png.url)
check('failed result keeps its error', batch.results[2].ok === false && batch.results[2].error.includes('9:9'))

const pngRes = await fetch(batch.results[0].extraction.png.url)
check('batch asset downloadable', pngRes.status === 200 && pngRes.headers.get('content-type') === 'image/png')

const single = await (await post('/extract', { url: 'https://www.figma.com/design/K/N?node-id=21-10314' })).json()
check('single url routes to extract', seen.at(-1).command === 'extract' && seen.at(-1).params.url.includes('node-id'), seen.at(-1).command)
check('single url returns one extraction', single.name === 'FromUrl' && typeof single.png.url === 'string')

const resolved = await (await post('/resolve', { urls: 'https://www.figma.com/design/K/N?node-id=21-10314' })).json()
check('POST /resolve works', resolved.rows?.[0]?.node?.name === 'Search', JSON.stringify(resolved.rows?.[0]?.node))

const stringUrls = await (await post('/extract', { urls: 'one\nhttps://www.figma.com/design/K/N?node-id=1-2' })).json()
check('urls as newline string also batches', seen.at(-1).command === 'extract_urls' && stringUrls.results?.length === 3)

socket.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
