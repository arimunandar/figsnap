// Opens the shipped panel in jsdom, with a stand-in for the main thread.
//
// Every panel suite needs the same three things and used to carry its own copy:
// `dist/ui.html` parsed with scripts running, the browser APIs jsdom lacks, and
// something that answers `ready` with stored settings so the panel opens on the
// workspace rather than the sign-in gate. The differences between the suites
// are the settings and what they do with the messages, so those are the arguments.
//
// The panel under test is the built one, deliberately: nothing about the flow is
// reimplemented here, so a suite fails when the shipped panel changes behaviour.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let cached = null

export async function panelHtml() {
  if (cached === null) cached = await readFile(join(root, 'dist/ui.html'), 'utf8')
  return cached
}

/** A socket that never opens, for suites with nothing on the other end. */
class DeadSocket {
  constructor() {
    this.readyState = 0
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
  send() {}
}

/** Long enough for a postMessage round trip and the render that follows it. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

/**
 * Awaits the condition. An async one returns a promise, which is always truthy,
 * so a poll that did not await would report success on its first tick.
 */
export async function until(condition, timeoutMs = 15_000, label = 'condition') {
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

const DEFAULT_SETTINGS = {
  url: 'wss://relay.test/plugin',
  token: 'a stored token',
  email: 'you@example.test',
  profiles: [],
}

/**
 * @param {object} [options]
 * @param {object|null} [options.settings]  answered to `ready`; null sends none
 * @param {object|null} [options.agent]     agent settings answered to `ready`
 * @param {boolean} [options.online]        use Node's real fetch and WebSocket
 * @param {(message: object, api: object) => void} [options.onMessage]
 */
export async function openPanel(options = {}) {
  const { settings = DEFAULT_SETTINGS, agent = null, online = false, onMessage } = options
  const html = await panelHtml()

  const dom = new JSDOM(html, {
    url: 'https://www.figma.com/',
    runScripts: 'dangerously',
    // A plugin iframe has all of these; jsdom has none of them, and Node's are
    // the real ones, so an online suite exercises the shipped network paths.
    beforeParse(window) {
      window.fetch = online ? (input, init) => fetch(input, init) : async () => { throw new Error('offline') }
      window.WebSocket = online ? WebSocket : DeadSocket
      let issued = 0
      window.URL.createObjectURL = () => `blob:figsnap/${++issued}`
      window.URL.revokeObjectURL = () => {}
    },
  })

  const { window } = dom
  const send = (message) => window.postMessage({ pluginMessage: message }, '*')
  const posted = []
  const api = { window, send, posted }

  window.addEventListener('message', (event) => {
    const message = event.data?.pluginMessage
    if (!message || typeof message.type !== 'string') return
    posted.push(message)
    if (message.type === 'ready') {
      if (settings !== null) send({ type: 'settings', ...settings })
      if (agent !== null) send({ type: 'agent-settings', ...agent })
    }
    onMessage?.(message, api)
  })

  await settle()
  await settle()

  return {
    dom,
    window,
    send,
    posted,
    settle,
    id: (name) => window.document.getElementById(name),
    workspace: () => window.document.querySelector('.body'),
  }
}
