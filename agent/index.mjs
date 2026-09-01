#!/usr/bin/env node
// figsnap-agent — the local bridge between the Figma panel and a coding agent.
//
// One daemon, three faces, all on loopback:
//
//   · a WebSocket server the plugin panel dials in on          (lib/plugin-socket.mjs)
//   · an ACP client that launches a harness over stdio          (lib/acp.mjs)
//   · an MCP server the harness calls to reach the canvas       (mcp-stdio.mjs)
//
// The panel is the human end of the ACP client. It cannot be the client itself:
// an agent asks its client for a filesystem and a terminal, and a plugin iframe
// has neither. So the daemon holds the machine, the panel holds the person, and
// the socket between them carries both the chat and the tool calls.
//
//   node agent/index.mjs            or, once installed, figsnap-agent
//
// Two things guard the socket, because a local port is reachable by any page
// the designer happens to visit: the Origin header on upgrade, which a browser
// cannot forge, and a token in the query string, because a browser WebSocket
// cannot set headers.

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { WebSocketServer } from 'ws'
import { createPluginSocket } from './lib/plugin-socket.mjs'
import { createRunner } from './lib/acp.mjs'
import { createSessionStore } from './lib/sessions.mjs'
import { createHttpHandler } from './lib/http.mjs'
import { findHarness, surveyHarnesses } from './lib/harnesses.mjs'
import {
  ACCOUNT_FILE,
  clearAccount,
  createAccountGate,
  defaultRelay,
  readAccount,
  signIn,
  whoIs,
  writeAccount,
} from './lib/account.mjs'

const VERSION = '0.1.0'
const here = dirname(fileURLToPath(import.meta.url))
// 3055 stays free for the design relay, should it ever come back.
const PORT = Number(process.env.FIGSNAP_AGENT_PORT ?? 3056)
const HOST = '127.0.0.1'
const TOKEN_FILE = join(homedir(), '.figsnap', 'agent-token')
const quiet = process.argv.includes('--quiet')
// The Edits gate lives in this daemon, which is what makes it one gate rather
// than one per client. Its switch has only ever been in the plugin panel, which
// is the wrong end for someone working in a terminal: writing a fill meant
// switching to Figma and ticking a box first. This is the same explicit act, in
// the place the work is happening. The panel's pill still shows it, and still
// turns it off.
const allowEdits =
  process.argv.includes('--allow-edits') ||
  process.env.FIGSNAP_ALLOW_EDITS === '1' ||
  process.env.FIGSNAP_ALLOW_EDITS === 'true'

// `figsnap-agent --mcp` prints the block an MCP client wants and exits. Printing
// it on every start would be noise; needing it is a one-time job.
if (process.argv.includes('--mcp')) {
  console.log(
    JSON.stringify(
      { mcpServers: { figsnap: { command: 'npx', args: ['-y', 'figsnap-mcp'] } } },
      null,
      2,
    ),
  )
  console.log('\nOr, in a terminal:  claude mcp add figsnap -- npx -y figsnap-mcp')
  console.log('Both find the daemon on 127.0.0.1:3056 and its token in ~/.figsnap/agent-token.')
  process.exit(0)
}

function log(...args) {
  if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...args)
}

/** `--relay https://…`, or `--relay=https://…`, for a relay of one's own. */
function relayArgument() {
  const at = process.argv.indexOf('--relay')
  if (at !== -1 && typeof process.argv[at + 1] === 'string') return process.argv[at + 1].replace(/\/+$/, '')
  const inline = process.argv.find((argument) => argument.startsWith('--relay='))
  return inline === undefined ? defaultRelay() : inline.slice('--relay='.length).replace(/\/+$/, '')
}

/**
 * A plugin iframe cannot open a tab and neither can a pipe, but a terminal can.
 * Failure is silent on purpose: the URL was printed a line earlier, so a machine
 * with no browser has lost nothing.
 */
function openInBrowser(target) {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [target]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', target]]
        : ['xdg-open', [target]]
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref()
  } catch {}
}

// `figsnap-agent login | logout | whoami` — the account, not the daemon. Handled
// before anything is bound to a port, so all three work while a daemon is
// already running, and `login` takes effect in it without a restart.
const subcommand = typeof process.argv[2] === 'string' && !process.argv[2].startsWith('-') ? process.argv[2] : ''

if (subcommand === 'login') {
  const relay = relayArgument()
  try {
    const paired = await signIn(relay, {
      onCode: (pairing) => {
        console.log('\nSign in to Figsnap\n')
        console.log(`  1. open this page   ${pairing.url}`)
        console.log(`  2. your code is     ${pairing.code}`)
        console.log(
          `\nWaiting for the browser. The code is good for ${Math.round(pairing.expiresInMs / 60_000)} minutes.`,
        )
        openInBrowser(pairing.url)
      },
    })
    // The pairing hands over a token and an email; /auth/me is what fills in the
    // room, and it also proves the token works before anything is written down.
    const account = await whoIs(paired.url, paired.token)
    await writeAccount({ ...paired, email: account?.email ?? paired.email, room: account?.room ?? '' })
    console.log(`\nSigned in as ${account?.email ?? paired.email}.`)
    console.log(`Stored in ${ACCOUNT_FILE}. Sign out again with \`figsnap-agent logout\`.`)
    process.exit(0)
  } catch (error) {
    console.error(`\nCould not sign in: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

if (subcommand === 'logout') {
  const account = await readAccount()
  if (account === null) {
    console.log('Nobody is signed in.')
    process.exit(0)
  }
  // Revoked at the relay as well as forgotten here, so a copy of the file that
  // leaked is worth nothing afterwards. A relay that cannot be reached does not
  // stop the local half: forgetting it is still the right thing to do.
  const revoked = await fetch(`${account.url}/auth/revoke`, {
    method: 'POST',
    headers: { 'x-relay-token': account.token },
  }).catch(() => null)
  await clearAccount()
  console.log(
    revoked?.ok === true
      ? `Signed out ${account.email || 'that account'}, and the token is revoked.`
      : `Forgot ${account.email || 'that account'} on this machine, but could not reach ${account.url} to revoke ` +
          'the token. Revoke it from the relay when you can.',
  )
  process.exit(0)
}

if (subcommand === 'whoami') {
  const account = await readAccount()
  if (account === null) {
    console.log('Nobody is signed in. `figsnap-agent login` to change that.')
    process.exit(0)
  }
  const who = await whoIs(account.url, account.token).catch((error) => {
    console.log(`Signed in as ${account.email} at ${account.url}, but could not check it: ${error.message}`)
    process.exit(0)
  })
  console.log(
    who === null
      ? `${account.email} at ${account.url} — revoked. Run \`figsnap-agent login\` again.`
      : `${who.email} at ${account.url}`,
  )
  process.exit(0)
}

if (subcommand !== '') {
  console.error(`No such command: ${subcommand}. Try login, logout or whoami, or no command to run the daemon.`)
  process.exit(1)
}

// Signing in is optional because the daemon is loopback-only and otherwise needs
// no network at all; see lib/account.mjs. This makes it a requirement.
const requireLogin =
  process.argv.includes('--require-login') ||
  process.env.FIGSNAP_REQUIRE_LOGIN === '1' ||
  process.env.FIGSNAP_REQUIRE_LOGIN === 'true'

/**
 * The same token across restarts, so the panel is not re-paired every morning.
 * `--new-token` rotates it, which is the answer if one ever leaks.
 */
async function resolveToken() {
  const fromEnv = process.env.FIGSNAP_AGENT_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  if (!process.argv.includes('--new-token')) {
    const stored = await readFile(TOKEN_FILE, 'utf8').catch(() => null)
    if (stored !== null && stored.trim() !== '') return stored.trim()
  }
  const fresh = randomBytes(24).toString('base64url')
  await mkdir(dirname(TOKEN_FILE), { recursive: true })
  await writeFile(TOKEN_FILE, fresh + '\n', { mode: 0o600 })
  return fresh
}

const TOKEN = await resolveToken()

const plugin = createPluginSocket({ token: TOKEN, log })

// Every session gets this one MCP server, spawned by the harness itself. It is
// this file's sibling and needs nothing but the address and token to call back on.
const mcpServers = [
  {
    name: 'figsnap',
    command: process.execPath,
    args: [join(here, 'mcp-stdio.mjs')],
    env: [
      { name: 'FIGSNAP_AGENT_URL', value: `http://${HOST}:${PORT}` },
      { name: 'FIGSNAP_AGENT_TOKEN', value: TOKEN },
    ],
  },
]

const sessions = createSessionStore({ log })

const runner = createRunner({
  plugin,
  log,
  emit: (frame) => plugin.send(frame),
  mcpServers,
  sessions,
  allowEdits,
})

const recheckMs = Number(process.env.FIGSNAP_ACCOUNT_RECHECK_MS)
const account = createAccountGate({
  log,
  requireLogin,
  ...(Number.isFinite(recheckMs) && recheckMs >= 0 ? { recheckMs } : {}),
})
await account.refresh()

const server = createServer(createHttpHandler({ plugin, runner, account, token: TOKEN, version: VERSION }))
const wss = new WebSocketServer({ server, path: '/panel', maxPayload: 64 * 1024 * 1024 })
wss.on('connection', (socket, req) => plugin.handleConnection(socket, req))

// ------------------------------------------------------------- panel frames
//
// The transport is the relay's, unchanged, so `src/ui/bridge.ts` drives it
// without knowing what is on the other end. These are the frames that are new:
// everything the chat itself needs, in one vocabulary rather than a second socket.

async function onPanelFrame(message) {
  // Every frame the panel sends, named. When something in the panel does not
  // reach here, that is the difference between a broken button and a broken
  // daemon, and there is no other way to tell them apart from this side.
  log(`panel: ${message.kind ?? 'unknown'}`)
  try {
    switch (message.kind) {
      case 'hello':
        // Volunteered, not trusted: this is only ever used to refuse a panel and
        // a daemon signed in as two different people. See lib/account.mjs.
        account.setPanelIdentity(String(message.account ?? ''))
        plugin.send({ kind: 'harnesses', harnesses: await surveyHarnesses() })
        plugin.send({ kind: 'sessions', sessions: await sessions.all() })
        runner.announce()
        break

      case 'sessions':
        await runner.publishSessions()
        break

      case 'forget':
        await runner.forgetSession(String(message.id ?? ''))
        break

      case 'start': {
        const harness = findHarness(String(message.harness ?? ''))
        if (harness === null) throw new Error(`No such harness: ${message.harness}`)
        await runner.start({
          harness,
          cwd: String(message.cwd ?? process.cwd()),
          resume: typeof message.resume === 'string' && message.resume !== '' ? message.resume : null,
          file: message.file ?? null,
        })
        break
      }

      case 'prompt':
        // Deliberately not awaited: the turn streams for minutes, and the panel
        // is told how it ended by the `turn` frames rather than by this returning.
        runner.prompt(String(message.text ?? ''), message.context ?? null, message.attachments ?? []).catch((error) => {
          plugin.send({ kind: 'notice', level: 'error', text: error instanceof Error ? error.message : String(error) })
        })
        break

      case 'cancel':
        await runner.cancel()
        break

      case 'permission':
        runner.answerPermission(String(message.id ?? ''), message.optionId ?? null)
        break

      // The designer signing in or out of the relay while the panel is open.
      case 'account':
        account.setPanelIdentity(String(message.email ?? ''))
        break

      case 'writes':
        runner.setWrites(message.on === true)
        break

      case 'auto':
        runner.setAuto(message.on === true)
        break

      case 'mode':
        await runner.setMode(String(message.modeId ?? ''))
        break

      case 'stop':
        await runner.stop('the panel asked')
        break

      default:
        // `event` frames are the relay's; nothing here subscribes to them.
        break
    }
  } catch (error) {
    plugin.send({ kind: 'notice', level: 'error', text: error instanceof Error ? error.message : String(error) })
  }
}

plugin.onFrame((message) => void onPanelFrame(message))

// A panel that reconnects has forgotten nothing on this side, so it is told
// where the conversation stands rather than starting a new one.
plugin.onPresence((present) => {
  if (present) runner.announce()
  else account.setPanelIdentity('')
})

server.listen(PORT, HOST, async () => {
  const found = (await surveyHarnesses()).filter((harness) => harness.available)
  console.log(`figsnap-agent ${VERSION}`)
  console.log(`  panel socket   ws://${HOST}:${PORT}/panel`)
  console.log(`  http           http://${HOST}:${PORT}`)
  console.log(`  token          ${TOKEN}`)
  console.log(
    found.length === 0
      ? '  harnesses      none found — install Claude Code, Codex or the Gemini CLI'
      : `  harnesses      ${found.map((harness) => harness.name).join(', ')}`,
  )
  console.log(
    allowEdits
      ? '  edits          allowed — started with --allow-edits, so the writing tools are open'
      : '  edits          off — turn them on in the plugin, or start with --allow-edits',
  )
  const who = account.state()
  console.log(
    who.signedIn
      ? `  account        ${who.email}${who.status === 'ok' ? '' : ` (${who.status})`}`
      : requireLogin
        ? '  account        required — run `figsnap-agent login` before any tool will answer'
        : '  account        none — optional; `figsnap-agent login` to attach one',
  )
  console.log('\nPaste the token into the plugin’s Agent tab.')
  console.log('To reach the same designs from a terminal:  claude mcp add figsnap -- npx -y figsnap-mcp')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void runner.stop('the daemon is shutting down').finally(() => process.exit(0))
  })
}
