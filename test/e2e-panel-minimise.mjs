// Minimising the panel, in the shipped dist/ui.html.
//
// The point of minimising is a clear canvas, so what matters is that everything
// which covers it goes away, that the main thread is told to shrink the window,
// and that the plugin keeps working while it is out of the way.

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
    window.fetch = async () => { throw new Error('offline') }
    window.WebSocket = class { constructor() { this.readyState = 0 } addEventListener() {} close() {} send() {} }
    // jsdom implements no object URLs; a browser does, and the panel needs them
    // to show image bytes without a round trip.
    let issued = 0
    window.URL.createObjectURL = () => `blob:figsnap/${++issued}`
    window.URL.revokeObjectURL = () => {}
  },
})
const { window } = dom
const id = (name) => window.document.getElementById(name)
const send = (message) => window.postMessage({ pluginMessage: message }, '*')
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

const posted = []
window.addEventListener('message', (event) => {
  const message = event.data?.pluginMessage
  if (!message || typeof message.type !== 'string') return
  if (message.type === 'ready') {
    // A local relay needs no account, so the gate never appears.
    send({ type: 'settings', url: 'ws://localhost:3055/plugin', token: '', email: '', profiles: [] })
    return
  }
  posted.push(message)
})

await settle()
await settle()

const workspace = () => window.document.querySelector('.body')
check('the panel starts open', workspace().hidden === false && !window.document.body.classList.contains('mini'))
check('and offers a minimise button', id('minimise') !== null && id('minimise').textContent === '–')

// ---------------------------------------------------------------- minimise

posted.length = 0
id('minimise').click()
await settle()

check('minimising tells the main thread to shrink the window',
  posted.find((message) => message.type === 'minimise')?.on === true)
check('the body is marked minimised', window.document.body.classList.contains('mini'))
check('the button becomes a restore', id('minimise').textContent === '⤢' &&
  id('minimise').title === 'Restore the panel')

// The class is what hides the workspace; assert the rule exists rather than
// trusting jsdom's layout, which does not compute one.
const sheet = [...window.document.styleSheets[0].cssRules].map((rule) => rule.cssText).join('\n')
check('the workspace is hidden by the minimised rule',
  /body\.mini[^{]*\.body[^{]*\{[^}]*display:\s*none/.test(sheet.replace(/\s+/g, ' ')))
check('so is the footer and the relay page',
  sheet.includes('body.mini .footbar') || /body\.mini[^{]*footbar/.test(sheet.replace(/\s+/g, ' ')))

// -------------------------------------------------- still working, minimised

// A selection while minimised must still name itself: the strip is all there is
// to read, and lining up a selection is why the panel got out of the way.
send({
  type: 'selected',
  id: '9:9',
  ids: ['9:9'],
  rows: [{ id: '9:9', name: 'Checkout Sheet', type: 'FRAME', width: 375, height: 420, childCount: 3 }],
})
await settle()
check('the strip names what you picked', id('title').textContent === 'Checkout Sheet')
check('with its type and size', id('subtitle').textContent === 'FRAME · 375×420')

// ------------------------------------------------------- saving from the strip

check('the strip offers Save once something is selected',
  id('mini-save').disabled === false && id('mini-save').textContent === 'Save')

posted.length = 0
id('mini-save').click()
await settle()
check('the strip saves without restoring',
  posted.find((message) => message.type === 'save-selection') !== undefined)
check('and saving does not restore the panel by accident',
  window.document.body.classList.contains('mini'))

// A save has no list to watch change from in here, so the message is the receipt.
send({ type: 'save-result', added: 1, already: 0, moved: 0, full: 0, folder: '' })
await settle()
check('a save is confirmed', id('toast').hidden === false && id('toast').textContent === 'Saved 1')
check('and the confirmation is the green one', id('toast').className === 'toast')

// The same layer twice is not a duplicate and not a dead button: it says so.
send({ type: 'save-result', added: 0, already: 1, moved: 0, full: 0, folder: '' })
await settle()
check('saving the same layer again says it is already saved',
  id('toast').textContent === 'Already saved' && id('toast').className === 'toast warn')

send({ type: 'save-result', added: 2, already: 0, moved: 0, full: 0, folder: 'Checkout' })
await settle()
check('and it names the folder it went to', id('toast').textContent === 'Saved 2 to Checkout')

send({ type: 'save-result', added: 0, already: 0, moved: 0, full: 3, folder: '' })
await settle()
check('a full set is an error, not a shrug',
  id('toast').textContent.includes('full') && id('toast').className === 'toast bad')

// --------------------------------------------------------------- thumbnail

check('no thumbnail until one arrives', id('mini-thumb').hidden === true)
// A one-pixel PNG is enough: what matters is that bytes become a visible image.
send({ type: 'thumb', id: '9:9', png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) })
await settle()
check('a thumbnail of the selection appears in the strip',
  id('mini-thumb').hidden === false && id('mini-thumb').src.startsWith('blob:'))
const firstThumb = id('mini-thumb').src
send({ type: 'thumb', id: '9:8', png: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]) })
await settle()
check('picking something else replaces it', id('mini-thumb').src !== firstThumb)
send({ type: 'thumb', id: null, png: null })
await settle()
check('and selecting nothing clears it', id('mini-thumb').hidden === true)

// A window resize while minimised is the plugin's own doing, and must not be
// stored as the size the user chose.
posted.length = 0
window.dispatchEvent(new window.Event('resize'))
await new Promise((resolve) => setTimeout(resolve, 500))
check('a resize while minimised is not remembered',
  posted.find((message) => message.type === 'resize') === undefined)

// ----------------------------------------------------------------- restore

posted.length = 0
id('minimise').click()
await settle()
check('restoring tells the main thread to grow again',
  posted.find((message) => message.type === 'minimise')?.on === false)
check('the workspace comes back', !window.document.body.classList.contains('mini'))
check('and the button is a minimise again', id('minimise').textContent === '–')
check('the strip thumbnail is dropped, the real preview takes over',
  id('mini-thumb').hidden === true)

// The strip is a bigger target than the button, and has nothing else on it.
id('minimise').click()
await settle()
posted.length = 0
id('topbar').click()
await settle()
check('clicking the strip restores too',
  !window.document.body.classList.contains('mini') &&
  posted.find((message) => message.type === 'minimise')?.on === false)

// But the button on the strip stays a toggle, not a second restore.
posted.length = 0
id('minimise').click()
await settle()
check('the button still minimises from the open panel',
  window.document.body.classList.contains('mini'))

window.close()
const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
