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
import { createHttpHandler } from './lib/http.mjs'
import { findHarness, surveyHarnesses } from './lib/harnesses.mjs'

const VERSION = '0.1.0'
const here = dirname(fileURLToPath(import.meta.url))
// 3055 stays free for the design relay, should it ever come back.
const PORT = Number(process.env.FIGSNAP_AGENT_PORT ?? 3056)
const HOST = '127.0.0.1'
const TOKEN_FILE = join(homedir(), '.figsnap', 'agent-token')
const quiet = process.argv.includes('--quiet')

function log(...args) {
  if (!quiet) console.log(new Date().toISOString().slice(11, 19), ...args)
}

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

const runner = createRunner({
  plugin,
  log,
  emit: (frame) => plugin.send(frame),
  mcpServers,
})

const server = createServer(createHttpHandler({ plugin, runner, token: TOKEN, version: VERSION }))
const wss = new WebSocketServer({ server, path: '/panel', maxPayload: 64 * 1024 * 1024 })
wss.on('connection', (socket, req) => plugin.handleConnection(socket, req))

// ------------------------------------------------------------- panel frames
//
// The transport is the relay's, unchanged, so `src/ui/bridge.ts` drives it
// without knowing what is on the other end. These are the frames that are new:
// everything the chat itself needs, in one vocabulary rather than a second socket.

async function onPanelFrame(message) {
  try {
    switch (message.kind) {
      case 'hello':
        plugin.send({ kind: 'harnesses', harnesses: await surveyHarnesses() })
        runner.announce()
        break

      case 'start': {
        const harness = findHarness(String(message.harness ?? ''))
        if (harness === null) throw new Error(`No such harness: ${message.harness}`)
        await runner.start({
          harness,
          cwd: String(message.cwd ?? process.cwd()),
          resume: typeof message.resume === 'string' && message.resume !== '' ? message.resume : null,
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
  console.log('\nPaste the token into the plugin’s Agent tab.')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void runner.stop('the daemon is shutting down').finally(() => process.exit(0))
  })
}
