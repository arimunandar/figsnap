// The Saved pane's folder UI, in the shipped dist/ui.html.
//
// The panel's contract has two halves: what it renders from a `saved` message,
// and what it posts back when you use it. Both are asserted here against the
// real built panel — the store itself is covered by e2e-folders.mjs, which runs
// the real main thread.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const html = await readFile(join(root, 'dist/ui.html'), 'utf8')

const dom = new JSDOM(html, {
  url: 'https://www.figma.com/',
  runScripts: 'dangerously',
  beforeParse(window) {
    // Nothing here talks to a relay; a socket that never opens is fine.
    window.fetch = async () => { throw new Error('offline') }
    window.URL.createObjectURL = () => 'blob:figsnap/1'
    window.URL.revokeObjectURL = () => {}
    window.WebSocket = class {
      constructor() { this.readyState = 0 }
      addEventListener() {}
      close() {}
      send() {}
    }
  },
})
const { window } = dom
const id = (name) => window.document.getElementById(name)
const send = (message) => window.postMessage({ pluginMessage: message }, '*')

const posted = []
window.addEventListener('message', (event) => {
  const message = event.data?.pluginMessage
  if (!message || typeof message.type !== 'string') return
  if (message.type === 'ready') {
    // A local relay has no accounts, so the gate never appears.
    // A stored session, so the panel opens on the workspace rather than the
    // gate. The relay itself is unreachable here; nothing in this suite needs it.
    send({ type: 'settings', url: 'wss://relay.test/plugin', token: 'a stored token',
           email: 'you@example.test', profiles: [] })
    return
  }
  posted.push(message)
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 60))
await settle()
await settle()

const entry = (nodeId, name, folder) => ({ id: nodeId, name, type: 'FRAME', addedAt: 1, folder })

// A set with two folders and one loose entry.
send({
  type: 'saved',
  folders: [{ name: '', count: 1 }, { name: 'Checkout', count: 2 }, { name: 'Empty', count: 0 }],
  entries: [entry('1:3', 'Gamma', ''), entry('1:1', 'Alpha', 'Checkout'), entry('1:2', 'Beta', 'Checkout')],
})
await settle()

window.document.querySelector('[data-source="saved"]').click()
await settle()

// ------------------------------------------------------------------ chips

const chips = () => [...id('folder-chips').querySelectorAll('.folder-chip')]
check('a chip per folder, plus All', chips().length === 4, chips().map((c) => c.textContent).join(' | '))
check('All is the opening scope', chips()[0].classList.contains('current') && chips()[0].textContent.startsWith('All'))
// Asserted on the parts, not on the joined text: how they are spaced is layout.
const checkoutChip = chips().find((chip) => chip.textContent.startsWith('Checkout'))
check('chips carry counts', checkoutChip?.querySelector('.count')?.textContent === '2',
  checkoutChip?.textContent)
check('the root chip is named, not blank', chips().some((chip) => chip.textContent.startsWith('No folder')))

// --------------------------------------------------------------- grouping

const headings = () => [...id('saved-list').querySelectorAll('.folder-heading')].map((h) => h.textContent)
check('the All view groups under headings',
  headings().join(',') === 'No folder,Checkout', headings().join(','))
check('an empty folder gets no heading', !headings().includes('Empty'))
check('every entry is listed once', id('saved-list').querySelectorAll('.url-row').length === 3)

// ---------------------------------------------------------------- scoping

chips().find((chip) => chip.textContent.startsWith('Checkout')).click()
await settle()
check('picking a folder narrows the list', id('saved-list').querySelectorAll('.url-row').length === 2)
check('and drops the headings', headings().length === 0)
check('the count strip names the folder', id('saved-count').textContent === '2 in Checkout')
check('the primary button says what it will extract',
  id('primary-action').textContent === 'Extract 2 in Checkout', id('primary-action').textContent)
check('rename becomes available on a real folder', id('edit-folder').hidden === false)

chips().find((chip) => chip.textContent.startsWith('Empty')).click()
await settle()
check('an empty folder explains itself',
  id('saved-list').textContent.includes('Nothing in Empty yet'), id('saved-list').textContent.trim())

// -------------------------------------------------------- what it posts back

posted.length = 0
chips().find((chip) => chip.textContent.startsWith('Checkout')).click()
await settle()
id('primary-action').click()
await settle()
const batch = posted.find((message) => message.type === 'batch')
check('extracting a folder asks for that folder', batch?.source === 'saved' && batch?.folder === 'Checkout')

posted.length = 0
send({ type: 'selected', id: '9:9', ids: ['9:9'], rows: [{ id: '9:9', name: 'New', type: 'FRAME', width: 1, height: 1, childCount: 0 }] })
await settle()
check('the save button names the destination',
  id('save-selection').textContent === 'Save selection to Checkout', id('save-selection').textContent)
id('save-selection').click()
await settle()
check('saving lands in the folder on screen',
  posted.find((m) => m.type === 'save-selection')?.folder === 'Checkout')

posted.length = 0
id('clear-saved').click()
await settle()
check('clear empties only the folder on screen',
  posted.find((m) => m.type === 'clear-saved')?.folder === 'Checkout')
check('and says so', id('clear-saved').title === 'Empty Checkout')

// The move control is the only way to change where an entry lives.
posted.length = 0
const select = id('saved-list').querySelector('.row-folder')
check('each row offers every folder', select.options.length === 3)
select.value = ''
select.dispatchEvent(new window.Event('change', { bubbles: true }))
await settle()
const move = posted.find((message) => message.type === 'move-saved')
check('moving posts the entry and its destination', move?.folder === '' && move?.ids.length === 1)

// The node id is what an API call needs and it is nowhere on screen, so each row
// offers it. jsdom has no clipboard, so the failure path is what is observable.
const row = id('saved-list').querySelector('.url-row')
const copy = row.querySelector('.copy')
check('each saved row offers its node id', copy !== null && copy.title === 'Copy the node id')
copy.click()
await settle()
check('and copying reports the id either way',
  id('toast').hidden === false && id('toast').textContent.includes('1:1'),
  id('toast').textContent)

// ------------------------------------------------------------ folder form

posted.length = 0
id('new-folder').click()
check('the new-folder form opens inline, not in a prompt', id('folder-form').hidden === false)
check('and offers to create', id('folder-save').textContent === 'Create')
id('folder-name').value = 'Onboarding'
id('folder-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
check('creating posts the name', posted.find((m) => m.type === 'create-folder')?.name === 'Onboarding')
check('the form closes again', id('folder-form').hidden === true)

// Landing in the folder just made is what makes the next save go there.
send({
  type: 'saved',
  folders: [{ name: '', count: 1 }, { name: 'Checkout', count: 2 }, { name: 'Empty', count: 0 }, { name: 'Onboarding', count: 0 }],
  entries: [entry('1:3', 'Gamma', ''), entry('1:1', 'Alpha', 'Checkout'), entry('1:2', 'Beta', 'Checkout')],
})
await settle()
check('the new folder is the one showing', id('saved-count').textContent === '0 in Onboarding')

posted.length = 0
id('edit-folder').click()
check('the same form renames', id('folder-save').textContent === 'Rename' && id('folder-name').value === 'Onboarding')
check('and offers to delete', id('folder-delete').hidden === false)
id('folder-name').value = 'Onboarding v2'
id('folder-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
await settle()
const renamed = posted.find((message) => message.type === 'rename-folder')
check('renaming names both ends', renamed?.from === 'Onboarding' && renamed?.to === 'Onboarding v2')

posted.length = 0
id('edit-folder').click()
id('folder-delete').click()
await settle()
check('deleting posts the folder', posted.find((m) => m.type === 'delete-folder')?.name === 'Onboarding v2')

// A folder deleted elsewhere must not leave the pane pointing at nothing.
send({
  type: 'saved',
  folders: [{ name: '', count: 3 }, { name: 'Checkout', count: 0 }],
  entries: [entry('1:3', 'Gamma', ''), entry('1:1', 'Alpha', ''), entry('1:2', 'Beta', '')],
})
await settle()
check('a vanished folder falls back to All', id('saved-count').textContent === '3 saved', id('saved-count').textContent)

// One folder left and nothing in it: the chips are noise, so they go.
send({ type: 'saved', folders: [{ name: '', count: 1 }], entries: [entry('1:3', 'Gamma', '')] })
await settle()
check('with no folders the pane looks as it always did',
  chips().length === 0 && headings().length === 0 && id('saved-list').querySelector('.row-folder') === null)

window.close()
const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
