// The manual as the relay serves it. Docs describe the API rather than any
// file, so they must answer with no token and no plugin connected — the only
// routes that do.

import { requireRelay } from './support/relay.mjs'

const BASE = requireRelay('docs')
const out = []
const check = (n, ok, d='') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

const html = await fetch(`${BASE}/docs`)
const htmlBody = await html.text()
check('GET /docs without a token', html.status === 200, `status ${html.status}`)
check('serves a full html document', html.headers.get('content-type').startsWith('text/html') && htmlBody.startsWith('<!DOCTYPE html>'))
check('html has the manual', htmlBody.includes('Figsnap') && htmlBody.includes('doc-table'))
check('html tells the reader whose relay this is', htmlBody.includes('served by the relay itself'))
check('address substituted from the request host', htmlBody.includes(`${BASE}/extract`), BASE)

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

const failed = out.filter(v => !v).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
