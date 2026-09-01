// The plugin panel signing itself in, end to end.
//
// The panel's own dist/ui.html runs in jsdom against a real hosted relay in
// workerd, with a stand-in for the main thread that speaks the same messages
// figma.ui does. Nothing about the flow is reimplemented here: the form, the
// state machine, the socket and the HTTP calls are the shipped ones, so this
// fails if the gate stops opening, stops connecting, or stops resuming.

import { allEndpoints } from '../shared/endpoints.mjs'
import { requireRelay } from './support/relay.mjs'
import { openPanel as open, until } from './support/panel.mjs'

const BASE = requireRelay('the panel flow')
const SOCKET = `${BASE.replace(/^http/, 'ws')}/plugin`
// Nothing listens here: a relay address that is wrong or a machine that is offline.
const NOTHING = 'ws://localhost:3059/plugin'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const unique = Date.now()

// A real extraction is thousands of characters of generated code, which is what
// the API browser has to summarise rather than dump.
const LONG_TSX = `export function Panel() {\n${'  // a generated line\n'.repeat(80)}}`

function answer(command) {
  if (command === 'get_tree') return { page: 'Panel page', rows: [], truncated: false }
  if (command === 'get_selection') return { page: 'Panel page', rows: [] }
  if (command === 'extract') {
    return {
      id: '1:1', name: 'Panel', nodeType: 'FRAME', width: 375, height: 420,
      layerCount: 3, truncated: false,
      tsx: LONG_TSX, moduleCss: '.a{}', css: '.a{}', figmaCss: '/* a */',
      png: 'iVBORw0KGgo=',
    }
  }
  return { ok: true }
}

/**
 * Opens the panel with a given set of stored settings and answers it the way
 * the main thread would. The stand-in is deliberately thin: storage, the three
 * settings messages, and enough commands for one real request to come back
 * through the relay.
 */
async function openPanel(stored) {
  const settings = { url: '', token: '', email: '', profiles: [], ...stored }
  const seen = []
  const applied = []

  const panel = await open({
    settings,
    // Node's real fetch and WebSocket, against the relay under test: nothing
    // about the flow is reimplemented here.
    online: true,
    onMessage(message, api) {
      switch (message.type) {
        case 'save-settings':
          settings.url = message.url
          settings.token = message.token
          settings.email = message.email ?? ''
          api.send({ type: 'settings', ...settings })
          break
        case 'sign-out':
          settings.token = ''
          settings.email = ''
          api.send({ type: 'settings', ...settings })
          break
        case 'sync-apply':
          applied.push(message)
          break
        case 'req':
          seen.push(message.command)
          api.send({ type: 'res', id: message.id, ok: true, data: answer(message.command) })
          break
        default:
          break
      }
    },
  })

  return {
    ...panel,
    settings,
    seen,
    applied,
    submit: () =>
      panel
        .id('auth-form')
        .dispatchEvent(new panel.window.Event('submit', { bubbles: true, cancelable: true })),
  }
}

// ------------------------------------------------------ opening with no session

const gate = await openPanel({ url: SOCKET })
check('the panel opens on the gate, not the workspace',
  gate.id('auth-page').hidden === false && gate.workspace().hidden === true)
check('the top bar is out of the way while the gate is shut', gate.id('topbar').hidden === true)

await until(() => gate.id('auth-form').hidden === false, 10_000, 'the form')
check('the form appears once the relay says it has accounts',
  gate.id('auth-form').hidden === false && gate.id('auth-boot').hidden === true)
check('sign in is the default, with create account beside it',
  gate.id('auth-submit').textContent === 'Sign in' &&
  gate.id('auth-tabs').textContent.includes('Create account'))

// A wrong password stays on the form and says why, rather than looking unreachable.
gate.id('auth-email').value = `nobody-${unique}@example.com`
gate.id('auth-password').value = 'not an account here'
gate.submit()
await until(() => gate.id('auth-message').textContent.includes('Wrong email or password'), 10_000, 'the refusal')
check('a refusal is shown on the form', gate.workspace().hidden === true && gate.settings.token === '')

// Creating the account, from the panel, against the relay under test.
const account = { email: `panel-${unique}@example.com`, password: 'typed into the panel' }
gate.id('auth-tabs').querySelector('[data-auth="register"]').click()
check('the create-account tab relabels the button', gate.id('auth-submit').textContent === 'Create account')
check('it asks a password manager to save, not to fill',
  gate.id('auth-password').getAttribute('autocomplete') === 'new-password')

gate.id('auth-email').value = account.email
gate.id('auth-password').value = 'short'
gate.submit()
await until(() => gate.id('auth-message').textContent.includes('at least 10'), 5_000, 'the length check')
check('a short password never leaves the panel', gate.settings.token === '')

gate.id('auth-password').value = account.password
gate.submit()

// One sign-in, then everything else without another click.
await until(() => gate.workspace().hidden === false, 30_000, 'the workspace')
check('creating an account stores a token', typeof gate.settings.token === 'string' && gate.settings.token.length === 48)
check('the account is remembered by email', gate.settings.email === account.email.toLowerCase())
check('the password is not left in the field', gate.id('auth-password').value === '')
check('the socket came up on its own', gate.id('relay-dot').className === 'dot open')
check('all three steps are ticked off',
  gate.id('auth-steps').querySelectorAll('li.done').length === 3,
  gate.id('auth-steps').textContent)
check('the panel says it is ready', gate.id('status').textContent.startsWith('Ready.'), gate.id('status').textContent)

const token = gate.settings.token
const health = await (await fetch(`${BASE}/health`, { headers: { 'x-relay-token': token } })).json()
check('the relay sees the panel in that account\'s room', health.pluginConnected === true)
check('and names the account', health.signedIn === account.email.toLowerCase(), health.signedIn)

// One real request, all the way through the shipped panel code.
const tree = await fetch(`${BASE}/tree`, { headers: { 'x-relay-token': token } })
const treeBody = await tree.json()
check('the API reaches the plugin through the panel', tree.status === 200 && treeBody.page === 'Panel page')
check('the panel answered the command it was asked for', gate.seen.includes('get_tree'))

gate.window.close()

// ------------------------------------------------------- resuming that session

const resumed = await openPanel({ url: SOCKET, token, email: account.email })
await until(() => resumed.workspace().hidden === false, 10_000, 'the workspace')
check('a stored session skips the gate', resumed.id('auth-page').hidden === true)
await until(() => resumed.id('relay-dot').className === 'dot open', 20_000, 'the socket')
check('and reconnects without asking again', resumed.id('relay-dot').className === 'dot open')

const resumedHealth = await (await fetch(`${BASE}/health`, { headers: { 'x-relay-token': token } })).json()
check('the resumed session reaches the same room', resumedHealth.pluginConnected === true)

// The token has to be readable to be carried into a terminal or a CI secret.
resumed.id('relay-toggle-page').click()
check('the Relay page opens', resumed.id('relay-page').hidden === false)
check('the token is hidden by default', resumed.id('page-token').type === 'password')
check('and holds the real one', resumed.id('page-token').value === token)
resumed.id('page-token-show').click()
check('Show reveals it',
  resumed.id('page-token').type === 'text' && resumed.id('page-token-show').textContent === 'Hide')
resumed.id('page-token-show').click()
check('and hides it again', resumed.id('page-token').type === 'password')
check('copy is offered when there is something to copy', resumed.id('page-token-copy').disabled === false)

// ------------------------------------------------------------- api browser

// Counted from the catalogue, so adding an endpoint does not fail the test for
// the wrong reason — only failing to render one does.
const catalogue = allEndpoints()
const items = resumed.id('api-list').querySelectorAll('.api-item')
check('every endpoint is listed', items.length === catalogue.length, `${items.length} of ${catalogue.length}`)
check('methods and paths are shown',
  resumed.id('api-list').textContent.includes('/children/:id') &&
  resumed.id('api-list').textContent.includes('/assets/:nodeId@2x.png'))

const findRow = (path) =>
  [...resumed.id('api-list').querySelectorAll('.api-item')]
    .find((row) => row.querySelector('.api-path').textContent === path)

const treeRow = findRow('/tree')
check('a row starts collapsed', treeRow.querySelector('.api-panel').hidden === true)
treeRow.querySelector('.api-head').click()
check('and opens on click', treeRow.querySelector('.api-panel').hidden === false)
check('the curl line carries the real address and token',
  treeRow.querySelector('.doc-code').nextSibling !== null &&
  [...treeRow.querySelectorAll('.doc-code')].some((b) => b.textContent.includes(token) && b.textContent.includes(BASE)))

const treeSend = [...treeRow.querySelectorAll('button')].find((b) => b.textContent === 'Send')
treeSend.click()
await until(() => treeRow.querySelector('.api-state').textContent.startsWith('200'), 20_000, 'the response')
check('Send fires the real request',
  [...treeRow.querySelectorAll('.doc-code')].pop().textContent.includes('Panel page'))

// The extract row proves the body editor and the long-string summary.
const extractRow = findRow('/extract')
extractRow.querySelector('.api-head').click()
const bodyBox = extractRow.querySelector('.api-body-input')
check('POST rows get an editable body', bodyBox !== null && bodyBox.value === '{}')
const extractExamples = catalogue.find((endpoint) => endpoint.path === '/extract').body.examples.length
check('and example bodies to pick from',
  extractRow.querySelectorAll('.api-example').length === extractExamples,
  `${extractRow.querySelectorAll('.api-example').length} of ${extractExamples}`)
;[...extractRow.querySelectorAll('.api-example')].find((c) => c.textContent === 'One node').click()
check('an example fills the body', bodyBox.value.includes('"nodeId"'))
bodyBox.value = '{}'

const extractSend = [...extractRow.querySelectorAll('button')].find((b) => b.textContent === 'Send')
extractSend.click()
await until(() => extractRow.querySelector('.api-state').textContent.startsWith('200'), 25_000, 'the extraction')
const shown = [...extractRow.querySelectorAll('.doc-code')].pop().textContent
check('a long generated string is summarised, not dumped',
  /"tsx": "… \(\d+ chars\)"/.test(shown) && !shown.includes('a generated line'),
  shown.split('\n').find((line) => line.includes('tsx')))
check('the png reference survives', shown.includes('/assets/'))

// ------------------------------------------------------- syncing the set
//
// The saved set lives in clientStorage, which is per machine. The panel is what
// carries it to the account, so this drives the real loop against a real store.

const FILE = `panel-file-${unique}`
const shelf = () =>
  fetch(`${BASE}/library/${FILE}`, { headers: { 'x-relay-token': token } }).then((r) => r.json())

resumed.send({
  type: 'sync',
  fileId: FILE,
  folders: ['Checkout'],
  entries: [{ id: '1:1', name: 'Alpha', type: 'FRAME', addedAt: 1, folder: 'Checkout' }],
  updatedAt: 5000,
})
await until(async () => (await shelf()).known === true, 20_000, 'the set to reach the account')
const stored = await shelf()
check('the panel pushes the set to the account',
  stored.entries[0]?.name === 'Alpha' && stored.folders[0] === 'Checkout')
check('with the stamp it was given', stored.updatedAt === 5000)

// Now the other machine: a newer set arrives at the account directly.
await fetch(`${BASE}/library/${FILE}`, {
  method: 'PUT',
  headers: { 'content-type': 'application/json', 'x-relay-token': token },
  body: JSON.stringify({
    folders: ['Checkout', 'Onboarding'],
    entries: [{ id: '2:2', name: 'From the laptop', type: 'FRAME', addedAt: 2, folder: 'Onboarding' }],
    updatedAt: 9000,
  }),
})

resumed.applied.length = 0
resumed.send({
  type: 'sync',
  fileId: FILE,
  folders: ['Checkout'],
  entries: [{ id: '1:1', name: 'Alpha', type: 'FRAME', addedAt: 1, folder: 'Checkout' }],
  updatedAt: 5000,
})
await until(() => resumed.applied.length > 0, 20_000, 'the newer set to come back')
const pulled = resumed.applied[0]
check('a newer set on the account replaces this machine\'s',
  pulled.entries[0]?.name === 'From the laptop' && pulled.updatedAt === 9000)
check('folders come with it', pulled.folders.length === 2)
check('and the panel says so', resumed.id('toast').textContent.includes('synced'))

// An older local set must not clobber the newer one it just pulled.
resumed.send({ type: 'sync', fileId: FILE, folders: [], entries: [], updatedAt: 100 })
await new Promise((resolve) => setTimeout(resolve, 2500))
const untouched = await shelf()
check('a stale push does not overwrite the account',
  untouched.updatedAt === 9000 && untouched.entries.length === 1, `updatedAt ${untouched.updatedAt}`)

// Signing out revokes the token and the gate closes behind it.
resumed.id('page-signout').click()
// The gate opens synchronously; the stored token clears once the main thread has
// handled the message, so that is the thing to wait for.
await until(() => resumed.settings.token === '', 10_000, 'the token to be dropped')
check('signing out reopens the gate',
  resumed.id('auth-page').hidden === false && resumed.id('topbar').hidden === true)
await new Promise((resolve) => setTimeout(resolve, 500))
const afterSignOut = await fetch(`${BASE}/auth/me`, { headers: { 'x-relay-token': token } })
check('signing out revokes the token on the relay', afterSignOut.status === 401, `status ${afterSignOut.status}`)
resumed.window.close()

// --------------------------------------------------------- an expired session

const expired = await openPanel({ url: SOCKET, token: 'a token that no longer resolves', email: 'stale@example.com' })
await until(() => expired.id('auth-page').hidden === false && expired.id('auth-form').hidden === false, 20_000, 'the gate')
check('an expired session is sent back to the form',
  expired.id('auth-message').textContent.includes('expired'), expired.id('auth-message').textContent)
check('and the dead token is dropped, not retried', expired.settings.token === '')

expired.window.close()

// An unreachable relay is still a relay with accounts, so the gate is still the
// only sensible view — there is nothing behind it to show.
const unreachable = await openPanel({ url: NOTHING })
await until(() => unreachable.id('auth-form').hidden === false, 20_000, 'the form')
check('an unreachable relay still asks for an account',
  unreachable.id('auth-page').hidden === false && unreachable.workspace().hidden === true)
unreachable.id('auth-email').value = 'someone@example.test'
unreachable.id('auth-password').value = 'a password long enough'
unreachable.submit()
await until(() => unreachable.id('auth-message').textContent.includes('Could not reach'), 20_000, 'the failure')
check('and says it could not be reached, rather than blaming the password',
  unreachable.id('auth-message').textContent.includes('Could not reach'),
  unreachable.id('auth-message').textContent)
unreachable.window.close()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
