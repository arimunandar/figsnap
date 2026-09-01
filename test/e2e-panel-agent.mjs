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
  { id: 'codex', name: 'Codex', command: 'npx codex', available: true, note: '' },
  { id: 'gemini', name: 'Gemini CLI', command: 'npx gemini', available: false, note: 'not installed' },
]

const received = []
const sockets = []
let panelSocket = null

const http = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const body =
    url.pathname === '/fs'
      ? (() => {
          // A real listing derives the parent from the path, and the picker
          // walks up as well as down.
          const path = url.searchParams.get('path') ?? '/Users/designer'
          const parts = path.split('/').filter((part) => part !== '')
          return {
            path,
            parent: parts.length > 1 ? `/${parts.slice(0, -1).join('/')}` : null,
            home: '/Users/designer',
            directories: ['work', 'checkout-app'],
            isProject: true,
          }
        })()
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

// The agent is why the panel is open, so it holds the third column from the
// start; the generated code is one click away on the same button.
check('the panel opens on the agent, not the code',
  workspace().hidden === false && id('agent-column').hidden === false &&
  id('code-tabs').hidden === true && id('editor').hidden === true)
check('the rest of the workspace stays put',
  workspace().hidden === false && id('tree-panel').hidden === false)
check('and the button offers the code', id('agent-toggle-page').textContent === 'Code')

id('agent-toggle-page').click()
await settle()
check('which it gives back on request',
  id('agent-column').hidden === true && id('code-tabs').hidden === false && id('editor').hidden === false)
id('agent-toggle-page').click()
await settle()

// A stored token means the daemon was paired before, so the panel dials on its
// own rather than waiting for a click.
await until(() => panelSocket !== null, 10_000, 'the socket')
await until(() => sawFrame('hello') !== undefined, 10_000, 'the greeting')
check('a stored token connects without being asked', sawFrame('hello') !== undefined)
check('and the remembered auto setting goes over with the greeting', sawFrame('auto')?.on === true)
// The Edits gate lives in the daemon — one gate for the panel and for any MCP
// client — and `figsnap-agent --allow-edits` can seed it on. A panel that
// announced its own stored value on connect would silently turn off a flag the
// person at the terminal had just turned on.
check('but writes is not pushed: the daemon owns that switch',
  sawFrame('writes') === undefined, JSON.stringify(sawFrame('writes')))
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

// Setup and End sit behind one control, so the switch that matters is not one
// of four things competing in a 26px strip.
id('agent-more').click()
await settle()
check('the session menu opens', id('agent-more-menu').hidden === false)
// Nothing to end yet, so the menu does not offer it.
check('and offers nothing that cannot happen yet', id('agent-stop').hidden === true)
id('agent-setup-link').click()
await settle()
check('Setup opens the pairing page', id('agent-page').hidden === false)
check('and the menu closes behind it', id('agent-more-menu').hidden === true)

push({ kind: 'harnesses', harnesses: HARNESSES })
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: false, auto: true, connected: true })
await settle()

// The other half of the same rule: what the daemon says about writes is what
// the pill shows, whether that came from --allow-edits or from another panel.
check('the pill follows the daemon while it says off',
  id('agent-writes').getAttribute('aria-pressed') === 'false')
posted.length = 0
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: true, auto: true, connected: true })
await settle()
check('a daemon that was started with edits allowed turns the pill on, unasked',
  id('agent-writes').getAttribute('aria-pressed') === 'true')
check('and the panel remembers what it adopted rather than arguing with it',
  posted.filter((message) => message.type === 'save-agent-settings').pop()?.writes === true)
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: false, auto: true, connected: true })
await settle()
check('and off again when it is turned off elsewhere',
  id('agent-writes').getAttribute('aria-pressed') === 'false')

const harnessChips = () => [...id('agent-harnesses').querySelectorAll('.chip')]
check('the harness picker lists what the daemon found', harnessChips().length === 3, harnessChips().map((chip) => chip.textContent).join(' | '))
check('one that is not installed cannot be picked',
  harnessChips()[2].disabled === true && harnessChips()[2].textContent.includes('not installed'))
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

harnessChips()[0].click()
await settle()
// The last one, not the first: browsing the filesystem stores a directory
// before a harness has been picked, and that write is also a save.
const lastStored = () => posted.filter((message) => message.type === 'save-agent-settings').pop()
check('picking a harness marks it', harnessChips()[0].classList.contains('current'))
check('and stores the choice', lastStored()?.harness === 'claude', JSON.stringify(lastStored()))
check('and starting is now possible', id('agent-start').disabled === false)

check('the tool list is shown so the designer can see what was handed over',
  id('agent-tools').textContent.includes('figma_extract') &&
  id('agent-tools').textContent.includes('edits the file'))

// The empty state is the launcher: what will happen, the button, and the
// conversations that could be picked up instead of starting a new one.
push({
  kind: 'sessions',
  sessions: Array.from({ length: 7 }, (unused, index) => ({
    id: `past-${index}`,
    harness: 'claude',
    harnessName: 'Claude Code',
    cwd: '/Users/designer/work',
    file: 'Bonds',
    title: `an earlier question ${index}`,
    updatedAt: Date.now() - index * 60_000,
  })),
})
await settle()
const idleRows = () => [...id('agent-idle-list').querySelectorAll('.history-row')]
check('the empty state offers the recent conversations', idleRows().length === 5, String(idleRows().length))
check('five of them, not all seven', id('agent-idle-recent').hidden === false)
check('and says what pressing Start will do',
  id('agent-idle-title').textContent === 'Claude Code is ready' &&
  id('agent-idle-lead').textContent.includes('work'),
  `${id('agent-idle-title').textContent} / ${id('agent-idle-lead').textContent}`)
check('with Start in the middle rather than the strip',
  id('agent-idle').contains(id('agent-start')))

received.length = 0
idleRows()[1].querySelector('.history-open').click()
await settle()
check('and one of them can be opened from there',
  sawFrame('start')?.resume === 'past-1', JSON.stringify(sawFrame('start')))

push({ kind: 'sessions', sessions: [] })
await settle()
check('with nothing to pick up, nothing is offered', id('agent-idle-recent').hidden === true)

// Opening one above moved the folder; put it back for what follows.
push({ kind: 'state', harness: null, sessionId: null, cwd: '/Users/designer', running: false, writes: false, auto: true, connected: true })
await settle()

// Back to the workspace: the session is started from the column, not the page.
window.dispatchEvent(Object.assign(new window.Event('keydown'), { key: 'Escape' }))
await settle()
check('leaving Setup returns to the workspace with the agent still open',
  id('agent-page').hidden === true && id('agent-column').hidden === false)
// The strip names the folder, because that is the thing it is also a button for.
check('the strip names the folder that will be worked in',
  id('agent-session').textContent === 'Ready · designer', id('agent-session').textContent)
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
check('and the start button gives way to End', id('agent-start').hidden === true && id('agent-stop').hidden === false)
check('the session id is stored, so a torn-down runtime can resume', lastStored()?.sessionId === 's1')

// ---------------------------------------------------------------- context
//
// On by default: the whole reason to chat inside the plugin is that "this"
// means whatever is on the canvas.

// Ending the turn is what closes an answer off, so a suite that wants a clean
// transcript ends one rather than reaching into the DOM behind the panel.
// Clicking the panel's own body is how a menu is dismissed.
const closeAllMenus = () => window.document.body.click()

const agentClear = async () => {
  push({ kind: 'turn', status: 'ended', stopReason: 'end_turn' })
  await settle()
  id('agent-log').textContent = ''
}
const chips = () => [...id('agent-context-chips').querySelectorAll('.context-chip')]
// The + offers both things it could mean; adding the selection is the first.
const addSelection = async () => {
  id('agent-context-add').click()
  await settle()
  id('agent-attach-menu').querySelectorAll('.command')[0].click()
  await settle()
}
const chipNames = () => chips().map((chip) => chip.querySelector('.name').textContent)
const select = (...rows) =>
  send({ type: 'selected', id: rows[0]?.id ?? null, ids: rows.map((row) => row.id), rows })

const search = { id: '21:10314', name: 'Search-notyping', type: 'FRAME', width: 375, height: 812, childCount: 7 }
const sheet = { id: '21:20000', name: 'Bottomsheet Add to WG', type: 'FRAME', width: 375, height: 300, childCount: 3 }
const button = { id: '21:30000', name: 'Done button', type: 'INSTANCE', width: 160, height: 44, childCount: 1 }

check('with nothing selected there is nothing to attach',
  chips().length === 0 && id('agent-context-label').hidden === false &&
  id('agent-context-label').textContent === 'Nothing selected')

select(search)
await settle()
check('a selection becomes a chip on its own', chipNames().join() === 'Search-notyping', chipNames().join())
check('marked as following the canvas rather than pinned', chips()[0].classList.contains('live'))

// Following means replaced, not appended: clicking around the canvas must not
// pile up a dozen chips.
select(sheet)
await settle()
check('selecting something else replaces it', chipNames().join() === 'Bottomsheet Add to WG', chipNames().join())

received.length = 0
id('agent-input').value = 'what does this say'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('the selection travels with the message',
  sawFrame('prompt')?.context?.rows?.[0]?.id === '21:20000', JSON.stringify(sawFrame('prompt')?.context))
check('and the question is in the transcript, on its own side',
  id('agent-log').querySelector('.turn-user')?.textContent.includes('what does this say') === true)

// "Make B match A" needs two nodes, and only one of them can be selected.
await addSelection()
check('adding pins what was following', chips()[0].classList.contains('live') === false)
select(button)
await settle()
check('and a pinned list stops following the canvas',
  chipNames().join() === 'Bottomsheet Add to WG', chipNames().join())

await addSelection()
check('so the second one is added rather than swapped in',
  chipNames().join() === 'Bottomsheet Add to WG,Done button', chipNames().join())

await addSelection()
check('adding the same layer twice changes nothing',
  chipNames().join() === 'Bottomsheet Add to WG,Done button', chipNames().join())

received.length = 0
id('agent-input').value = 'make the button match the sheet'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('both travel with the message',
  sawFrame('prompt')?.context?.rows?.map((row) => row.id).join() === '21:20000,21:30000',
  JSON.stringify(sawFrame('prompt')?.context?.rows?.map((row) => row.id)))
check('and they survive the message they were sent with', chips().length === 2)

chips()[0].querySelector('.drop').click()
await settle()
check('a chip can be dropped', chipNames().join() === 'Done button', chipNames().join())

// An empty list is a decision, not a gap: it stays empty and sends nothing.
received.length = 0
chips()[0].querySelector('.drop').click()
await settle()
check('dropping the last one leaves no context',
  chips().length === 0 && id('agent-context-label').textContent === 'No context')
id('agent-input').value = 'and now without'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('so the words go alone', sawFrame('prompt')?.context === undefined)

id('agent-context-follow').click()
await settle()
check('and following can be resumed', chips()[0]?.classList.contains('live') === true, chipNames().join())

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
check('the panel says it is working', id('agent-turn').textContent === 'Working')

// ----------------------------------------------------------------- markdown
//
// An agent answers in Markdown. Rendering it as text is a wall of asterisks.

chunk('agent_message_chunk', '## Findings\n\nThe **CTA** uses `--Spacing-Large`.\n\n- 78 lines\n- 399 lines\n\n```css\n.a { color: red }\n```\n')
await settle()
const answer = () => id('agent-log').querySelector('.turn-agent')
check('headings are set as headings', answer()?.querySelector('.md-heading')?.textContent === 'Findings')
check('emphasis and code spans become real elements',
  answer()?.querySelector('strong')?.textContent === 'CTA' &&
  answer()?.querySelector('code')?.textContent === '--Spacing-Large')
check('bullets become a list', answer()?.querySelectorAll('.md-list li').length === 2)
check('and a fenced block becomes a code block',
  answer()?.querySelector('.md-code code')?.textContent.includes('color: red') === true)
check('labelled with what it is', answer()?.querySelector('.md-code-language')?.textContent === 'CSS')

// A snippet nobody can take away is a screenshot of a snippet.
const copyButton = () => answer()?.querySelector('.md-copy')
let copiedText = null
window.navigator.clipboard = { writeText: async (text) => { copiedText = text } }
copyButton().click()
await settle()
check('and it can be taken away', copiedText?.includes('.a { color: red }') === true, String(copiedText))
check('with the button saying so', copyButton().textContent === 'Copied')
check('with none of the markers left in the text',
  answer()?.textContent.includes('**') === false && answer()?.textContent.includes('##') === false)

// A half-arrived fence still renders, because a stream is read as it lands.
await agentClear()
chunk('agent_message_chunk', 'Here:\n\n```ts\nconst a = 1')
await settle()
check('an unclosed fence still renders while it streams',
  id('agent-log').querySelector('.md-code') !== null)

await agentClear()

// ------------------------------------------------------------------ base64
//
// A model handed an image sometimes writes it back out, and an adapter that
// stringifies a tool result inlines the whole thing. Either way it is tens of
// kilobytes of noise in a 400px column.

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const bulk = `${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5eg'.repeat(12)}==`

chunk('agent_message_chunk', `Here it is: ${bulk} — done.`)
await settle()
check('a wall of base64 is folded away, not printed',
  /\[\d+ kB of base64\]/.test(answer()?.textContent ?? '') && !(answer()?.textContent ?? '').includes(bulk),
  (answer()?.textContent ?? '').slice(0, 80))

await agentClear()
chunk('agent_message_chunk', `![the frame](data:image/png;base64,${PIXEL})`)
await settle()
check('a picture written as Markdown is shown as one',
  answer()?.querySelector('.md-image')?.getAttribute('src')?.startsWith('data:image/png') === true)

await agentClear()
update({
  sessionUpdate: 'tool_call',
  toolCallId: 'shot',
  title: 'figma_export_png',
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text: `data:image/png;base64,${PIXEL}` } }],
})
await settle()
check('and so is one an adapter stringified into a tool result',
  id('agent-log').querySelector('.tool-content img') !== null)

await agentClear()

// ---------------------------------------------------------------- streaming

chunk('agent_thought_chunk', 'looking at ')
chunk('agent_thought_chunk', 'the selection')
chunk('agent_message_chunk', 'The CTA ')
chunk('agent_message_chunk', 'is a frame.')
await settle()

const said = () => [...id('agent-log').querySelectorAll('.turn-agent')].map((node) => node.textContent)
const thought = () => [...id('agent-log').querySelectorAll('.activity-thought')].map((node) => node.textContent)
check('chunks of one kind join into one paragraph', said().join('|') === 'The CTA is a frame.', said().join('|'))
check('thinking is folded into the activity line, not the answer',
  thought().join('|') === 'looking at the selection', thought().join('|'))
// The answer arriving is what ends a stretch of work, so by now it has named
// how long it took and folded itself away.
const activity = () => id('agent-log').querySelector('.activity')
check('the activity folds itself away once the answer starts',
  activity()?.dataset.running === 'false' && activity()?.dataset.open === 'false',
  `${activity()?.dataset.running}/${activity()?.dataset.open}`)
check('and says how long it took',
  /^(Worked|Thought) for \d+s$/.test(activity()?.querySelector('.activity-summary span')?.textContent ?? ''),
  activity()?.querySelector('.activity-summary span')?.textContent)
activity().querySelector('.activity-summary').click()
await settle()
check('but it opens again when asked', activity()?.dataset.open === 'true')

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
const tool = id('agent-log').querySelector('.tool')
check('and updated in place rather than repeated',
  id('agent-log').querySelectorAll('.tool').length === 1 && tool.classList.contains('completed'))

// -------------------------------------------------------------------- queue
//
// Typing while the agent is still answering is the normal way to use a chat.

push({ kind: 'turn', status: 'started' })
await settle()
received.length = 0
id('agent-input').value = 'and another thing'
id('agent-composer').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('a message sent mid-turn is not sent yet', sawFrame('prompt') === undefined)
check('but it is on screen, marked as waiting',
  id('agent-log').querySelector('.turn-user.queued')?.textContent.includes('and another thing') === true)
check('and the panel says how many are waiting',
  id('agent-turn').textContent === 'Working · 1 queued', id('agent-turn').textContent)

push({ kind: 'turn', status: 'ended', stopReason: 'end_turn' })
await settle()
check('the finished turn releases it', sawFrame('prompt')?.text === 'and another thing')
check('and it stops looking like it is waiting',
  id('agent-log').querySelector('.turn-user.queued') === null)

// ------------------------------------------------------------ folder picker
//
// Choosing the project is done from the chat, not from a settings page.

id('agent-session').click()
await settle()
check('the folder picker opens from the strip', id('agent-folder-menu').hidden === false)
check('showing where it is looking', id('agent-folder-path').textContent === '/Users/designer')
const folders = () => [...id('agent-folder-list').querySelectorAll('.folder-row')]
check('and what is inside', folders().map((row) => row.textContent.replace('›', '')).join() === 'work,checkout-app')

folders()[0].click()
await settle()
check('a folder can be walked into', id('agent-folder-path').textContent === '/Users/designer/work')

// A path is identified by its end, and CSS can only trim the other one.
folders()[0].click()
await settle()
check('a deep path is trimmed from the front, not the end',
  id('agent-folder-path').textContent === '…/designer/work/work', id('agent-folder-path').textContent)
check('with the whole of it still available', id('agent-folder-path').title === '/Users/designer/work/work')
id('agent-folder-up').click()
await settle()
// A live session carries the directory it opened with, so moving it is a restart
// and the button has to say so rather than quietly doing nothing.
check('and the button says what choosing it costs',
  id('agent-folder-use').textContent.includes('restarts the session'), id('agent-folder-use').textContent)

received.length = 0
id('agent-folder-use').click()
await settle()
check('choosing one starts the session there',
  sawFrame('start')?.cwd === '/Users/designer/work', JSON.stringify(sawFrame('start')))
check('without resuming the conversation that belonged to the old folder',
  sawFrame('start')?.resume === '')
check('and the picker closes', id('agent-folder-menu').hidden === true)

push({
  kind: 'state',
  harness: { id: 'claude', name: 'Claude Code' },
  sessionId: 's2',
  cwd: '/Users/designer/work',
  running: false,
  writes: false,
  auto: true,
  connected: true,
})
await settle()
check('the strip follows it', id('agent-session').textContent === 'Claude Code · work', id('agent-session').textContent)

// ------------------------------------------------------------------ history

// Fixed timestamps: two pushes of this have to be indistinguishable, which is
// the whole point of the rebuild guard below.
const PAST = [
  { id: 's2', harness: 'claude', harnessName: 'Claude Code', cwd: '/Users/designer/work',
    file: 'Bonds', title: 'make the CTA match our button', updatedAt: 1788250000000 },
  { id: 'old', harness: 'codex', harnessName: 'Codex', cwd: '/Users/designer/checkout-app',
    file: 'Checkout', title: 'write the sheet as a component', updatedAt: 1788150000000 },
]

push({
  kind: 'sessions',
  sessions: [
    { id: 's2', harness: 'claude', harnessName: 'Claude Code', cwd: '/Users/designer/work',
      file: 'Bonds', title: 'make the CTA match our button', updatedAt: Date.now() - 3 * 60_000 },
    { id: 'old', harness: 'codex', harnessName: 'Codex', cwd: '/Users/designer/checkout-app',
      file: 'Checkout', title: 'write the sheet as a component', updatedAt: Date.now() - 26 * 3_600_000 },
  ],
})
await settle()

id('agent-more').click()
await settle()
id('agent-history-open').click()
await settle()
const rows = () => [...id('agent-history-menu').querySelectorAll('.history-row')]
check('history lists what was said before', rows().length === 2)
check('titled by the question that started it',
  rows()[0].querySelector('.title').textContent === 'make the CTA match our button')
// A conversation belongs to a harness and a folder as much as to an id.
check('and says which harness and folder it belongs to',
  rows()[1].querySelector('.about').textContent === 'Codex · checkout-app · Checkout · yesterday',
  rows()[1].querySelector('.about').textContent)
check('the one in use is marked', rows()[0].classList.contains('current'))

// Which conversation is current is part of what the list shows, so ending one
// has to refresh it — from both sides, since either can be the slower.
received.length = 0
id('agent-more').click()
await settle()
id('agent-stop').click()
await settle()
check('ending a session asks for the list again',
  sawFrame('stop') !== undefined && sawFrame('sessions') !== undefined)

push({ kind: 'state', harness: null, sessionId: null, cwd: '/Users/designer/work', running: false, writes: false, auto: true, connected: true })
push({
  kind: 'sessions',
  sessions: [
    { id: 's2', harness: 'claude', harnessName: 'Claude Code', cwd: '/Users/designer/work',
      file: 'Bonds', title: 'make the CTA match our button', updatedAt: Date.now() - 60_000 },
  ],
})
await settle()
id('agent-more').click()
await settle()
id('agent-history-open').click()
await settle()
check('the conversation that just ended is still listed', rows().length === 1)
check('but no longer marked as the one in use', rows()[0].classList.contains('current') === false)

// Put a session back for what follows.
push({
  kind: 'state',
  harness: { id: 'claude', name: 'Claude Code' },
  sessionId: 's2',
  cwd: '/Users/designer/work',
  running: false,
  writes: false,
  auto: true,
  connected: true,
})
await settle()

// A harness that is no longer installed cannot reopen anything, and saying so
// on the row beats failing on the click — which is exactly what happened when a
// stale record outlived the harness that made it.
push({
  kind: 'sessions',
  sessions: [
    ...([{ id: 'ghost', harness: 'gone-harness', harnessName: 'Fake harness', cwd: '/Users/designer/work',
      file: null, title: 'from a harness that left', updatedAt: Date.now() - 60_000 }]),
  ],
})
await settle()
const ghost = () => id('agent-history-menu').querySelector('.history-row')
check('a conversation whose harness is gone cannot be opened',
  ghost().classList.contains('gone') && ghost().querySelector('.history-open').disabled === true)
check('and the row says why',
  ghost().querySelector('.about').textContent.startsWith('Fake harness is not installed'),
  ghost().querySelector('.about').textContent)
check('but it can still be forgotten', ghost().querySelector('.drop') !== null)

push({ kind: 'sessions', sessions: PAST })
await settle()

// An unchanged list arriving while the menu is open must not replace the rows:
// a row swapped out mid-click is a detached node whose handler never fires,
// which reads as a click that did nothing. Opening the menu asks for the list,
// so the same answer coming back a moment later is the common case.
const firstRow = rows()[0]
push({ kind: 'sessions', sessions: PAST })
await settle()
check('the same list twice leaves the rows where they were', rows()[0] === firstRow)

received.length = 0
rows()[1].querySelector('.history-open').click()
await settle()
check('opening an old one relaunches its harness, in its folder',
  sawFrame('start')?.harness === 'codex' && sawFrame('start')?.cwd === '/Users/designer/checkout-app',
  JSON.stringify(sawFrame('start')))
check('asking the harness to replay rather than start over', sawFrame('start')?.resume === 'old')
check('and the menu closes', id('agent-history-menu').hidden === true)

// The order the daemon really sends in: the session it was on goes away, the
// harness replays, and only then does the new session announce itself. The
// panel used to clear on that last frame, which wiped the replay it had just
// been given — the whole point of picking a conversation off the list.
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: false, auto: true, connected: true })
await settle()
chunk('user_message_chunk', 'write the sheet as a component')
chunk('agent_message_chunk', 'Here is what I wrote last time.')
await settle()
push({
  kind: 'state',
  harness: { id: 'codex', name: 'Codex' },
  sessionId: 'old',
  cwd: '/Users/designer/checkout-app',
  running: false,
  writes: false,
  auto: true,
  connected: true,
})
await settle()
check('the replayed conversation survives the session announcing itself',
  id('agent-log').textContent.includes('Here is what I wrote last time'),
  id('agent-log').textContent.slice(0, 80))
check('including what was asked the first time',
  id('agent-log').querySelector('.turn-user')?.textContent.includes('write the sheet') === true)

await agentClear()

id('agent-more').click()
await settle()
id('agent-history-open').click()
await settle()
received.length = 0
rows()[0].querySelector('.drop').click()
await settle()
check('one can be forgotten from the list', sawFrame('forget')?.id === 's2')
closeAllMenus()
await settle()

// ------------------------------------------------------------- modes, files

push({
  kind: 'state',
  harness: { id: 'claude', name: 'Claude Code' },
  sessionId: 's1',
  cwd: '/Users/designer',
  running: false,
  writes: false,
  auto: true,
  acceptsImages: true,
  acceptsFiles: false,
  modes: {
    currentModeId: 'ask',
    availableModes: [
      { id: 'ask', name: 'Ask first' },
      { id: 'go', name: 'Full access' },
    ],
  },
  commands: [
    { name: 'review', description: 'Review the current diff' },
    { name: 'test', description: 'Run the test suite' },
  ],
  connected: true,
})
await settle()
// A mode name runs long — "Bypass Permissions" — and a native select clips it
// mid-word with no way to say so. A button ellipsises; the menu spells it out.
check('the harness’s own mode is shown', id('agent-mode').hidden === false)
check('by name, not by id',
  id('agent-mode').querySelector('.label').textContent === 'Ask first',
  id('agent-mode').textContent)
// Two controls for one question is one too many, and the harness's is better.
id('agent-mode').click()
await settle()
const modeRows = () => [...id('agent-mode-menu').querySelectorAll('.command')]
check('the menu lists every mode', modeRows().length === 2)
check('marking the one in use', modeRows()[0].classList.contains('current'))

received.length = 0
modeRows()[1].click()
await settle()
check('choosing another tells the harness', sawFrame('mode')?.modeId === 'go')
check('and the menu closes', id('agent-mode-menu').hidden === true)

// Commands are the harness's, published over ACP; a slash is where anyone looks.
id('agent-input').value = '/re'
id('agent-input').dispatchEvent(new window.Event('input', { bubbles: true }))
await settle()
const commands = () => [...id('agent-commands').querySelectorAll('.command')]
check('a slash offers the commands the harness published',
  id('agent-commands').hidden === false && commands().length === 1, String(commands().length))
check('matched on what was typed', commands()[0].textContent.includes('/review'))
commands()[0].click()
await settle()
check('picking one fills the box', id('agent-input').value === '/review ')
id('agent-input').value = ''
id('agent-input').dispatchEvent(new window.Event('input', { bubbles: true }))
await settle()

id('agent-context-add').click()
await settle()
const attachRows = [...id('agent-attach-menu').querySelectorAll('.command')]
check('the + offers both things it could mean', attachRows.length === 2)
// This harness reads images but not embedded resources, which is still enough
// to attach something; a harness that reads neither is the one that refuses.
check('and attaching is offered while the harness reads anything',
  attachRows[1].disabled === false, attachRows[1].title)
id('agent-context-add').click()
await settle()

// ------------------------------------------------------- tool call evidence

await agentClear()
update({ sessionUpdate: 'tool_call', toolCallId: 'ev', title: 'Write src/app.css', kind: 'edit', status: 'in_progress' })
await settle()
check('a call that can change things is marked',
  id('agent-log').querySelector('.tool.writes') !== null)
update({
  sessionUpdate: 'tool_call_update',
  toolCallId: 'ev',
  status: 'completed',
  content: [{ type: 'diff', path: 'src/app.css', oldText: '.a { color: red }', newText: '.a { color: blue }' }],
})
await settle()
check('and the diff it wrote is shown, not just claimed',
  id('agent-log').querySelector('.tool-content .diff-line.add')?.textContent.includes('color: blue') === true)
check('with what it replaced beside it',
  id('agent-log').querySelector('.tool-content .diff-line.del')?.textContent.includes('color: red') === true)

update({
  sessionUpdate: 'tool_call',
  toolCallId: 'sh',
  title: 'Ran echo',
  status: 'completed',
  content: [{ type: 'terminal', terminalId: 't', _figsnap: { output: 'from the terminal\n', exitStatus: { exitCode: 0 } } }],
})
await settle()
check('a terminal shows what it printed and how it ended',
  id('agent-log').textContent.includes('from the terminal') &&
  id('agent-log').querySelector('.tool-content .foot.ok') !== null)

await agentClear()

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

check('with a way to stop being asked, on the thing that is asking',
  id('agent-permission-always').hidden === false)

options[0].click()
await settle()
check('answering sends the chosen option', sawFrame('permission')?.optionId === 'yes')
check('and the prompt goes away', id('agent-permission').hidden === true)

// A harness that offers its own standing allow is not given a second one.
push({
  kind: 'permission',
  id: 'perm-2',
  sessionId: 's1',
  toolCall: { toolCallId: 't3', title: 'write a file' },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ],
})
await settle()
check('and stands aside when the harness has its own always',
  id('agent-permission-always').hidden === true)
received.length = 0
;[...id('agent-permission-options').querySelectorAll('button')][2].click()
await settle()

// ------------------------------------------------------------------- writes

received.length = 0
id('agent-writes').click()
await settle()
check('the edit switch is the designer\'s, not the agent\'s', sawFrame('writes')?.on === true)
check('and it shows as on', id('agent-writes').getAttribute('aria-pressed') === 'true')
check('and is remembered rather than re-chosen every session',
  posted.filter((message) => message.type === 'save-agent-settings').pop()?.writes === true)

// There is no Auto switch in the chrome: a control that only decides whether a
// prompt appears belongs on the prompt, and the way back on the line that says
// it happened.
check('the header carries no speculative auto switch', id('agent-auto') === null)

push({ kind: 'notice', level: 'auto', text: 'Allowed automatically: set the fill' })
await settle()
const autoLine = () => [...id('agent-log').querySelectorAll('.event.auto')].pop()
check('an automatic approval is on the record', autoLine()?.textContent.includes('set the fill') === true)
received.length = 0
autoLine().querySelector('.undo').click()
await settle()
check('and offers the way back from there', sawFrame('auto')?.on === false)
check('which is remembered',
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
check('and says so', id('agent-turn').textContent === 'Stopped')

push({ kind: 'notice', level: 'error', text: 'the harness exited' })
await settle()
check('a failure on the far side is shown, not swallowed',
  id('agent-log').textContent.includes('the harness exited'))

// An error explaining why a session did not start has to be visible, and with
// no session the transcript was hidden — so the answer sat behind the question.
await agentClear()
push({ kind: 'state', harness: null, sessionId: null, cwd: '', running: false, writes: false, auto: true, connected: true })
await settle()
check('with no session the chat is out of the way', id('agent-chat').hidden === true)
push({ kind: 'notice', level: 'error', text: 'No such harness: gone-harness' })
await settle()
check('but a failure brings the transcript out to say so',
  id('agent-chat').hidden === false && id('agent-log').textContent.includes('No such harness'),
  String(id('agent-chat').hidden))
await agentClear()

id('agent-toggle-page').click()
await settle()
check('the button still gives the code column back',
  id('agent-column').hidden === true && id('code-tabs').hidden === false && id('editor').hidden === false)

wss.close()
http.close()
window.close()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
