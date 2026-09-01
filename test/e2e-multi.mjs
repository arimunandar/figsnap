import { requireRelay, account, authenticateFetch } from './support/relay.mjs'

const BASE = requireRelay('multi')
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }


const { token, headers } = await account(BASE, 'multi')
authenticateFetch(BASE, headers)

const socket = new WebSocket(`${BASE.replace(/^http/, 'ws')}/plugin?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { socket.addEventListener('open', res); socket.addEventListener('error', rej) })
const seen = []
let pongs = 0
const ex = (name, id) => ({ id, name, nodeType: 'FRAME', width: 375, height: 812, layerCount: 12, truncated: false, css: '.a{}', tsx: `export function ${name}(){}`, moduleCss: '.a{}', png: PNG })
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.kind === 'pong') { pongs++; return }
  if (msg.kind !== 'request') return
  seen.push({ command: msg.command, params: msg.params })
  const reply = (data) => socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: true, data }))
  if (msg.command === 'export_png') {
    reply({ png: PNG })
  } else if (msg.command === 'extract_nodes') {
    reply({ results: msg.params.nodeIds.map((id, i) => ({ ref: id, nodeId: id, ok: true, extraction: ex(`Node${i}`, id) })) })
  } else if (msg.command === 'extract_selection') {
    reply({ results: [
      { ref: '1:1', nodeId: '1:1', ok: true, extraction: ex('A', '1:1') },
      { ref: '1:2', nodeId: '1:2', ok: true, extraction: ex('B', '1:2') },
      { ref: '1:3', nodeId: '1:3', ok: false, error: 'Layer is hidden.' },
    ] })
  } else if (msg.command === 'extract_urls') {
    reply({ results: [{ ref: 'u', nodeId: '2:2', ok: true, extraction: ex('U', '2:2') }] })
  } else if (msg.command === 'get_selection') {
    reply({ page: 'Page 1', rows: [{ id: '1:1', name: 'A', type: 'FRAME', childCount: 2 }, { id: '1:2', name: 'B', type: 'FRAME', childCount: 3 }] })
  } else if (msg.command === 'extract') {
    reply(ex('Single', '1:1'))
  } else socket.send(JSON.stringify({ kind: 'response', id: msg.id, ok: false, error: 'unknown' }))
})
await new Promise((r) => setTimeout(r, 200))

const post = (body) => fetch(`${BASE}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())

const sel = await post({ selection: true })
check('selection:true -> extract_selection', seen.at(-1).command === 'extract_selection', seen.at(-1).command)
check('selection batch returns 3', sel.results?.length === 3)
check('ok entries carry png urls', sel.results.filter((r) => r.ok).every((r) => r.extraction.png.url.startsWith('http')))
check('hidden layer error preserved', sel.results[2].ok === false && sel.results[2].error === 'Layer is hidden.')
const png = await fetch(sel.results[0].extraction.png.url)
check('selection asset downloadable', png.status === 200 && png.headers.get('content-type') === 'image/png')

const ids = await post({ nodeIds: ['21:10314', '21:10384', '21:1'] })
check('nodeIds -> extract_nodes', seen.at(-1).command === 'extract_nodes', seen.at(-1).command)
check('nodeIds returns one per id', ids.results?.length === 3 && ids.results[2].nodeId === '21:1')

const single = await post({})
check('empty body still single', seen.at(-1).command === 'extract' && single.name === 'Single')

const both = await post({ urls: 'https://www.figma.com/design/K/N?node-id=1-2', nodeIds: ['9:9'], selection: true })
check('urls wins when several given', seen.at(-1).command === 'extract_urls' && both.results.length === 1)

const selectionList = await (await fetch(`${BASE}/selection`)).json()
check('GET /selection lists all selected', selectionList.rows?.length === 2, selectionList.rows?.map((r) => r.name).join(','))

// The plugin pings an idle socket rather than trusting silence; both relays have
// to answer, or the client closes a connection that was fine.
socket.send(JSON.stringify({ kind: 'ping' }))
await new Promise((r) => setTimeout(r, 300))
check('local relay answers a keepalive ping', pongs === 1, `${pongs} pongs`)
check('a ping is not treated as a command', seen.at(-1).command === 'get_selection')

socket.close()
const bad = out.filter((v) => !v).length
console.log(`\n${out.length - bad}/${out.length} passed`)
process.exit(bad === 0 ? 0 : 1)
