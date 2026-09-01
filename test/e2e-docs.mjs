import { spawn } from 'node:child_process'

const PORT = 3095
const TOKEN = 'docstok'
const BASE = `http://127.0.0.1:${PORT}`
const out = []
const check = (n, ok, d='') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

const relay = spawn('node', [new URL('../server/relay.mjs', import.meta.url).pathname], { env: { ...process.env, RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN }, stdio: ['ignore','pipe','pipe'] })
relay.stderr.on('data', (d) => console.error('[relay]', d.toString().trim()))
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break } catch { await new Promise(r => setTimeout(r, 100)) } }

// Docs must work with a token set, no token sent, and no plugin connected.
const html = await fetch(`${BASE}/docs`)
const htmlBody = await html.text()
check('GET /docs without a token', html.status === 200, `status ${html.status}`)
check('serves a full html document', html.headers.get('content-type').startsWith('text/html') && htmlBody.startsWith('<!DOCTYPE html>'))
check('html has the manual', htmlBody.includes('Figsnap') && htmlBody.includes('doc-table'))
check('html reports the plugin offline', htmlBody.includes('not connected (off)') && htmlBody.includes('npm run relay'))
check('port substituted from the request host', htmlBody.includes(`${BASE}/extract`), BASE)

const md = await fetch(`${BASE}/docs.md`)
const mdBody = await md.text()
check('GET /docs.md', md.status === 200 && md.headers.get('content-type').startsWith('text/markdown'))
check('markdown headings', mdBody.startsWith('# Figsnap') && mdBody.includes('\n## Driving the plugin from outside'))
check('markdown pipe tables', mdBody.includes('| Method | Path | Purpose |') && mdBody.includes('| --- |'))
check('markdown fenced code', mdBody.includes('```'))
check('markdown keeps inline markup', mdBody.includes('`getCSSAsync()`') && mdBody.includes('**Click any row**'))
check('markdown has no html tags', !/<\/?(p|h2|table|code|strong)\b/.test(mdBody))

const negotiated = await fetch(`${BASE}/docs`, { headers: { accept: 'text/markdown' } })
check('accept: text/markdown on /docs', (await negotiated.text()).startsWith('# Figsnap'))
const queried = await fetch(`${BASE}/docs?format=md`)
check('?format=md', (await queried.text()).startsWith('# Figsnap'))

const json = await (await fetch(`${BASE}/docs.json`)).json()
check('GET /docs.json', Array.isArray(json.sections) && json.sections.length >= 9, `${json.sections?.length} sections`)
const types = new Set(json.sections.flatMap(s => s.blocks.map(b => b.type)))
check('json block types', [...types].every(t => ['lead','p','h3','code','ul','table'].includes(t)), [...types].join(','))

// Other routes must still demand the token.
const guarded = await fetch(`${BASE}/tree`)
check('other routes still need the token', guarded.status === 401, `status ${guarded.status}`)

relay.kill()
const failed = out.filter(v => !v).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
