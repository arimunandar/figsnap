// Accounts on the hosted relay, in the real workerd runtime.
//
// Covers registration, sign-in, lockout, token scoping and revocation. The point
// of the room scoping tests is that a token must reach its own account's designs
// and nobody else's.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 8792
const worker = spawn(
  'npx',
  ['wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--port', String(PORT), '--persist-to', `.wrangler/test-${PORT}`],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
worker.stdout.on('data', () => {})
worker.stderr.on('data', () => {})

const BASE = `http://localhost:${PORT}`
let up = false
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) { up = true; break }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500))
}
if (!up) {
  console.log('SKIP  wrangler dev did not start; accounts not exercised')
  worker.kill()
  process.exit(0)
}

const out = []
const check = (name, ok, detail = '') => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }
const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

const baselineAccounts = (await (await fetch(`${BASE}/health`)).json()).accounts ?? 0
const unique = Date.now()
const alice = { email: `alice-${unique}@example.com`, password: 'correct horse battery' }
const bob = { email: `bob-${unique}@example.com`, password: 'another good passphrase' }

// Production rejects PBKDF2 calls above 100,000 iterations while wrangler dev
// permits them, so the parameters have to be asserted rather than trusted.
const params = await (await fetch(`${BASE}/health`)).json()
check('hashing stays within the platform cap',
  params.hashing.iterations <= params.hashing.cap && params.hashing.total >= 600_000,
  `${params.hashing.rounds} rounds of ${params.hashing.iterations} = ${params.hashing.total}`)

// The page itself.
const page = await fetch(`${BASE}/login`)
const pageHtml = await page.text()
check('/login serves a page', page.status === 200 && pageHtml.includes('Figsnap'))
check('page is never cached', page.headers.get('cache-control') === 'no-store')
check('page offers both actions', pageHtml.includes('Create account') && pageHtml.includes('Sign in'))
check('page asks for nothing but email and password', !pageHtml.includes('Invite code'))
check('password field asks managers for the right thing', pageHtml.includes('autocomplete="current-password"'))

// Registration.
const weak = await (await post('/auth/register', { email: alice.email, password: 'short' })).json()
check('rejects a short password', weak.error?.includes('at least 10'), weak.error)
const malformed = await (await post('/auth/register', { email: 'not-an-email', password: alice.password })).json()
check('rejects a malformed email', malformed.error?.includes('email address'), malformed.error)

const registered = await (await post('/auth/register', alice)).json()
check('registers', typeof registered.token === 'string' && registered.token.length === 48, `token ${registered.token?.length} chars`)
check('reports the account room', typeof registered.room === 'string' && registered.room.length > 10)
check('echoes the email lowercased', registered.email === alice.email.toLowerCase())

const duplicate = await post('/auth/register', alice)
check('refuses a duplicate email', duplicate.status === 400 && (await duplicate.json()).error.includes('already exists'))

// Sign in.
const wrong = await post('/auth/login', { email: alice.email, password: 'wrong password here' })
const wrongBody = await wrong.json()
check('wrong password is refused', wrong.status === 400 && wrongBody.error === 'Wrong email or password.')
const missing = await (await post('/auth/login', { email: `nobody-${unique}@example.com`, password: 'whatever at all' })).json()
check('unknown account gives the same message', missing.error === 'Wrong email or password.', 'no account enumeration')

const signedIn = await (await post('/auth/login', alice)).json()
check('signs in', typeof signedIn.token === 'string')
check('sign-in issues a fresh token', signedIn.token !== registered.token)
check('same account, same room', signedIn.room === registered.room)

// Token identity and scoping.
const me = await (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': signedIn.token } })).json()
check('/auth/me identifies the token', me.email === alice.email.toLowerCase() && me.room === registered.room)
check('/auth/me rejects nonsense', (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': 'nope' } })).status === 401)

const bobRegistered = await (await post('/auth/register', bob)).json()
check('a second account gets a different room', bobRegistered.room !== registered.room)

// Alice's plugin connects; Bob must not see it.
const socket = new WebSocket(`ws://localhost:${PORT}/plugin?token=${signedIn.token}`)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('refused')))
})
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.kind !== 'request') return
  const data = message.command === 'list_saved'
    ? { folders: [{ name: '', count: 1 }], entries: [{ id: '1:1', name: "Alice's private frame", type: 'FRAME', folder: '' }] }
    : { page: 'Alice page', rows: [] }
  socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data }))
})
await new Promise((resolve) => setTimeout(resolve, 500))

const aliceTree = await fetch(`${BASE}/tree`, { headers: { 'x-relay-token': signedIn.token } })
check('own token reaches own plugin', aliceTree.status === 200 && (await aliceTree.json()).page === 'Alice page')
const bobTree = await fetch(`${BASE}/tree`, { headers: { 'x-relay-token': bobRegistered.token } })
check('another account cannot reach it', bobTree.status === 503, `status ${bobTree.status}`)
const noToken = await fetch(`${BASE}/tree`)
check('no token is refused with a pointer to /login', noToken.status === 401 && (await noToken.json()).error.includes('/login'))

// The saved set is the one thing a person curates by hand, so it is worth
// asserting on its own rather than trusting that /tree standing in for it is
// enough: a colleague with their own account must reach their own plugin, and
// through it their own clientStorage, never someone else's.
const aliceSaved = await fetch(`${BASE}/saved`, { headers: { 'x-relay-token': signedIn.token } })
const aliceEntries = (await aliceSaved.json()).entries
check('own token reads own saved set',
  aliceSaved.status === 200 && aliceEntries[0].name === "Alice's private frame")
const bobSaved = await fetch(`${BASE}/saved`, { headers: { 'x-relay-token': bobRegistered.token } })
check('another account cannot read it', bobSaved.status === 503, `status ${bobSaved.status}`)
const bobFolders = await fetch(`${BASE}/folders`, { headers: { 'x-relay-token': bobRegistered.token } })
check('nor the folders it is filed under', bobFolders.status === 503, `status ${bobFolders.status}`)
const bobWrite = await fetch(`${BASE}/saved`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': bobRegistered.token },
  body: JSON.stringify({ selection: true }),
})
check('nor add to it', bobWrite.status === 503, `status ${bobWrite.status}`)

// The saved set follows an account between machines, and is the one thing the
// relay keeps. It has to answer whether or not a plugin is connected — the whole
// point is the other machine, where nothing is open.
const FILE = 'doc-abc'
const shelfPath = `${BASE}/library/${FILE}`
const emptyShelf = await (await fetch(shelfPath, { headers: { 'x-relay-token': signedIn.token } })).json()
check('a file nobody has synced is empty, not an error', emptyShelf.known === false && emptyShelf.entries.length === 0)

const put = (token, body) =>
  fetch(shelfPath, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-relay-token': token },
    body: JSON.stringify(body),
  })

const first = await (await put(signedIn.token, {
  folders: ['Checkout'],
  entries: [{ id: '1:1', name: 'Alpha', type: 'FRAME', addedAt: 1, folder: 'Checkout' }],
  updatedAt: 1000,
})).json()
check('a set can be stored', first.stored === true && first.updatedAt === 1000)

const back = await (await fetch(shelfPath, { headers: { 'x-relay-token': signedIn.token } })).json()
check('and read back on another device', back.known === true && back.entries[0].name === 'Alpha')
check('with its folders', back.folders.length === 1 && back.folders[0] === 'Checkout')

// Last write wins, and an older write loses rather than clobbering.
const newer = await (await put(signedIn.token, { folders: [], entries: [], updatedAt: 2000 })).json()
check('a newer write replaces it', newer.stored === true && newer.entries.length === 0)
const stale = await (await put(signedIn.token, {
  folders: [],
  entries: [{ id: '9:9', name: 'Stale', type: 'FRAME', addedAt: 1, folder: '' }],
  updatedAt: 1500,
})).json()
check('an older one is refused, not silently applied', stale.stored === false && stale.updatedAt === 2000)

// The same boundary as the rooms: an account's set is its own.
const bobShelf = await fetch(shelfPath, { headers: { 'x-relay-token': bobRegistered.token } })
const bobBody = await bobShelf.json()
check('another account sees its own empty shelf, not this one',
  bobShelf.status === 200 && bobBody.known === false, JSON.stringify(bobBody).slice(0, 60))
await put(bobRegistered.token, { folders: [], entries: [{ id: '7:7', name: "Bob's", type: 'FRAME', addedAt: 1, folder: '' }], updatedAt: 3000 })
const aliceAgain = await (await fetch(shelfPath, { headers: { 'x-relay-token': signedIn.token } })).json()
check('and writing to it does not touch this one', aliceAgain.entries.length === 0)

const anon = await fetch(shelfPath)
check('no token reaches no shelf at all', anon.status === 401)

const listed = await (await fetch(`${BASE}/library`, { headers: { 'x-relay-token': signedIn.token } })).json()
check('an account can see which files it has synced',
  listed.files.some((file) => file.fileId === FILE), JSON.stringify(listed.files).slice(0, 80))

const forgotten = await fetch(shelfPath, { method: 'DELETE', headers: { 'x-relay-token': signedIn.token } })
check('and forget one', forgotten.status === 200)
const gone = await (await fetch(shelfPath, { headers: { 'x-relay-token': signedIn.token } })).json()
check('which really removes it', gone.known === false)

// Revocation.
const revoked = await post('/auth/revoke', {}, { 'x-relay-token': registered.token })
check('revokes a token', revoked.status === 200)
check('revoked token stops working', (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': registered.token } })).status === 401)
check('other tokens survive revocation', (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': signedIn.token } })).status === 200)

// Lockout.
const target = { email: bob.email, password: 'definitely not it' }
let locked = false
for (let attempt = 0; attempt < 12; attempt++) {
  const response = await post('/auth/login', target)
  if (response.status === 429) { locked = true; break }
}
check('locks out after repeated failures', locked)
const lockedOut = await post('/auth/login', bob)
check('lockout applies to the right password too', lockedOut.status === 429, `status ${lockedOut.status}`)

// Local Durable Object storage persists between wrangler dev runs, so the count
// is only meaningful as a delta across this run.
const health = await (await fetch(`${BASE}/health`)).json()
check('health counts the accounts just created', health.accounts >= baselineAccounts + 2, `${baselineAccounts} -> ${health.accounts}`)
check('health reports no shared token', health.sharedToken === false)
check('health is public but says so', health.authenticated === false && !('pluginConnected' in health))

// The panel signs in itself, so every route it calls has to answer CORS: a
// sandboxed plugin iframe sends the literal origin "null", and without the header
// the fetch fails before the status is ever visible.
const PANEL = { origin: 'null' }
const cors = (response) => response.headers.get('access-control-allow-origin')

const preflight = await fetch(`${BASE}/auth/login`, {
  method: 'OPTIONS',
  headers: { ...PANEL, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
})
check('preflight is allowed', preflight.status === 204 && cors(preflight) === '*')
check('preflight allows the token header',
  (preflight.headers.get('access-control-allow-headers') ?? '').includes('x-relay-token'))

const panel = { email: `panel-${unique}@example.com`, password: 'a panel typed this one' }
const created = await post('/auth/register', panel, PANEL)
const createdBody = await created.json()
check('the panel can create an account', created.status === 200 && typeof createdBody.token === 'string')
check('registration answers CORS', cors(created) === '*')
check('a token is never cached', created.headers.get('cache-control') === 'no-store')

const panelLogin = await post('/auth/login', panel, PANEL)
check('the panel can sign in', panelLogin.status === 200 && cors(panelLogin) === '*')
const panelToken = (await panelLogin.json()).token

const panelMe = await fetch(`${BASE}/auth/me`, { headers: { ...PANEL, 'x-relay-token': panelToken } })
check('the panel can resume a session', panelMe.status === 200 && cors(panelMe) === '*')

// A refusal has to reach the panel as a status, not as a network error, or the
// gate cannot tell an expired session from an unreachable relay.
const staleSession = await fetch(`${BASE}/auth/me`, { headers: { ...PANEL, 'x-relay-token': 'long gone' } })
check('an expired session is legible to the panel', staleSession.status === 401 && cors(staleSession) === '*')
const badLogin = await post('/auth/login', { email: panel.email, password: 'not the one' }, PANEL)
check('a wrong password is legible to the panel', badLogin.status === 400 && cors(badLogin) === '*')
const gated = await fetch(`${BASE}/tree`, { headers: PANEL })
check('a missing token is legible to the panel', gated.status === 401 && cors(gated) === '*')

// Everything the panel does after signing in, in order: socket, then one HTTP
// call over it. This is the whole "auto connect" path.
const panelSocket = new WebSocket(`ws://localhost:${PORT}/plugin?token=${panelToken}`)
await new Promise((resolve, reject) => {
  panelSocket.addEventListener('open', resolve)
  panelSocket.addEventListener('error', () => reject(new Error('refused')))
})
let pongs = 0
panelSocket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.kind === 'pong') pongs++
  if (message.kind === 'request') {
    panelSocket.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data: { page: 'Panel page', rows: [] } }))
  }
})
await new Promise((resolve) => setTimeout(resolve, 400))

const panelHealth = await fetch(`${BASE}/health`, { headers: { ...PANEL, 'x-relay-token': panelToken } })
const panelHealthBody = await panelHealth.json()
check('a fresh session sees its own plugin', panelHealthBody.pluginConnected === true)
check('health names the account', panelHealthBody.signedIn === panel.email.toLowerCase(), panelHealthBody.signedIn)
const panelTree = await fetch(`${BASE}/tree`, { headers: { 'x-relay-token': panelToken } })
check('the API answers on the new session', panelTree.status === 200 && (await panelTree.json()).page === 'Panel page')

// A silent socket is indistinguishable from a dropped one, which is what made an
// idle plugin reconnect in a loop; the relay answers the plugin's keepalive.
panelSocket.send(JSON.stringify({ kind: 'ping' }))
await new Promise((resolve) => setTimeout(resolve, 400))
check('the relay answers a keepalive ping', pongs === 1, `${pongs} pongs`)
check('a ping does not disturb the socket', panelSocket.readyState === 1)

// Signing out revokes the token, so a copy left anywhere stops working.
const signedOut = await post('/auth/revoke', {}, { ...PANEL, 'x-relay-token': panelToken })
check('the panel can sign out', signedOut.status === 200 && cors(signedOut) === '*')
check('the revoked session is dead',
  (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': panelToken } })).status === 401)

panelSocket.close()

// Pairing: the plugin never has to be handed a token by a human.
const started = await (await fetch(`${BASE}/auth/pair/start`, { method: 'POST' })).json()
check('pairing starts', typeof started.id === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(started.code), started.code)
check('pairing url carries the code', started.url.includes('/login?pair='))

const pendingBefore = await (await fetch(`${BASE}/auth/pair/status?id=${started.id}`)).json()
check('pending until claimed', pendingBefore.status === 'pending')

const unauthenticated = await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.code }),
})
check('claiming needs a signed-in token', unauthenticated.status === 400)

const claim = await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': signedIn.token },
  body: JSON.stringify({ code: started.code }),
})
check('a signed-in browser can claim', claim.status === 200 && (await claim.json()).email === alice.email.toLowerCase())

const delivered = await (await fetch(`${BASE}/auth/pair/status?id=${started.id}`)).json()
check('token delivered once', delivered.status === 'ready' && typeof delivered.token === 'string')
check('paired token is not the browser token', delivered.token !== signedIn.token)
const paired = await (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': delivered.token } })).json()
check('paired token belongs to the same account', paired.email === alice.email.toLowerCase() && paired.room === registered.room)

const again = await (await fetch(`${BASE}/auth/pair/status?id=${started.id}`)).json()
check('the row is gone after pickup', again.status === 'expired')

const reclaim = await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': signedIn.token },
  body: JSON.stringify({ code: started.code }),
})
check('a used code cannot be claimed again', reclaim.status === 400)

const nonsense = await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': signedIn.token },
  body: JSON.stringify({ code: 'ZZZZ-ZZZZ' }),
})
check('an unknown code is refused', nonsense.status === 400)

socket.close()
worker.kill()
const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
