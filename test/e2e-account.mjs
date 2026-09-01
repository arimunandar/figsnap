// Signing the daemon in to an account, end to end.
//
// Two credentials guard this daemon and they answer different questions. The
// token in ~/.figsnap/agent-token answers "may this process talk to the daemon",
// which is the right shape for a service on 127.0.0.1 but says nothing about
// who. An account answers that, and it is the only one of the two that anybody
// can revoke from somewhere else.
//
// The relay already had a device pairing flow, built so nobody copies a
// 48-character token between a browser and Figma. This suite drives that flow
// from a terminal instead: the CLI asks for a code, something signed in claims
// it, and the daemon is handed a fresh token. The password never goes near the
// CLI, which is the whole point of doing it this way.
//
// The relay here is the real Worker. Only the browser is stood in for.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'

import { requireRelay, account as register } from './support/relay.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = requireRelay('accounts')
const TOKEN = 'a-token-only-the-account-suite-knows'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

function freePort() {
  return new Promise((settle) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => settle(port))
    })
  })
}

async function until(condition, timeoutMs = 20_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let ok = false
    try {
      ok = await condition()
    } catch {
      ok = false
    }
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const errors = []

/**
 * A daemon of its own, with its own HOME so the account file it writes is this
 * suite's and not the machine's.
 */
async function startDaemon(args = []) {
  const home = await mkdtemp(join(tmpdir(), 'figsnap-account-'))
  const port = await freePort()
  const child = spawn(process.execPath, [join(root, 'agent/index.mjs'), '--quiet', ...args], {
    cwd: root,
    env: {
      ...process.env,
      FIGSNAP_AGENT_PORT: String(port),
      FIGSNAP_AGENT_TOKEN: TOKEN,
      FIGSNAP_RELAY_URL: BASE,
      // Revocation has to bite inside a test run, not inside a minute.
      FIGSNAP_ACCOUNT_RECHECK_MS: '0',
      HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (chunk) => errors.push(chunk.toString()))
  const base = `http://127.0.0.1:${port}`
  await until(async () => (await fetch(`${base}/health`)).ok, 15_000, 'the daemon')
  return { child, home, base, port }
}

/** The panel, reduced to answering one command and saying who it is. */
function openPanel(port, { email = '' } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/panel?token=${encodeURIComponent(TOKEN)}`, { origin: 'null' })
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.kind !== 'request') return
    socket.send(
      JSON.stringify({
        kind: 'response',
        id: message.id,
        ok: true,
        data: { page: 'Account page', rows: [{ id: '1:2', name: 'CTA', type: 'FRAME', width: 120, height: 40, childCount: 0 }] },
      }),
    )
  })
  const ready = new Promise((settle, fail) => {
    socket.on('open', () => {
      socket.send(JSON.stringify({ kind: 'hello', account: email }))
      settle()
    })
    socket.on('error', fail)
  })
  return { socket, ready, say: (frame) => socket.send(JSON.stringify(frame)) }
}

const callTool = (base, name = 'figma_get_selection', args = {}) =>
  fetch(`${base}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
    body: JSON.stringify({ name, arguments: args }),
  }).then((response) => response.json())

/** Runs a CLI subcommand against this suite's relay and HOME, and collects it. */
function cli(home, args) {
  const child = spawn(process.execPath, [join(root, 'agent/index.mjs'), ...args], {
    cwd: root,
    env: { ...process.env, HOME: home, FIGSNAP_RELAY_URL: BASE, FIGSNAP_AGENT_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  child.stdout.on('data', (chunk) => {
    text += chunk.toString()
  })
  child.stderr.on('data', (chunk) => {
    text += chunk.toString()
  })
  const done = new Promise((settle) => child.on('exit', (code) => settle({ code, text })))
  return { child, done, read: () => text }
}

// ------------------------------------------------------------------- accounts

const alice = await register(BASE, 'account-alice')
const bob = await register(BASE, 'account-bob')

// --------------------------------------------------- a daemon that insists
//
// Signing in is opt-in, because a loopback-only daemon that needed a hosted
// round trip before answering a local tool call would be a worse product. This
// is the flag for people who want it to be a requirement.

const strict = await startDaemon(['--require-login', '--allow-edits'])

const health = await (await fetch(`${strict.base}/health`)).json()
check('a daemon that requires a login says so before anyone has authenticated',
  health.loginRequired === true, JSON.stringify({ loginRequired: health.loginRequired }))

const panel = openPanel(strict.port, { email: alice.email })
await panel.ready
await until(async () => (await (await fetch(`${strict.base}/health`)).json()).panelConnected === true, 10_000, 'the panel')

const beforeLogin = await callTool(strict.base)
check('and refuses every tool until somebody has',
  typeof beforeLogin.error === 'string' && beforeLogin.error.includes('figsnap-agent login'),
  String(beforeLogin.error).slice(0, 90))
check('the refusal is about the account, not about the plugin or the token',
  !String(beforeLogin.error).includes('not open in Figma'), String(beforeLogin.error).slice(0, 60))

// ------------------------------------------------------------- the device flow
//
// The CLI prints a code and waits; a browser that is already signed in claims
// it. Here the claim is a fetch with Alice's token, which is exactly what
// worker/src/auth-page.js does after her password checks out.

const login = cli(strict.home, ['login'])
await until(() => /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(login.read()), 15_000, 'the pairing code')
const printed = login.read()
const code = /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(printed)[0]
check('login prints a code a person can read out', code.length === 9, code)
check('and the page to open, which is the relay\'s own sign-in page',
  printed.includes(`${BASE}/login?pair=`), printed.split('\n').find((line) => line.includes('open')) ?? '')
check('and it never asks for a password', !/password/i.test(printed))

const claimed = await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': alice.token },
  body: JSON.stringify({ code }),
})
check('a signed-in browser claims the code on its account\'s behalf',
  claimed.ok === true && (await claimed.json()).email === alice.email)

const finished = await login.done
check('the CLI finishes on its own once the browser has done its part',
  finished.code === 0 && finished.text.includes(`Signed in as ${alice.email}`),
  finished.text.trim().split('\n').pop())

const stored = JSON.parse(await readFile(join(strict.home, '.figsnap', 'account.json'), 'utf8'))
check('the token it stored is not the browser\'s own', stored.token !== alice.token)
check('but it does belong to the same account', stored.email === alice.email && stored.room !== '')

// ---------------------------------------------------------------- and now it works

const afterLogin = await callTool(strict.base)
check('a signed-in daemon answers, with no restart in between',
  afterLogin.error === undefined && JSON.stringify(afterLogin.content).includes('CTA'),
  String(afterLogin.error ?? '').slice(0, 90))

const withAccount = await (await fetch(`${strict.base}/health`, { headers: { 'x-figsnap-token': TOKEN } })).json()
check('and health names who it is signed in as',
  withAccount.account.signedIn === true && withAccount.account.email === alice.email &&
  withAccount.account.status === 'ok', JSON.stringify(withAccount.account))
check('while an unauthenticated caller is told nothing about them',
  (await (await fetch(`${strict.base}/health`)).json()).account === undefined)

const whoami = await cli(strict.home, ['whoami']).done
check('whoami says the same thing from a terminal',
  whoami.text.includes(alice.email) && whoami.text.includes(BASE), whoami.text.trim())

// ------------------------------------------------------- two different people
//
// Without this, signing in is theatre: anyone on this machine could sign in as
// themselves and still drive the file somebody else has open.

panel.say({ kind: 'account', email: bob.email })
await new Promise((resolve) => setTimeout(resolve, 200))
const mismatch = await callTool(strict.base)
check('a panel and a daemon signed in as two different people is refused',
  typeof mismatch.error === 'string' && mismatch.error.includes('same account'),
  String(mismatch.error).slice(0, 120))
check('and the refusal names both, so it is obvious which to fix',
  String(mismatch.error).includes(alice.email) && String(mismatch.error).includes(bob.email))

panel.say({ kind: 'account', email: alice.email })
await new Promise((resolve) => setTimeout(resolve, 200))
check('the same person on both sides is fine again', (await callTool(strict.base)).error === undefined)

// A panel that never signed into the relay is not a mismatch: the relay account
// is optional for the plugin, and plenty of people only ever use the daemon.
panel.say({ kind: 'account', email: '' })
await new Promise((resolve) => setTimeout(resolve, 200))
check('a panel with no account of its own is not treated as the wrong one',
  (await callTool(strict.base)).error === undefined)

// --------------------------------------------------------------- revocation
//
// The reason to have accounts at all: a credential somebody else can withdraw.
// The daemon re-asks the relay as it runs, so this does not wait for a restart.

const revoked = await fetch(`${BASE}/auth/revoke`, {
  method: 'POST',
  headers: { 'x-relay-token': stored.token },
})
check('the relay can revoke the token the daemon is holding', revoked.ok === true)

const afterRevoke = await callTool(strict.base)
check('and the running daemon stops answering, without being restarted',
  typeof afterRevoke.error === 'string' && afterRevoke.error.includes('revoked'),
  String(afterRevoke.error).slice(0, 110))
check('saying whose account it was and what to do about it',
  String(afterRevoke.error).includes(alice.email) && String(afterRevoke.error).includes('figsnap-agent login'))

// ------------------------------------------------------------------- logout

const secondLogin = cli(strict.home, ['login'])
await until(() => /[A-Z0-9]{4}-[A-Z0-9]{4}/.test(secondLogin.read()), 15_000, 'the second code')
await fetch(`${BASE}/auth/pair/claim`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-relay-token': alice.token },
  body: JSON.stringify({ code: /[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(secondLogin.read())[0] }),
})
await secondLogin.done
check('signing in again after a revocation works', (await callTool(strict.base)).error === undefined)

const reStored = JSON.parse(await readFile(join(strict.home, '.figsnap', 'account.json'), 'utf8'))
const signedOut = await cli(strict.home, ['logout']).done
check('logout revokes the token as well as forgetting it',
  signedOut.text.includes('revoked'), signedOut.text.trim())
check('so the token it was holding is dead at the relay',
  (await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': reStored.token } })).status === 401)
check('and the file is gone',
  (await readFile(join(strict.home, '.figsnap', 'account.json'), 'utf8').catch(() => null)) === null)
const afterLogout = await callTool(strict.base)
check('a daemon that requires a login is back to refusing',
  typeof afterLogout.error === 'string' && afterLogout.error.includes('figsnap-agent login'),
  String(afterLogout.error).slice(0, 90))

panel.socket.close()
strict.child.kill('SIGTERM')

// ------------------------------------------------------ the default is still free
//
// The promise `claude mcp add figsnap -- npx -y figsnap-mcp` makes is that it
// needs no setup. A daemon with no flag keeps it, and keeps working with no
// network at all.

const relaxed = await startDaemon(['--allow-edits'])
const relaxedPanel = openPanel(relaxed.port)
await relaxedPanel.ready
await until(async () => (await (await fetch(`${relaxed.base}/health`)).json()).panelConnected === true, 10_000, 'the panel')

const openHealth = await (await fetch(`${relaxed.base}/health`)).json()
check('by default no login is required', openHealth.loginRequired === false)
const anonymous = await callTool(relaxed.base)
check('and a signed-out daemon answers as it always did',
  anonymous.error === undefined && JSON.stringify(anonymous.content).includes('CTA'),
  String(anonymous.error ?? '').slice(0, 90))

const noBody = await cli(relaxed.home, ['whoami']).done
check('whoami says so rather than failing', noBody.text.includes('Nobody is signed in'), noBody.text.trim())

const badCommand = await cli(relaxed.home, ['lgoin']).done
check('a mistyped subcommand names the real ones',
  badCommand.code === 1 && badCommand.text.includes('login, logout or whoami'), badCommand.text.trim())

relaxedPanel.socket.close()
relaxed.child.kill('SIGTERM')

await rm(strict.home, { recursive: true, force: true })
await rm(relaxed.home, { recursive: true, force: true })

const failed = out.filter((ok) => !ok).length
if (failed > 0 && errors.length > 0) console.log(`\n${errors.join('')}`)
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
