import { spawn } from 'node:child_process'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allEndpoints } from '../shared/endpoints.mjs'

const PORT = 3094
const TOKEN = 'skilltok'
const BASE = `http://127.0.0.1:${PORT}`
const H = { 'content-type': 'application/json', 'x-relay-token': TOKEN }
const out = []
const check = (n, ok, d='') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`) }

const relay = spawn('node', [new URL('../server/relay.mjs', import.meta.url).pathname], { env: { ...process.env, RELAY_PORT: String(PORT), RELAY_TOKEN: TOKEN }, stdio: ['ignore','pipe','pipe'] })
relay.stderr.on('data', (d) => console.error('[relay]', d.toString().trim()))
for (let i = 0; i < 50; i++) { try { await fetch(`${BASE}/health`); break } catch { await new Promise(r => setTimeout(r, 100)) } }

const project = await mkdtemp(join(tmpdir(), 'figma-skill-'))
await mkdir(join(project, 'src'))
await mkdir(join(project, '.hidden'))
await writeFile(join(project, 'package.json'), '{}')

// /skill is readable without a token; installing is not.
const openSkill = await fetch(`${BASE}/skill`)
const skillData = await openSkill.json()
check('GET /skill without a token', openSkill.status === 200 && skillData.files.length === 2)
check('skill has valid frontmatter', skillData.files[0].contents.startsWith('---\nname: figsnap'))
check('agent has valid frontmatter', skillData.files[1].contents.startsWith('---\nname: figsnap-extractor'))
check('relay url baked in', skillData.files[0].contents.includes(`${BASE}/extract`), BASE)

const noToken = await fetch(`${BASE}/skill/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ directory: project }) })
check('install needs the token', noToken.status === 401, `status ${noToken.status}`)
const browseNoToken = await fetch(`${BASE}/fs`)
check('browsing needs the token', browseNoToken.status === 401, `status ${browseNoToken.status}`)

const listing = await (await fetch(`${BASE}/fs?path=${encodeURIComponent(project)}`, { headers: H })).json()
check('lists directories only', listing.directories.includes('src') && !listing.directories.includes('package.json'))
check('hides dotfiles', !listing.directories.includes('.hidden'))
check('detects a project', listing.isProject === true && listing.hasSkill === false)
check('parent offered', typeof listing.parent === 'string')

const install = await (await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: JSON.stringify({ directory: project }) })).json()
check('installs both files', install.written?.length === 2, (install.written || []).join(', '))
const onDisk = await readFile(join(project, '.claude/skills/figsnap/SKILL.md'), 'utf8')
check('SKILL.md written to the right path', onDisk.includes('name: figsnap'))
const agentOnDisk = await readFile(join(project, '.claude/agents/figsnap-extractor.md'), 'utf8')
check('agent written to the right path', agentOnDisk.includes('name: figsnap-extractor'))

const again = await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: JSON.stringify({ directory: project }) })
const conflict = await again.json()
check('refuses to overwrite silently', again.status === 409 && conflict.existing.length === 2, `status ${again.status}`)
const forced = await (await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: JSON.stringify({ directory: project, force: true }) })).json()
check('force overwrites', forced.written?.length === 2 && forced.overwritten?.length === 2)

const relative = await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: JSON.stringify({ directory: 'not/absolute' }) })
check('rejects a relative path', relative.status === 400, `status ${relative.status}`)
const missing = await fetch(`${BASE}/skill/install`, { method: 'POST', headers: H, body: JSON.stringify({ directory: join(project, 'nope') }) })
check('rejects a missing directory', missing.status === 400, `status ${missing.status}`)

// The skill must describe endpoints that actually exist.
const skill = skillData.files[0].contents
const paths = [...skill.matchAll(/127\.0\.0\.1:\d+(\/[a-z./:]+)/g)].map(m => m[1].replace(/[.:]$/, ''))
// The allow-list is the catalogue, so the skill cannot cite a route that is not served.
const known = allEndpoints().map(e => e.path.split('/:')[0])
check('skill cites only real endpoints', paths.every(p => known.some(k => p.startsWith(k))), [...new Set(paths)].join(' '))

const fromPlugin = await fetch(`${BASE}/fs?path=${encodeURIComponent(project)}`, { headers: { ...H, origin: 'null' } })
check('allows the plugin iframe (origin null)', fromPlugin.headers.get('access-control-allow-origin') === 'null', String(fromPlugin.headers.get('access-control-allow-origin')))
const fromSite = await fetch(`${BASE}/health`, { headers: { origin: 'https://evil.example' } })
check('blocks other websites', fromSite.headers.get('access-control-allow-origin') === null)
const preflight = await fetch(`${BASE}/skill/install`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST' } })
check('answers the preflight', preflight.status === 204 && (preflight.headers.get('access-control-allow-headers') ?? '').includes('x-relay-token'), `status ${preflight.status}`)

await rm(project, { recursive: true, force: true })
relay.kill()
const failed = out.filter(v => !v).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
