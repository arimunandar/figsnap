// The Claude Code skill files, as the relay serves them.
//
// The relay cannot write them into a project — a Worker has no filesystem — so
// what matters is that they are fetchable without a token, that they are whole
// files an agent can be handed, and that the address baked into them is the one
// that served them.

import { requireRelay, account } from './support/relay.mjs'
import { allEndpoints } from '../shared/endpoints.mjs'

const BASE = requireRelay('skill')
const out = []
const check = (n, ok, d = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

// Public on purpose: the files describe the API, not anyone's designs.
const response = await fetch(`${BASE}/skill`)
const data = await response.json()
check('GET /skill needs no token', response.status === 200 && data.files.length === 2)
check('skill has valid frontmatter', data.files[0].contents.startsWith('---\nname: figsnap'))
check('agent has valid frontmatter', data.files[1].contents.startsWith('---\nname: figsnap-extractor'))
check('the relay address is baked in', data.files[0].contents.includes(`${BASE}/extract`), BASE)
check('paths are where Claude Code looks',
  data.files[0].path === '.claude/skills/figsnap/SKILL.md' &&
  data.files[1].path === '.claude/agents/figsnap-extractor.md')
check('byte counts match the contents',
  data.files.every((file) => file.bytes === file.contents.length))

// One file at a time, so the install is two curls rather than a JSON parse.
const single = await fetch(`${BASE}/skill/SKILL.md`)
const singleBody = await single.text()
check('a single file can be piped straight into place',
  single.status === 200 && singleBody.startsWith('---\nname: figsnap'))
check('served as markdown', (single.headers.get('content-type') ?? '').startsWith('text/markdown'))
const agent = await fetch(`${BASE}/skill/figsnap-extractor.md`)
check('so can the agent', agent.status === 200 && (await agent.text()).includes('figsnap-extractor'))

// The skill must not send an agent at a route that does not exist.
const prefixes = allEndpoints().map((endpoint) => endpoint.path.split('/:')[0])
const cited = [...data.files[0].contents.matchAll(new RegExp(`${BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[a-z./:]+)`, 'g'))]
  .map((match) => match[1].replace(/[.:]$/, ''))
check('it cites only real endpoints',
  cited.every((path) => prefixes.some((prefix) => path.startsWith(prefix))),
  [...new Set(cited)].join(' '))
check('and it cites something', cited.length > 0)

// A plugin iframe sends the literal origin "null"; without CORS the panel could
// not show these at all.
const fromPanel = await fetch(`${BASE}/skill`, { headers: { origin: 'null' } })
check('the panel can fetch them', fromPanel.headers.get('access-control-allow-origin') === '*')

// The routes that do touch a design still refuse an anonymous caller.
const { headers } = await account(BASE, 'skill')
check('a real account is still needed for a design',
  (await fetch(`${BASE}/tree`)).status === 401 &&
  (await fetch(`${BASE}/tree`, { headers })).status === 503)

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
