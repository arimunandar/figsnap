// The docs and skill renderers, tested directly.
//
// These are pure functions over shared/*.mjs, so they run in plain Node with no
// runtime, no relay and no network. The HTTP behaviour that wraps them is covered
// by e2e-docs.mjs (local relay) and e2e-worker-relay.mjs (hosted).

import { docsSections, renderDocsHtml, renderDocsMarkdown } from '../shared/docs.mjs'
import { skillFiles } from '../shared/skill.mjs'
import { allEndpoints } from '../shared/endpoints.mjs'

const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

// The plugin serves no manual of its own; the relay is the only surface.
const panel = { httpBase: 'http://localhost:3055', relayState: 'open', nodeId: '21:10314', surface: 'http' }
const html = renderDocsHtml(panel)

// Hand-written markup, so balance is worth asserting.
const opens = {}, closes = {}
for (const m of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*?(\/?)>/g)) { if (m[2] !== '/') opens[m[1]] = (opens[m[1]] || 0) + 1 }
for (const m of html.matchAll(/<\/([a-z][a-z0-9]*)>/g)) closes[m[1]] = (closes[m[1]] || 0) + 1
const unbalanced = Object.keys(opens).filter((tag) => opens[tag] !== (closes[tag] || 0))
check('html tags balanced', unbalanced.length === 0, unbalanced.map((t) => `${t}:${opens[t]}/${closes[t] || 0}`).join(','))

check('inline code converted', html.includes('<code>getCSSAsync()</code>'))
check('bold converted', html.includes('<strong>Click any row</strong>'))
check('jsx sample escaped', html.includes('&lt;SelectionList') && !html.includes('<SelectionList'))
check('no unresolved template holes', !html.includes('${'))
check('renders a bare article, not a document', html.startsWith('<article class="doc">') && !html.includes('<!DOCTYPE'))
check('points at the panel\'s Relay page', html.includes('<strong>Relay</strong> page'))
// Nothing interactive belongs in text the relay serves to anyone who asks.
check('embeds no plugin controls', !html.includes('id="installer"') && !html.includes('id="relay-url"'))

const publicHtml = renderDocsHtml({ ...panel, surface: 'public', relayState: 'off' })
check('public page omits any control', !publicHtml.includes('<button'))
check('public page says the relay is the reader\'s own', publicHtml.includes('<strong>your own machine</strong>'))

const md = renderDocsMarkdown(panel)
check('markdown starts with the title', md.startsWith('# Figsnap'))
check('markdown pipe tables', md.includes('| Method | Path | Purpose |') && md.includes('| --- |'))
check('markdown fenced code', md.includes('```'))
check('markdown keeps inline markup', md.includes('`getCSSAsync()`') && md.includes('**Click any row**'))
check('markdown carries no html', !/<\/?(p|h2|table|code|strong)\b/.test(md))
// A shell comment inside a fenced block starts with # too, so the fences have
// to be tracked rather than every line matched.
check('markdown covers every section', (() => {
  let fenced = false
  const headings = md.split('\n').filter((line) => {
    if (line.startsWith('```')) { fenced = !fenced; return false }
    return !fenced && /^##? /.test(line)
  })
  // The first section is the title, so heading lines and sections match one to one.
  return headings.length === docsSections(panel).length
})())

check('docs state that images are not stored', md.includes('Nothing is cached and nothing is stored'))
check('docs describe the hosted option', md.includes('Durable Object'))

const files = skillFiles({ httpBase: 'http://localhost:3055' })
check('skill and agent produced', files.length === 2)
check('skill frontmatter', files[0].contents.startsWith('---\nname: figsnap'))
check('agent frontmatter', files[1].contents.startsWith('---\nname: figsnap-extractor'))
check('skill warns image urls re-render', files[0].contents.includes('re-renders the node on request'))
check('skill notes the hosted local-only routes', files[0].contents.includes('answer `501`'))
// The allow-list is the catalogue itself, so the skill cannot cite a route the
// relay does not serve, and a new route does not fail this for the wrong reason.
const routePrefixes = allEndpoints().map((endpoint) => endpoint.path.split('/:')[0])
check('skill cites only real endpoints', (() => {
  const cited = [...files[0].contents.matchAll(/localhost:3055(\/[a-z./:]+)/g)].map((m) => m[1].replace(/[.:]$/, ''))
  return cited.every((path) => routePrefixes.some((prefix) => path.startsWith(prefix)))
})())

// The skill exists to stop an agent doing the expensive thing by default.
const skill = files[0].contents
check('skill teaches the depth walk', skill.includes('?depth=') && skill.includes('depth=all'))
check('skill warns the deep walk is capped', skill.includes('2000'))
check('skill teaches choosing outputs', skill.includes('format') && skill.includes('"format":["tsx","moduleCss"]'))
check('skill names figmaCss as the expensive one', skill.includes('figmaCss'))

const agent = files[1].contents
check('the extractor agent knows both', agent.includes('?depth=') && agent.includes('format'))
check('and is told to ask for less', agent.includes('Ask only for the outputs'))

const failed = out.filter((value) => !value).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
