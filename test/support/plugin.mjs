// A running Figsnap plugin, for suites that want to exercise the real one.
//
// dist/code.js is the shipped main thread. Here it runs against a stand-in for
// the figma API and is wired to the shared relay through the same socket
// protocol the panel speaks, so everything between an HTTP request and the
// plugin's answer is the code that ships — only Figma itself is faked.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { requireRelay, account } from './relay.mjs'

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
    layoutSizingHorizontal: 'FIXED',
    layoutSizingVertical: 'FIXED',
    appendChild(child) {
      if (child.parent?.children) {
        const at = child.parent.children.indexOf(child)
        if (at !== -1) child.parent.children.splice(at, 1)
      }
      child.parent = node
      node.children.push(child)
    },
    insertChild(index, child) {
      if (child.parent?.children) {
        const at = child.parent.children.indexOf(child)
        if (at !== -1) child.parent.children.splice(at, 1)
      }
      child.parent = node
      node.children.splice(index, 0, child)
    },
    remove() {
      const at = node.parent?.children?.indexOf(node) ?? -1
      if (at !== -1) node.parent.children.splice(at, 1)
      node.removed = true
    },
    resize(width, height) {
      node.width = width
      node.height = height
    },
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
          hasMissingFont: false,
          getRangeAllFontNames() {
            return [{ family: 'Inter', style: 'Regular' }]
          },
        }
      : {}),
    clone() {
      const copy = makeNode(`${id}-copy`, name, type, [], css)
      copy.width = node.width
      copy.height = node.height
      copy.fills = node.fills
      return copy
    },
    setFillStyleIdAsync(styleId) {
      node.fillStyleId = styleId
      return Promise.resolve()
    },
    setTextStyleIdAsync(styleId) {
      node.textStyleId = styleId
      return Promise.resolve()
    },
    setEffectStyleIdAsync(styleId) {
      node.effectStyleId = styleId
      return Promise.resolve()
    },
    setBoundVariable(field, variable) {
      node.boundVariables = { ...(node.boundVariables ?? {}), [field]: variable.id }
    },
    async getCSSAsync() {
      return css
    },
    async exportAsync() {
      // The real PNG signature, so anything that decodes the bytes sees a PNG.
      return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
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
export async function startPlugin({ pageChildren = [], offPage = [], label = 'plugin' } = {}) {
  // Its own account, so this plugin gets a room nothing else is writing to.
  const base = requireRelay(label)
  const { token, headers } = await account(base, label)
  const storage = new Map()
  // offPage nodes are reachable by id but are not on the current page, which is
  // how a fixture can be extracted without disturbing what /tree returns.
  const nodes = index([...pageChildren, ...offPage])
  let toPanel = () => {}

  // Figma always sets parent; the Figma-CSS renderer reads it on the root.
  /** Everything under the current page, which is what findAllWithCriteria walks. */
  const walk = (list, into = []) => {
    for (const node of list) {
      into.push(node)
      if (node.children?.length) walk(node.children, into)
    }
    return into
  }

  const page = {
    id: 'p1',
    name: 'Page 1',
    type: 'PAGE',
    children: pageChildren,
    selection: [],
    parent: null,
    appendChild(child) {
      if (child.parent?.children) {
        const at = child.parent.children.indexOf(child)
        if (at !== -1) child.parent.children.splice(at, 1)
      }
      child.parent = page
      pageChildren.push(child)
    },
    insertChild(index, child) {
      if (child.parent?.children) {
        const at = child.parent.children.indexOf(child)
        if (at !== -1) child.parent.children.splice(at, 1)
      }
      child.parent = page
      pageChildren.splice(index, 0, child)
    },
    findAllWithCriteria({ types }) {
      return walk(pageChildren).filter((node) => types.includes(node.type))
    },
  }
  for (const child of pageChildren) child.parent = page

  /** Ids for anything the plugin creates during a run. */
  let created = 0
  const born = (name, type) => {
    const node = makeNode(`new:${++created}`, name, type)
    nodes.set(node.id, node)
    return node
  }

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
    // The write side of the API. `commitUndo` is what puts a plugin's changes in
    // undo history at all, so a suite that never sees it called is looking at an
    // edit the designer could not take back.
    undos: [],
    commitUndo() {
      figma.undos.push(Date.now())
    },
    versions: [],
    async saveVersionHistoryAsync(title, description) {
      figma.versions.push({ title, description })
      return { id: `v${figma.versions.length}` }
    },
    // Only the fonts this "machine" has. A plugin that substitutes silently is
    // the failure the real one is careful to avoid, so the fake refuses too.
    fonts: ['Inter'],
    async loadFontAsync(font) {
      if (!figma.fonts.includes(font.family)) throw new Error(`no ${font.family}`)
    },
    createFrame() {
      return born('Frame', 'FRAME')
    },
    createText() {
      const node = born('Text', 'TEXT')
      node.characters = ''
      node.hasMissingFont = false
      node.getRangeAllFontNames = () => [node.fontName]
      return node
    },
    createRectangle() {
      return born('Rectangle', 'RECTANGLE')
    },
    createEllipse() {
      return born('Ellipse', 'ELLIPSE')
    },
    createNodeFromSvg(svg) {
      if (!svg.includes('<svg')) throw new Error('not svg')
      const node = born('Vector', 'FRAME')
      node.svg = svg
      return node
    },
    // The style and variable side of a design system, enough for the tools that
    // read it and the two that write through it.
    styles: new Map(),
    async getStyleByIdAsync(id) {
      return figma.styles.get(id) ?? null
    },
    async getLocalPaintStylesAsync() {
      return [...figma.styles.values()].filter((style) => style.type === 'PAINT')
    },
    async getLocalTextStylesAsync() {
      return [...figma.styles.values()].filter((style) => style.type === 'TEXT')
    },
    async getLocalEffectStylesAsync() {
      return [...figma.styles.values()].filter((style) => style.type === 'EFFECT')
    },
    variables: {
      store: new Map(),
      collections: [],
      async getLocalVariableCollectionsAsync() {
        return figma.variables.collections
      },
      async getLocalVariablesAsync() {
        return [...figma.variables.store.values()]
      },
      async getVariableByIdAsync(id) {
        return figma.variables.store.get(id) ?? null
      },
      setBoundVariableForPaint(paint, field, variable) {
        return { ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } }
      },
    },
    closePlugin() {},
    openExternal() {},
    notify() {},
    async getNodeByIdAsync(id) {
      const known = nodes.get(id)
      if (known !== undefined) return known.removed ? null : known
      // Clones and anything else a mutation produced are in the tree before
      // they are in the index, so the tree is the fallback.
      const found = walk(pageChildren).find((node) => node.id === id)
      if (found !== undefined) nodes.set(id, found)
      return found ?? null
    },
    async loadAllPagesAsync() {},
    async setCurrentPageAsync() {},
  }

  const bundle = await readFile(join(root, 'dist/code.js'), 'utf8')
  new Function('figma', '__html__', bundle)(figma, '<html></html>')

  const socket = new WebSocket(`${base.replace(/^http/, 'ws')}/plugin?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', reject)
  })

  // The panel's job, reduced to what a relay request needs: hand the command to
  // the main thread and send its answer back.
  const pending = new Map()
  // Everything the main thread pushes at the panel, so a suite can assert on
  // what the designer would have seen and not only on what a caller was told.
  const toPanelMessages = []
  toPanel = (message) => {
    toPanelMessages.push(message)
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
    panelMessages: toPanelMessages,
    base,
    token,
    headers,
    toMain,
    get: (path) => fetch(`${base}${path}`, { headers }).then((response) => response.json()),
    body: (method, path, payload) =>
      fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(payload),
      }).then(async (response) => ({ status: response.status, data: await response.json() })),
    stop() {
      socket.close()
    },
  }
}
