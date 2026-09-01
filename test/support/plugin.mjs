// A running Figsnap plugin, for suites that want to exercise the real one.
//
// dist/code.js is the shipped main thread. Here it runs against a stand-in for
// the figma API and is wired to a real relay through the same socket protocol
// the panel speaks, so everything between an HTTP request and the plugin's
// answer is the code that ships — only Figma itself is faked.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** PNG bytes cross the socket as base64, exactly as src/ui/bridge.ts sends them. */
function encodeBinary(value) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  if (Array.isArray(value)) return value.map(encodeBinary)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) out[key] = encodeBinary(entry)
    return out
  }
  return value
}

/**
 * A scene node with the properties the plugin actually reads — including the
 * geometry the Figma-CSS renderer needs, which is most of them.
 */
export function makeNode(id, name, type = 'FRAME', children = [], css = { width: '100px' }) {
  const node = {
    id,
    name,
    type,
    removed: false,
    visible: true,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    blendMode: 'PASS_THROUGH',
    cornerRadius: 0,
    clipsContent: false,
    layoutMode: 'NONE',
    layoutPositioning: 'AUTO',
    constraints: { horizontal: 'MIN', vertical: 'MIN' },
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
    absoluteRenderBounds: { x: 0, y: 0, width: 100, height: 100 },
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'INSIDE',
    effects: [],
    children,
    isAsset: false,
    parent: null,
    // A TEXT node carries a whole typography block that the Figma-CSS renderer
    // reads unconditionally.
    ...(type === 'TEXT'
      ? {
          characters: name,
          fontName: { family: 'Inter', style: 'Regular' },
          fontSize: 14,
          fontWeight: 400,
          lineHeight: { unit: 'PIXELS', value: 20 },
          letterSpacing: { unit: 'PIXELS', value: 0 },
          textAlignHorizontal: 'LEFT',
          textAlignVertical: 'TOP',
          textCase: 'ORIGINAL',
          textDecoration: 'NONE',
          textAutoResize: 'NONE',
        }
      : {}),
    async getCSSAsync() {
      return css
    },
    async exportAsync() {
      return new Uint8Array([137, 80, 78, 71])
    },
  }
  for (const child of children) child.parent = node
  return node
}

/** Every node in a tree, keyed by id, so getNodeByIdAsync can find any of them. */
function index(nodes, into = new Map()) {
  for (const node of nodes) {
    into.set(node.id, node)
    if (node.children?.length) index(node.children, into)
  }
  return into
}

/**
 * Starts a relay, loads the plugin against it, and returns the pieces a suite
 * needs: the fake figma to poke, and helpers to call the relay over HTTP.
 */
export async function startPlugin({ port, pageChildren = [], offPage = [] }) {
  const base = `http://127.0.0.1:${port}`
  const storage = new Map()
  // offPage nodes are reachable by id but are not on the current page, which is
  // how a fixture can be extracted without disturbing what /tree returns.
  const nodes = index([...pageChildren, ...offPage])
  let toPanel = () => {}

  // Figma always sets parent; the Figma-CSS renderer reads it on the root.
  const page = { id: 'p1', name: 'Page 1', type: 'PAGE', children: pageChildren, selection: [], parent: null }
  for (const child of pageChildren) child.parent = page

  const figma = {
    root: { id: 'doc-1' },
    fileKey: 'FILEKEY',
    mixed: Symbol('mixed'),
    currentPage: page,
    // The real clientStorage serialises, so a stored value must not stay aliased
    // to the object the plugin still holds.
    clientStorage: {
      async getAsync(key) {
        const value = storage.get(key)
        return value === undefined ? undefined : structuredClone(value)
      },
      async setAsync(key, value) {
        storage.set(key, structuredClone(value))
      },
    },
    ui: { onmessage: null, postMessage: (message) => toPanel(message), resize() {} },
    showUI() {},
    on() {},
    closePlugin() {},
    openExternal() {},
    notify() {},
    async getNodeByIdAsync(id) {
      return nodes.get(id) ?? null
    },
    async loadAllPagesAsync() {},
    async setCurrentPageAsync() {},
  }

  const bundle = await readFile(join(root, 'dist/code.js'), 'utf8')
  new Function('figma', '__html__', bundle)(figma, '<html></html>')

  const relay = spawn('node', [join(root, 'server/relay.mjs')], {
    env: { ...process.env, RELAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  relay.stderr.on('data', (data) => console.error('[relay]', String(data).trim()))
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetch(`${base}/health`)
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  const socket = new WebSocket(`ws://127.0.0.1:${port}/plugin`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })

  // The panel's job, reduced to what a relay request needs: hand the command to
  // the main thread and send its answer back.
  const pending = new Map()
  toPanel = (message) => {
    if (message.type !== 'res') return
    const relayId = pending.get(message.id)
    if (relayId === undefined) return
    pending.delete(message.id)
    socket.send(
      JSON.stringify({
        kind: 'response',
        id: relayId,
        ok: message.ok,
        data: encodeBinary(message.data),
        error: message.error,
      }),
    )
  }

  let counter = 0
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(event.data)
    if (frame.kind !== 'request') return
    const id = `t${++counter}`
    pending.set(id, frame.id)
    figma.ui.onmessage({ type: 'req', id, command: frame.command, params: frame.params ?? {} })
  })

  const toMain = (message) => figma.ui.onmessage(message)
  // The plugin's own startup: loads whatever is in storage.
  toMain({ type: 'ready' })
  await new Promise((resolve) => setTimeout(resolve, 400))

  return {
    figma,
    storage,
    nodes,
    base,
    toMain,
    get: (path) => fetch(`${base}${path}`).then((response) => response.json()),
    body: (method, path, payload) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }).then(async (response) => ({ status: response.status, data: await response.json() })),
    stop() {
      socket.close()
      relay.kill()
    },
  }
}
