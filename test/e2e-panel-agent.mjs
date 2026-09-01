// The Agent tab, in the shipped dist/ui.html.
//
// The daemon is faked here and the main thread is faked here, which leaves
// exactly one real thing in the middle: the panel. So this asserts what the
// panel does with a conversation — how it streams, when it asks, what it stores
// and what it sends back — while e2e-agent-bridge.mjs asserts the other side.
//
// The one join between them is the `request` frame: the daemon sends it, the
// panel relays it to the main thread, and the answer goes back out. That is the
// path every tool call takes, so it is exercised here too.

import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { openPanel, until } from './support/panel.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ------------------------------------------------------------ a fake daemon

const HARNESSES = [
  { id: 'claude', name: 'Claude Code', command: 'npx claude', available: true, note: '' },
  { id: 'codex', name: 'Codex', command: 'npx codex', available: false, note: 'not installed' },
]

const received = []
const sockets = []
let panelSocket = null

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const body =
    url.pathname === '/fs'
      ? {
          path: url.searchParams.get('path') ?? '/Users/designer',
          parent: '/Users',
          home: '/Users/designer',
          directories: ['work', 'checkout-app'],
          isProject: true,
        }
      : url.pathname === '/tools'
        ? {
            tools: [
              { name: 'figma_extract', title: 'Read', description: 'Reads a design.', annotations: { readOnlyHint: true } },
              { name: 'figma_set_fill', title: 'Fill', description: 'Sets a fill.', annotations: { readOnlyHint: false } },
            ],
          }
        : { ok: true }
  const payload = JSON.stringify(body)
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(payload)
})

const wss = new WebSocketServer({ server: http, path: '/panel' })
wss.on('connection', (socket) => {
  sockets.push(socket)
  panelSocket = socket
  socket.on('message', (raw) => received.push(JSON.parse(raw.toString())))
})

const PORT = await new Promise((settle) => {
  http.listen(0, '127.0.0.1', () => settle(http.address().port))
})
const AGENT_URL = `ws://127.0.0.1:${PORT}/panel`

const push = (frame) => panelSocket.send(JSON.stringify(frame))
const update = (body) => push({ kind: 'update', sessionId: 's1', update: body })
const chunk = (kind, text) => update({ sessionUpdate: kind, content: { type: 'text', text } })
const sawFrame = (kind) => received.find((frame) => frame.kind === kind)

// ------------------------------------------------------------- the panel

const answered = []
const { window, id, send, posted, settle, workspace } = await openPanel({
  agent: { url: AGENT_URL, token: 'a stored daemon token', cwd: '', harness: '', sessionId: '', writes: false, auto: true },
  online: true,
  onMessage(message, api) {
    if (message.type !== 'req') return
    answered.push(message.command)
    api.send({
      type: 'res',
      id: message.id,
      ok: true,
      data: { page: 'Agent page', rows: [{ id: '1:2', name: 'CTA', type: 'FRAME', width: 120, height: 40, childCount: 0 }] },
    })
  },
})

check('the panel opens on the workspace, showing code', workspace().hidden === false && id('agent-column').hidden === true)
check('and offers an Agent button', id('agent-toggle-page') !== null)

// The agent takes the third column outright, tab strip included — the point is
// having the layer tree and the preview beside the conversation.
id('agent-toggle-page').click()
await settle()
check('the agent takes over the code column',
  id('agent-column').hidden === false && id('code-tabs').hidden === true && id('editor').hidden === true)
check('the rest of the workspace stays put',
  workspace().hidden === false && id('tree-panel').hidden === false)
check('and the button offers the code back', id('agent-toggle-page').textContent === 'Code')

// A stored token means the daemon was paired before, so the panel dials on its
// own rather than waiting for a click.
await until(() => panelSocket !== null, 10_000, 'the socket')
await until(() => sawFrame('hello') !== undefined, 10_000, 'the greeting')
check('a stored token connects without being asked', sawFrame('hello') !== undefined)
check('and the remembered switches go over with the greeting',
  sawFrame('writes')?.on === false && sawFrame('auto')?.on === true)
check('the connection is shown as open', id('agent-dot').className === 'dot open')

// Reconnecting must replace the socket, not join it. Two live sockets from one
// panel make the daemon kick one, and the kicked one's close would otherwise
// speak for the survivor — which reads as "Disconnected" on a working link.
id('agent-connect').click()
await until(() => sockets.length === 2, 10_000, 'the second socket')
await until(() => sockets[0].readyState === sockets[0].CLOSED, 10_000, 'the first socket closing')
await until(() => id('agent-dot').className === 'dot open', 10_000, 'the reconnection')

// Long enough to outlast the one-second retry the replaced socket's own close
// would schedule. Checking any sooner passes on a bridge that is about to open
// a third socket and tear itself down a second later.
await new Promise((resolve) => setTimeout(resolve, 2500))
check('reconnecting opens exactly one socket', sockets.length === 2, `${sockets.length} opened`)
check('and the panel still reads as connected', id('agent-dot').className === 'dot open', id('agent-dot').className)

// The daemon closes a superseded socket with 4000. Arriving after the live one
// is up, it must not take the bridge down with it.
sockets[0].close(4000, 'Replaced by a newer plugin connection')
await settle()
check('a stale replacement close is ignored', id('agent-dot').className === 'dot open')

// ------------------------------------------------------------- setting up
//
// Pairing and the reference live on their own page, behind Setup; only the
// session controls are in the column.

id('agent-setup-link').click()
await settle()
check('Setup opens the pairing page', id('agent-page').hidden === false)

push({ kind: 'harnesses', harnesses: HARNESSES })
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: false, auto: true, connected: true })
await settle()

const chips = () => [...id('agent-harnesses').querySelectorAll('.chip')]
check('the harness picker lists what the daemon found', chips().length === 2, chips().map((chip) => chip.textContent).join(' | '))
check('one that is not installed cannot be picked',
  chips()[1].disabled === true && chips()[1].textContent.includes('not installed'))
check('starting is refused until a harness is picked', id('agent-start').disabled === true)

// A machine with nothing installed should say so, not present a row of chips
// that all refuse to be clicked.
push({ kind: 'harnesses', harnesses: HARNESSES.map((harness) => ({ ...harness, available: false })) })
await settle()
check('a machine with no harness is told so',
  id('agent-harnesses').textContent.includes('No harness found'), id('agent-harnesses').textContent.trim())
push({ kind: 'harnesses', harnesses: HARNESSES })
await settle()

await until(() => id('agent-cwd').value !== '', 10_000, 'the directory')
check('the daemon answers the directory question a plugin cannot',
  id('agent-cwd').value === '/Users/designer')
check('and its subdirectories are offered',
  [...id('agent-dirs').querySelectorAll('.chip')].map((chip) => chip.textContent).join(',') === 'work,checkout-app')

chips()[0].click()
await settle()
// The last one, not the first: browsing the filesystem stores a directory
// before a harness has been picked, and that write is also a save.
const lastStored = () => posted.filter((message) => message.type === 'save-agent-settings').pop()
check('picking a harness marks it', chips()[0].classList.contains('current'))
check('and stores the choice', lastStored()?.harness === 'claude', JSON.stringify(lastStored()))
check('and starting is now possible', id('agent-start').disabled === false)

check('the tool list is shown so the designer can see what was handed over',
  id('agent-tools').textContent.includes('figma_extract') &&
  id('agent-tools').textContent.includes('edits the file'))

// Back to the workspace: the session is started from the column, not the page.
window.dispatchEvent(Object.assign(new window.Event('keydown'), { key: 'Escape' }))
await settle()
check('leaving Setup returns to the workspace with the agent still open',
  id('agent-page').hidden === true && id('agent-column').hidden === false)
check('the strip says what will start', id('agent-session').textContent.includes('Claude Code'),
  id('agent-session').textContent)
check('and the chat waits to be started', id('agent-idle').hidden === false && id('agent-chat').hidden === true)

received.length = 0
id('agent-start').click()
await until(() => sawFrame('start') !== undefined, 5_000, 'the start')
check('starting names the harness and the directory',
  sawFrame('start').harness === 'claude' && sawFrame('start').cwd === '/Users/designer')

// -------------------------------------------------------------- the session

push({ kind: 'state', harness: { id: 'claude', name: 'Claude Code' }, sessionId: 's1', cwd: '/Users/designer', running: false, writes: false, auto: true, connected: true })
await settle()
check('a session reveals the chat', id('agent-chat').hidden === false && id('agent-idle').hidden === true)
check('and the strip names the session and its directory',
  id('agent-session').textContent === 'Claude Code · designer', id('agent-session').textContent)
check('and the start button becomes an end', id('agent-start').hidden === true && id('agent-stop').hidden === false)
check('the session id is stored, so a torn-down runtime can resume', lastStored()?.sessionId === 's1')

// ---------------------------------------------------------------- context
//
// On by default: the whole reason to chat inside the plugin is that "this"
// means whatever is on the canvas.

check('with nothing selected there is nothing to attach',
  id('agent-context-label').textContent === 'Nothing selected' && id('agent-context-on').disabled === true)

send({
  type: 'selected',
  id: '21:10314',
  ids: ['21:10314'],
  rows: [{ id: '21:10314', name: 'Search-notyping', type: 'FRAME', width: 375, height: 812, childCount: 7 }],
})
await settle()
check('a selection is offered as context, already on',
  id('agent-context-label').textContent === 'Selection: Search-notyping' && id('agent-context-on').checked === true)

received.length = 0
id('agent-input').value = 'what does this say'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('the selection travels with the message',
  sawFrame('prompt')?.context?.rows?.[0]?.id === '21:10314', JSON.stringify(sawFrame('prompt')?.context))
check('and the transcript records what went with it',
  id('agent-log').textContent.includes('Search-notyping'))

received.length = 0
id('agent-context-on').click()
id('agent-input').value = 'and now without'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('turning it off sends the words alone', sawFrame('prompt')?.context === undefined)
id('agent-context-on').click()

// ------------------------------------------------------------------ asking

received.length = 0
id('agent-input').value = 'make the CTA match our button component'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('sending posts the prompt', sawFrame('prompt')?.text === 'make the CTA match our button component')
check('the composer is cleared', id('agent-input').value === '')
check('and what was asked is in the transcript', id('agent-log').textContent.includes('make the CTA match'))

push({ kind: 'turn', status: 'started' })
await settle()
check('the panel says it is working', id('agent-turn').textContent === 'Answering…')

// ---------------------------------------------------------------- streaming

chunk('agent_thought_chunk', 'looking at ')
chunk('agent_thought_chunk', 'the selection')
chunk('agent_message_chunk', 'The CTA ')
chunk('agent_message_chunk', 'is a frame.')
await settle()

const blocks = () => [...id('agent-log').querySelectorAll('.agent-block')]
const blockText = (className) => {
  const block = blocks().find((entry) => entry.classList.contains(className))
  return block?.querySelector('.agent-text')?.textContent ?? ''
}
check('chunks of one kind join into one paragraph', blockText('assistant') === 'The CTA is a frame.')
check('thinking is kept apart from the answer', blockText('thought') === 'looking at the selection')
check('and both are their own block', blocks().filter((block) => block.classList.contains('assistant')).length === 1)

// ---------------------------------------------------- a tool call, relayed

push({ kind: 'request', id: 'req-1', command: 'get_selection', params: {} })
await until(() => answered.includes('get_selection'), 5_000, 'the relayed command')
check('a tool call is relayed to the main thread', answered.includes('get_selection'))
await until(() => received.some((frame) => frame.kind === 'response' && frame.id === 'req-1'), 5_000, 'the answer')
const relayed = received.find((frame) => frame.kind === 'response' && frame.id === 'req-1')
check('and its answer goes back to the daemon', relayed.ok === true && relayed.data.rows[0].name === 'CTA')

update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'figma_get_selection', status: 'in_progress' })
await settle()
check('the tool call is shown while it runs', id('agent-log').textContent.includes('figma_get_selection'))
update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
await settle()
const tool = id('agent-log').querySelector('.agent-tool')
check('and updated in place rather than repeated',
  id('agent-log').querySelectorAll('.agent-tool').length === 1 && tool.classList.contains('completed'))

// --------------------------------------------------------------- permission

received.length = 0
push({
  kind: 'permission',
  id: 'perm-1',
  sessionId: 's1',
  toolCall: { toolCallId: 't2', title: 'set the fill to #1e88e5' },
  options: [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
})
await settle()
check('a permission request is put in front of the designer', id('agent-permission').hidden === false)
check('naming the action', id('agent-permission-title').textContent.includes('set the fill'))
const options = [...id('agent-permission-options').querySelectorAll('button')]
check('with both answers offered', options.map((option) => option.textContent).join(',') === 'Allow,Reject')

options[0].click()
await settle()
check('answering sends the chosen option', sawFrame('permission')?.optionId === 'yes')
check('and the prompt goes away', id('agent-permission').hidden === true)

// ------------------------------------------------------------------- writes

received.length = 0
id('agent-writes').click()
await settle()
check('the edit switch is the designer\'s, not the agent\'s', sawFrame('writes')?.on === true)
check('and is remembered rather than re-chosen every session',
  posted.filter((message) => message.type === 'save-agent-settings').pop()?.writes === true)

// Auto-approval is on by default: the gate that protects the canvas is the edit
// switch above, and being asked twice for one change helps nobody.
check('permissions are answered for you by default', id('agent-auto').checked === true)
received.length = 0
id('agent-auto').click()
await settle()
check('turning it off tells the daemon to ask again', sawFrame('auto')?.on === false)
check('and that is remembered too',
  posted.filter((message) => message.type === 'save-agent-settings').pop()?.auto === false)

// ---------------------------------------------------------------- finishing

push({ kind: 'turn', status: 'ended', stopReason: 'end_turn' })
await settle()
check('a finished turn clears the working line', id('agent-turn').textContent === '')

push({ kind: 'turn', status: 'started' })
await settle()
received.length = 0
id('agent-cancel').click()
await settle()
check('a running turn can be stopped', sawFrame('cancel') !== undefined)
push({ kind: 'turn', status: 'ended', stopReason: 'cancelled' })
await settle()
check('and says so', id('agent-turn').textContent === 'Stopped.')

push({ kind: 'notice', level: 'error', text: 'the harness exited' })
await settle()
check('a failure on the far side is shown, not swallowed',
  id('agent-log').textContent.includes('the harness exited'))

id('agent-toggle-page').click()
await settle()
check('the button gives the code column back',
  id('agent-column').hidden === true && id('code-tabs').hidden === false && id('editor').hidden === false)

wss.close()
http.close()
window.close()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
