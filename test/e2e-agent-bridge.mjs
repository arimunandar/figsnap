// The agent daemon, end to end, with a scripted harness on its stdin.
//
// What this proves is the chain, not the model: a prompt goes down the panel's
// socket, the daemon turns it into `session/prompt`, the harness calls an MCP
// tool, and that tool comes back out of the same socket as the `request` frame
// the panel has always answered. The harness is `test/support/fake-acp.mjs`, so
// streaming, permissions and cancellation are deterministic and need no login.
//
// Nothing here touches Figma. The panel is a WebSocket client that answers
// commands the way the main thread would.

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(root, 'test/support/fake-acp.mjs')
const TOKEN = 'a-token-only-this-suite-knows'

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

const PORT = await freePort()
const BASE = `http://127.0.0.1:${PORT}`

const daemon = spawn(process.execPath, [join(root, 'agent/index.mjs'), '--quiet'], {
  cwd: root,
  env: {
    ...process.env,
    FIGSNAP_AGENT_PORT: String(PORT),
    FIGSNAP_AGENT_TOKEN: TOKEN,
    // The registry has no discovery, so a harness is named rather than found —
    // which is also how anyone plugs in an adapter this daemon has never heard of.
    FIGSNAP_AGENT_COMMAND: `node ${FAKE}`,
    FIGSNAP_AGENT_NAME: 'Fake harness',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const daemonErrors = []
daemon.stdout.on('data', () => {})
daemon.stderr.on('data', (chunk) => daemonErrors.push(chunk.toString()))

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
  throw new Error(`timed out waiting for ${label}${daemonErrors.length ? `\n${daemonErrors.join('')}` : ''}`)
}

await until(async () => (await fetch(`${BASE}/health`)).ok, 15_000, 'the daemon')

// ---------------------------------------------------------------- the panel

/** What the main thread would answer, for the handful of commands used here. */
const seen = []
function answer(command, params) {
  seen.push(command)
  switch (command) {
    case 'get_selection':
      return {
        page: 'Agent page',
        rows: [{ id: '1:2', name: 'CTA', type: 'FRAME', width: 120, height: 40, childCount: 1 }],
      }
    case 'set_fill':
      return { id: params.nodeId, name: 'CTA', fills: 1 }
    default:
      throw new Error(`the panel has no ${command}`)
  }
}

function openPanel({ token = TOKEN, origin = 'null' } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/panel?token=${encodeURIComponent(token)}`, { origin })
  const frames = []
  const closed = { code: null }

  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    frames.push(message)
    if (message.kind !== 'request') return
    try {
      socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: true, data: answer(message.command, message.params) }))
    } catch (error) {
      socket.send(JSON.stringify({ kind: 'response', id: message.id, ok: false, error: error.message }))
    }
  })
  socket.on('close', (code) => {
    closed.code = code
  })

  const send = (frame) => socket.send(JSON.stringify(frame))
  const find = (predicate) => frames.find(predicate)
  const wait = (predicate, label) => until(() => find(predicate) !== undefined, 20_000, label).then(() => find(predicate))
  const open = () => new Promise((settle, fail) => {
    if (socket.readyState === socket.OPEN) return settle()
    socket.on('open', settle)
    socket.on('error', fail)
  })

  /** The text the agent said, in the order it said it. */
  const spoken = (kind = 'agent_message_chunk') =>
    frames
      .filter((frame) => frame.kind === 'update' && frame.update.sessionUpdate === kind)
      .map((frame) => frame.update.content.text)
      .join('')

  return { socket, frames, closed, send, find, wait, open, spoken }
}

// -------------------------------------------------------------------- guards
//
// A local port is reachable by any page the designer happens to visit, so both
// halves of the guard are asserted before anything else runs.

const noToken = openPanel({ token: 'wrong' })
await until(() => noToken.closed.code !== null, 10_000, 'the refusal')
check('a bad token is refused', noToken.closed.code === 4001, `code ${noToken.closed.code}`)

const badOrigin = openPanel({ origin: 'https://evil.example' })
await until(() => badOrigin.closed.code !== null, 10_000, 'the refusal')
check('a socket from another origin is refused', badOrigin.closed.code === 4001, `code ${badOrigin.closed.code}`)

const unauthorised = await fetch(`${BASE}/tools`)
check('HTTP without a token is refused', unauthorised.status === 401)

const editorOrigin = openPanel({ origin: 'https://www.figma.com' })
await editorOrigin.open()
check('the editor origin is allowed', editorOrigin.closed.code === null)
editorOrigin.socket.close()

// --------------------------------------------------------------------- hello

const panel = openPanel()
await panel.open()

panel.send({ kind: 'hello' })
const harnesses = await panel.wait((frame) => frame.kind === 'harnesses', 'the harness list')
check('the panel is told what this machine can launch', Array.isArray(harnesses.harnesses) && harnesses.harnesses.length >= 3)
check('a harness named in the environment is offered',
  harnesses.harnesses.some((harness) => harness.id === 'custom' && harness.available))

const idle = await panel.wait((frame) => frame.kind === 'state', 'the opening state')
check('with no session yet', idle.sessionId === null && idle.running === false)
check('and writes off until asked', idle.writes === false)

// ------------------------------------------------------------------- session

panel.frames.length = 0
panel.send({ kind: 'start', harness: 'custom', cwd: root })
const started = await panel.wait((frame) => frame.kind === 'state' && frame.sessionId !== null, 'the session')
check('starting a harness opens a session', started.sessionId === 'fake-session-1')
check('and names the harness back', started.harness?.id === 'custom')

// ----------------------------------------------------- one whole round trip

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'what is selected' })

await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'started', 'the turn')
const ended = await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the answer')
check('the turn ends cleanly', ended.stopReason === 'end_turn')
check('thinking is streamed as its own kind', panel.spoken('agent_thought_chunk') === 'thinking about the request')
check('the tool call reached the panel', seen.includes('get_selection'))
check('and its answer came back through MCP', panel.spoken().includes('"name": "CTA"'), panel.spoken().slice(0, 60))
check('the tool call is reported as it runs',
  panel.frames.some((frame) => frame.kind === 'update' && frame.update.sessionUpdate === 'tool_call') &&
  panel.frames.some((frame) => frame.kind === 'update' && frame.update.sessionUpdate === 'tool_call_update'))

// ------------------------------------------------------- the selection travels
//
// A designer saying "this" is pointing at the canvas. The panel sends what is
// selected alongside the words, as its own block, so the agent does not have to
// guess or spend a turn asking.

panel.frames.length = 0
panel.send({
  kind: 'prompt',
  text: 'what is the context here',
  context: {
    page: 'Bonds',
    rows: [{ id: '21:10314', name: 'Search-notyping', type: 'FRAME', width: 375, height: 812, childCount: 7 }],
  },
})
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the context turn')
check('the selection reaches the agent as its own block',
  panel.spoken().startsWith('[Figma selection]'), panel.spoken().slice(0, 60))
check('naming the layer, its size and its id',
  panel.spoken().includes('Search-notyping') &&
  panel.spoken().includes('375x812') &&
  panel.spoken().includes('21:10314'))
check('and the page it sits on', panel.spoken().includes('page "Bonds"'))

// Several at once is the case that needs pinning in the panel: "make B match A"
// names two nodes and only one of them can be selected.
panel.frames.length = 0
panel.send({
  kind: 'prompt',
  text: 'what is the context here',
  context: {
    page: 'Bonds',
    rows: [
      { id: '21:20000', name: 'Bottomsheet Add to WG', type: 'FRAME', width: 375, height: 300, childCount: 3 },
      { id: '21:30000', name: 'Done button', type: 'INSTANCE', width: 160, height: 44, childCount: 1 },
    ],
  },
})
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the two-layer turn')
check('several layers travel together',
  panel.spoken().includes('Bottomsheet Add to WG') && panel.spoken().includes('Done button'))
check('and are counted rather than described one at a time',
  panel.spoken().includes('has these 2 layers selected'), panel.spoken().split('\n')[0])

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'what is the context here' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the bare turn')
check('a message with nothing selected carries no block', panel.spoken() === 'nothing attached', panel.spoken())

// ------------------------------------------------------------------- writing

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'edit the fill' })
const askedWhileOff = await panel.wait((frame) => frame.kind === 'permission', 'the permission request')
check('an edit asks the designer first', askedWhileOff.toolCall.title.includes('fill'))
panel.send({ kind: 'permission', id: askedWhileOff.id, optionId: 'yes' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the refused edit')
check('but a permitted edit is still refused while writes are off',
  panel.spoken().includes('switched off'), panel.spoken().slice(0, 80))
check('so nothing reached the canvas', !seen.includes('set_fill'))

panel.frames.length = 0
panel.send({ kind: 'writes', on: true })
await panel.wait((frame) => frame.kind === 'state' && frame.writes === true, 'writes on')

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'edit the fill' })
const asked = await panel.wait((frame) => frame.kind === 'permission', 'the permission request')
panel.send({ kind: 'permission', id: asked.id, optionId: 'no' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the refusal')
check('refusing leaves the canvas alone', panel.spoken() === 'refused' && !seen.includes('set_fill'))

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'edit the fill' })
const allowed = await panel.wait((frame) => frame.kind === 'permission', 'the permission request')
panel.send({ kind: 'permission', id: allowed.id, optionId: 'yes' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the edit')
check('an approved edit reaches the canvas', seen.includes('set_fill'))
check('and the panel is told what changed', panel.spoken().includes('"fills": 1'), panel.spoken().slice(0, 80))

// --------------------------------------------------------- auto-approval
//
// Answering every permission by hand turns a five-step change into five
// interruptions. Delegating the answer is not the same as removing the gate:
// writes still decides whether the canvas is reachable, and every automatic
// yes is still announced.

panel.frames.length = 0
panel.send({ kind: 'auto', on: true })
await panel.wait((frame) => frame.kind === 'state' && frame.auto === true, 'auto on')

panel.frames.length = 0
seen.length = 0
panel.send({ kind: 'prompt', text: 'edit the fill' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the unattended edit')
check('an approved-by-default edit needs no prompt',
  panel.find((frame) => frame.kind === 'permission') === undefined)
check('and still reaches the canvas', seen.includes('set_fill'))
check('with the approval on the record',
  panel.frames.some((frame) => frame.kind === 'notice' && frame.level === 'auto' && frame.text.includes('fill')))

// The other gate is untouched by it.
panel.frames.length = 0
seen.length = 0
panel.send({ kind: 'writes', on: false })
await panel.wait((frame) => frame.kind === 'state' && frame.writes === false, 'writes off')
panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'edit the fill' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the refused edit')
check('auto-approval does not open the canvas on its own',
  !seen.includes('set_fill') && panel.spoken().includes('switched off'))

panel.send({ kind: 'writes', on: true })
await panel.wait((frame) => frame.kind === 'state' && frame.writes === true, 'writes back on')
panel.frames.length = 0
panel.send({ kind: 'auto', on: false })
await panel.wait((frame) => frame.kind === 'state' && frame.auto === false, 'auto off')

// ------------------------------------------------------- the client machine

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'read the file' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the read')
check('the daemon answers fs/read_text_file', /read \d+ bytes/.test(panel.spoken()), panel.spoken())

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'escape the directory' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the escape attempt')
check('and refuses a path outside the session directory', panel.spoken() === 'refused the path', panel.spoken())

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'run a command' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the terminal')
check('the daemon owns the terminal too', panel.spoken() === 'from the terminal', panel.spoken())

// ---------------------------------------------------------------- cancelling

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'wait for me' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'started', 'the long turn')
panel.send({ kind: 'cancel' })
const cancelled = await panel.wait(
  (frame) => frame.kind === 'turn' && frame.status === 'ended',
  'the cancellation',
)
check('a turn can be stopped', cancelled.stopReason === 'cancelled', String(cancelled.stopReason))

// ----------------------------------------------------------- what ACP offers
//
// The protocol carries more than a chat, and a client that ignores the rest
// makes the harness look less capable than it is: its own modes, its own
// commands, the evidence behind a tool call, and — for a design tool — a
// picture rather than a description.

const capable = await panel.wait((frame) => frame.kind === 'state' && frame.sessionId !== null, 'the session')
check('the harness says whether it reads images', capable.acceptsImages === true)
check('and the modes it offers are carried back',
  capable.modes?.availableModes?.length === 2 && capable.modes.currentModeId === 'ask',
  JSON.stringify(capable.modes?.currentModeId))
check('as are the commands it publishes',
  capable.commands?.map((command) => command.name).join() === 'review,test',
  JSON.stringify(capable.commands))

panel.frames.length = 0
panel.send({ kind: 'mode', modeId: 'go' })
await panel.wait((frame) => frame.kind === 'state' && frame.modes?.currentModeId === 'go', 'the mode change')
panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'what mode is this' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the mode turn')
check('switching mode reaches the harness', panel.spoken() === 'mode is go', panel.spoken())

panel.frames.length = 0
panel.send({
  kind: 'prompt',
  text: 'here is a picture',
  context: { page: 'Bonds', rows: [{ id: '1:2', name: 'CTA', type: 'FRAME', width: 10, height: 10 }], images: [{ data: 'aGk=', mimeType: 'image/png' }] },
})
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the picture turn')
check('a picture of the design travels as an image block',
  panel.spoken() === 'picture image/png', panel.spoken())

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'attach evidence' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the evidence turn')
const withDiff = panel.frames.find(
  (frame) => frame.kind === 'update' && Array.isArray(frame.update.content) && frame.update.content[0]?.type === 'diff',
)
check('a tool call carries the diff it wrote',
  withDiff?.update.content[0].newText === '.a { color: blue }', JSON.stringify(withDiff?.update.content?.[0]?.path))

panel.frames.length = 0
panel.send({ kind: 'prompt', text: 'run a shell tool' })
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the shell turn')
const withTerminal = panel.frames.find(
  (frame) =>
    frame.kind === 'update' && Array.isArray(frame.update.content) && frame.update.content[0]?.type === 'terminal',
)
// The pointer is useless to the panel, which owns no terminals; the daemon does,
// so it resolves it on the way past.
check('and a terminal pointer arrives already resolved',
  withTerminal?.update.content[0]?._figsnap?.output?.includes('from the terminal') === true,
  JSON.stringify(withTerminal?.update.content?.[0]?._figsnap?.output))

panel.frames.length = 0
panel.send({
  kind: 'prompt',
  text: 'here is a picture',
  attachments: [{ name: 'brief.pdf', mimeType: 'application/pdf', data: 'JVBERi0=' }],
})
await panel.wait((frame) => frame.kind === 'turn' && frame.status === 'ended', 'the attachment turn')
check('a file the harness cannot read is reported rather than dropped in silence',
  panel.frames.some((frame) => frame.kind === 'notice' && frame.text.includes('brief.pdf')),
  panel.frames.filter((frame) => frame.kind === 'notice').map((frame) => frame.text).join(' | '))

// ------------------------------------------------------------------- tools

const toolList = await (await fetch(`${BASE}/tools`, { headers: { 'x-figsnap-token': TOKEN } })).json()
check('every tool is described for the agent', toolList.tools.length >= 31, `${toolList.tools.length} tools`)
check('including the ones that make things, not only change them',
  ['figma_create_text', 'figma_create_rectangle', 'figma_create_svg', 'figma_create_instance', 'figma_list_library']
    .every((name) => toolList.tools.some((tool) => tool.name === name)))
check('reading and writing are marked apart',
  toolList.tools.find((tool) => tool.name === 'figma_extract').annotations.readOnlyHint === true &&
  toolList.tools.find((tool) => tool.name === 'figma_set_fill').annotations.readOnlyHint === false)

const browse = await (await fetch(`${BASE}/fs?path=${encodeURIComponent(root)}`, {
  headers: { 'x-figsnap-token': TOKEN },
})).json()
check('the directory picker lists directories only', browse.directories.includes('agent') && !browse.directories.includes('package.json'))
check('and knows a project when it sees one', browse.isProject === true)

// --------------------------------------------------- the MCP server on its own
//
// The daemon spawns this for the harness it launched, but nothing about it is
// private to that: any MCP client can spawn it and reach the same open file.
// That is the difference between the designs being available inside the
// plugin's chat and being available wherever the designer works.

async function mcpClient(env) {
  const client = new Client({ name: 'suite', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'agent/mcp-stdio.mjs')],
      env: { ...process.env, ...env },
    }),
  )
  return client
}

const standalone = await mcpClient({ FIGSNAP_AGENT_URL: BASE, FIGSNAP_AGENT_TOKEN: TOKEN })
const listed = await standalone.listTools()
check('any MCP client can list the tools', listed.tools.length >= 31, `${listed.tools.length} tools`)

seen.length = 0
const answered = await standalone.callTool({ name: 'figma_get_selection', arguments: {} })
check('and call one, all the way into the plugin',
  answered.isError !== true && seen.includes('get_selection'), JSON.stringify(answered.content?.[0]).slice(0, 80))
await standalone.close()

// A daemon that is not running is the common first-run mistake, and "fetch
// failed" is not something a user can act on.
const orphan = await mcpClient({ FIGSNAP_AGENT_URL: 'http://127.0.0.1:1', FIGSNAP_AGENT_TOKEN: 'x' })
const refused = await orphan.callTool({ name: 'figma_get_selection', arguments: {} })
check('with no daemon it says how to start one',
  refused.isError === true && refused.content[0].text.includes('figsnap-agent'), refused.content[0].text.slice(0, 90))
await orphan.close()

const wrongToken = await mcpClient({ FIGSNAP_AGENT_URL: BASE, FIGSNAP_AGENT_TOKEN: 'not-the-token' })
const rejected = await wrongToken.callTool({ name: 'figma_get_selection', arguments: {} })
check('and a wrong token points at the file the right one is in',
  rejected.isError === true && rejected.content[0].text.includes('.figsnap/agent-token'),
  rejected.content[0].text.slice(0, 90))
await wrongToken.close()

// -------------------------------------------------------------- resumption
//
// A plugin's runtime can be taken away mid-conversation, so a panel that comes
// back with the session id it stored must land in the same conversation.

panel.socket.close()
await until(async () => (await (await fetch(`${BASE}/health`)).json()).panelConnected === false, 10_000, 'the disconnect')

const again = openPanel()
await again.open()
again.send({ kind: 'start', harness: 'custom', cwd: root, resume: 'fake-session-1' })
const resumed = await again.wait((frame) => frame.kind === 'state' && frame.sessionId !== null, 'the resumed session')
check('a stored id resumes rather than starting over', resumed.sessionId === 'fake-session-1')
await again.wait(
  (frame) => frame.kind === 'update' && frame.update.sessionUpdate === 'agent_message_chunk',
  'the replay',
)
check('and the conversation is replayed into the panel', again.spoken() === 'replayed', again.spoken())
check('including what was asked', again.spoken('user_message_chunk') === 'what is selected')

again.socket.close()
daemon.kill('SIGTERM')

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
