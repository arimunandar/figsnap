// UI thread: DOM and network available, no figma API.
import './style.css'
import { createBridge, type BridgeStatus } from './bridge'
import { highlightLines } from './highlight'
import { groups as apiGroups, curlFor, requestHeaders, type Endpoint } from '../../shared/endpoints.mjs'
import { DEFAULT_RELAY_URL, HOSTED_RELAY_URL, LOCAL_RELAY_URL, needsAccount } from '../relays'

let relayUrl = DEFAULT_RELAY_URL
let relayToken = ''
let relayEmail = ''
let settingsLoaded = false
let relayProfiles: { url: string; token: string; email?: string }[] = []

/** The HTTP face of a relay, given its socket address. */
function httpOf(url: string): string {
  return url.replace(/^ws/, 'http').replace(/\/plugin$/, '')
}

/** The HTTP face of whatever relay the user has pointed the plugin at. */
function httpBase(): string {
  return httpOf(relayUrl)
}

function authHeaders(): Record<string, string> {
  return relayToken === '' ? {} : { 'x-relay-token': relayToken }
}

type TreeRow = {
  id: string
  name: string
  type: string
  width: number
  height: number
  childCount: number
}

/** A row as the main thread sends it: nested where the walk went deeper. */
type IncomingRow = TreeRow & { children?: IncomingRow[] }

type Extraction = {
  type: 'extract'
  id: string
  name: string
  nodeType: string
  width: number
  height: number
  layerCount: number
  truncated: boolean
  // The panel always asks for everything, but a relay caller can ask for less,
  // and the same message type carries both answers.
  outputs?: string[]
  png?: Uint8Array
  html?: string
  css?: string
  tsx?: string
  moduleCss?: string
  figmaCss?: string
}

type PluginResponse = { type: 'res'; id: string; ok: boolean; data?: unknown; error?: string }

type BatchProgress = {
  type: 'batch-progress'
  index: number
  total: number
  ref: string
  nodeId: string | null
  ok: boolean
  name?: string
  nodeType?: string
  layerCount?: number
  error?: string
}

type Selected = { type: 'selected'; id: string | null; ids: string[]; rows: TreeRow[] }

type FromPlugin =
  | Extraction
  | { type: 'settings'; url: string; token: string; email?: string; profiles?: { url: string; token: string; email?: string }[] }
  | PluginResponse
  | Selected
  | BatchProgress
  | { type: 'batch-done'; total: number; okCount: number }
  | { type: 'saved'; folders: FolderCount[]; entries: SavedEntry[] }
  | { type: 'save-result'; added: number; already: number; moved: number; full: number; folder: string }
  | { type: 'thumb'; id: string | null; png: Uint8Array | null }
  | { type: 'tree'; page: string; rows: IncomingRow[]; truncated: boolean }
  | { type: 'children'; parentId: string; rows: IncomingRow[]; truncated: boolean }
  | { type: 'busy' }
  | { type: 'error'; message: string }

type TreeNode = TreeRow & {
  depth: number
  expanded: boolean
  children: TreeNode[] | null
}

type SavedEntry = {
  id: string
  name: string
  type: string
  addedAt: number
  folder: string
  missing?: boolean
}

type FolderCount = { name: string; count: number }

type CodeTab = 'tsx' | 'html' | 'moduleCss' | 'css' | 'figmaCss'
type SourceTab = 'tree' | 'selection' | 'saved' | 'links'

const title = document.getElementById('title') as HTMLSpanElement
const subtitle = document.getElementById('subtitle') as HTMLSpanElement
const image = document.getElementById('image') as HTMLImageElement
const placeholder = document.getElementById('placeholder') as HTMLParagraphElement
const treePanel = document.getElementById('tree-panel') as HTMLDivElement
const treeBox = document.getElementById('tree') as HTMLDivElement
const gutter = document.getElementById('gutter') as HTMLDivElement
const codeView = document.getElementById('code-view') as HTMLDivElement
const status = document.getElementById('status') as HTMLParagraphElement
const scaleSelect = document.getElementById('scale') as HTMLSelectElement
const selectionOnly = document.getElementById('selection-only') as HTMLInputElement
const inlineInstances = document.getElementById('inline-instances') as HTMLInputElement
const refreshButton = document.getElementById('refresh') as HTMLButtonElement
const minimiseButton = document.getElementById('minimise') as HTMLButtonElement
const miniSaveButton = document.getElementById('mini-save') as HTMLButtonElement
const toastLine = document.getElementById('toast') as HTMLSpanElement
const miniThumb = document.getElementById('mini-thumb') as HTMLImageElement
const miniPlaceholder = document.getElementById('mini-placeholder') as HTMLParagraphElement
const copyImageButton = document.getElementById('copy-image') as HTMLButtonElement
const downloadButton = document.getElementById('download') as HTMLButtonElement
const copyCodeButton = document.getElementById('copy-code') as HTMLButtonElement
const sourceNav = document.getElementById('sources') as HTMLElement
const codeNav = document.getElementById('code-tabs') as HTMLElement
const selectionPanel = document.getElementById('selection-panel') as HTMLDivElement
const selectionList = document.getElementById('selection-list') as HTMLDivElement
const selectionCount = document.getElementById('selection-count') as HTMLSpanElement
const savedPanel = document.getElementById('saved-panel') as HTMLDivElement
const savedList = document.getElementById('saved-list') as HTMLDivElement
const savedCount = document.getElementById('saved-count') as HTMLSpanElement
const clearSavedButton = document.getElementById('clear-saved') as HTMLButtonElement
const newFolderButton = document.getElementById('new-folder') as HTMLButtonElement
const editFolderButton = document.getElementById('edit-folder') as HTMLButtonElement
const folderForm = document.getElementById('folder-form') as HTMLFormElement
const folderNameInput = document.getElementById('folder-name') as HTMLInputElement
const folderSaveButton = document.getElementById('folder-save') as HTMLButtonElement
const folderDeleteButton = document.getElementById('folder-delete') as HTMLButtonElement
const folderChips = document.getElementById('folder-chips') as HTMLDivElement
const linksPanel = document.getElementById('links-panel') as HTMLDivElement
const addLinkForm = document.getElementById('add-link-form') as HTMLFormElement
const urlInput = document.getElementById('url-input') as HTMLInputElement
const linkListBox = document.getElementById('link-list') as HTMLDivElement
const clearLinksButton = document.getElementById('clear-links') as HTMLButtonElement
const linkCount = document.getElementById('link-count') as HTMLSpanElement
const primaryAction = document.getElementById('primary-action') as HTMLButtonElement
const saveSelectionButton = document.getElementById('save-selection') as HTMLButtonElement
const workspace = document.querySelector('.body') as HTMLElement
const topbar = document.getElementById('topbar') as HTMLElement
const authPage = document.getElementById('auth-page') as HTMLDivElement
const authLead = document.getElementById('auth-lead') as HTMLParagraphElement
const authTabs = document.getElementById('auth-tabs') as HTMLElement
const authForm = document.getElementById('auth-form') as HTMLFormElement
const authEmail = document.getElementById('auth-email') as HTMLInputElement
const authPassword = document.getElementById('auth-password') as HTMLInputElement
const authSubmit = document.getElementById('auth-submit') as HTMLButtonElement
const authMessageLine = document.getElementById('auth-message') as HTMLParagraphElement
const authSteps = document.getElementById('auth-steps') as HTMLOListElement
const authBootLine = document.getElementById('auth-boot') as HTMLParagraphElement
const authRelayLine = document.getElementById('auth-relay') as HTMLSpanElement
const authLocalButton = document.getElementById('auth-local') as HTMLButtonElement
const relayPage = document.getElementById('relay-page') as HTMLDivElement
const relayPageToggle = document.getElementById('relay-toggle-page') as HTMLButtonElement
const pageDot = document.getElementById('page-dot') as HTMLSpanElement
const pageState = document.getElementById('page-state') as HTMLSpanElement
const pageFacts = document.getElementById('page-facts') as HTMLDListElement
const pageReconnect = document.getElementById('page-reconnect') as HTMLButtonElement
const pageUrl = document.getElementById('page-url') as HTMLInputElement
const pageToken = document.getElementById('page-token') as HTMLInputElement
const pageTokenShow = document.getElementById('page-token-show') as HTMLButtonElement
const pageTokenCopy = document.getElementById('page-token-copy') as HTMLButtonElement
const pageSettingsStatus = document.getElementById('page-settings-status') as HTMLSpanElement
const pageSave = document.getElementById('page-save') as HTMLButtonElement
const pageDefaults = document.getElementById('page-defaults') as HTMLButtonElement
const pageRelays = document.getElementById('page-relays') as HTMLDivElement
const pageAccount = document.getElementById('page-account') as HTMLSpanElement
const pageAccountNote = document.getElementById('page-account-note') as HTMLParagraphElement
const pageSignIn = document.getElementById('page-signin') as HTMLButtonElement
const pageSignOut = document.getElementById('page-signout') as HTMLButtonElement
const pageTokenHint = document.getElementById('page-token-hint') as HTMLSpanElement
const installerBox = document.getElementById('installer') as HTMLDivElement
const skillLocalOnly = document.getElementById('skill-local-only') as HTMLParagraphElement
const apiList = document.getElementById('api-list') as HTMLDivElement
const apiNode = document.getElementById('api-node') as HTMLInputElement
const pageHealthCommand = document.getElementById('page-cmd-health') as HTMLPreElement
const footbar = document.getElementById('footbar') as HTMLElement
const relayToggle = document.getElementById('relay') as HTMLInputElement
const relayDot = document.getElementById('relay-dot') as HTMLSpanElement
const relayStatus = document.getElementById('relay-status') as HTMLSpanElement

let roots: TreeNode[] = []
const byId = new Map<string, TreeNode>()
let activeSource: SourceTab = 'tree'
let activeCode: CodeTab = 'tsx'
let selectedId: string | null = null
let selectedIds: string[] = []
let savedEntries: SavedEntry[] = []
let savedFolders: FolderCount[] = []
// null is "All"; '' is the root, where an entry with no folder sits.
let savedFolder: string | null = null
let folderFormMode: 'create' | 'rename' = 'create'
let linkQueue: { url: string; nodeId: string }[] = []
let selectionRows: TreeRow[] = []
let code: Record<CodeTab, string> = { tsx: '', html: '', moduleCss: '', css: '', figmaCss: '' }
let currentBlob: Blob | null = null
let currentUrl: string | null = null
let currentName = 'selection'

function post(pluginMessage: unknown) {
  parent.postMessage({ pluginMessage }, '*')
}

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let requestCounter = 0

function requestPlugin(command: string, params: Record<string, unknown>): Promise<unknown> {
  const id = `r${++requestCounter}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    post({ type: 'req', id, command, params })
    // The main thread always answers, but a closed file would leave this open.
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error('Main thread did not answer in 25s'))
    }, 25_000)
  })
}

let relayState: BridgeStatus = 'off'

const bridge = createBridge({
  url: () => (relayToken === '' ? relayUrl : `${relayUrl}?token=${encodeURIComponent(relayToken)}`),
  request: requestPlugin,
  onStatus: (status: BridgeStatus, detail?: string) => {
    relayState = status
    relayDot.className = `dot ${status}`
    relayStatus.textContent = detail ?? status
    if (view === 'relay') {
      refreshRelayPage()
      void loadHealth()
    }
  },
  // A rejected token is not something a retry can fix, so it re-opens the gate.
  onRejected: () => sessionExpired('The relay rejected that token. Sign in again.'),
})

function setStatus(text: string) {
  status.textContent = text
}

// --------------------------------------------------------------------- toast
//
// Saving from the strip has no list to watch change, so the confirmation has to
// be the message itself — including the case where nothing changed because the
// layer was already saved, which otherwise looks like a dead button.

const TOAST_MS = 2600
let toastTimer: number | undefined

function toast(text: string, tone: 'good' | 'warn' | 'bad' = 'good') {
  toastLine.textContent = text
  toastLine.className = tone === 'good' ? 'toast' : `toast ${tone}`
  toastLine.hidden = false
  document.body.classList.add('toasting')
  if (toastTimer !== undefined) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    toastLine.hidden = true
    document.body.classList.remove('toasting')
  }, TOAST_MS)
}

/** Says what actually happened, so a second press is not a mystery. */
function saveMessage(result: { added: number; already: number; moved: number; full: number; folder: string }) {
  const where = result.folder === '' ? '' : ` to ${result.folder}`
  if (result.full > 0 && result.added === 0) {
    return { text: `Saved set is full at ${MAX_SAVED_ENTRIES}`, tone: 'bad' as const }
  }
  if (result.added > 0) {
    return { text: `Saved ${result.added}${where}`, tone: 'good' as const }
  }
  if (result.moved > 0) {
    return { text: `Moved ${result.moved}${where}`, tone: 'good' as const }
  }
  if (result.already > 0) {
    return {
      text: result.already === 1 ? 'Already saved' : `All ${result.already} already saved`,
      tone: 'warn' as const,
    }
  }
  return { text: 'Nothing selected', tone: 'warn' as const }
}

// ------------------------------------------------------------------ tree

/**
 * Rows the walk already descended into arrive nested, and open as they are.
 * Anything still flat keeps the old behaviour: a twisty that fetches on click.
 */
function toTreeNodes(rows: IncomingRow[], depth: number): TreeNode[] {
  return rows.map((row) => {
    const { children, ...rest } = row
    const node: TreeNode = {
      ...rest,
      depth,
      expanded: children !== undefined,
      children: children === undefined ? null : toTreeNodes(children, depth + 1),
    }
    byId.set(node.id, node)
    return node
  })
}

function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node)
    if (node.expanded && node.children) flatten(node.children, out)
  }
  return out
}

function renderTree() {
  treeBox.textContent = ''
  const visible = flatten(roots)
  if (visible.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'placeholder'
    empty.textContent = 'This page has no visible top-level layers.'
    treeBox.appendChild(empty)
    return
  }

  for (const node of visible) {
    const row = document.createElement('div')
    row.className = 'tree-row'
    if (node.id === selectedId || selectedIds.indexOf(node.id) !== -1) row.classList.add('selected')
    row.style.paddingLeft = `${4 + node.depth * 14}px`

    const twisty = document.createElement('button')
    twisty.type = 'button'
    twisty.className = 'twisty'
    if (node.childCount > 0) {
      twisty.textContent = node.expanded ? '▾' : '▸'
      twisty.addEventListener('click', (event) => {
        event.stopPropagation()
        toggle(node)
      })
    } else {
      twisty.classList.add('empty')
      twisty.disabled = true
    }
    row.appendChild(twisty)

    const label = document.createElement('span')
    label.className = 'tree-name'
    label.textContent = node.name
    row.appendChild(label)

    const badge = document.createElement('span')
    badge.className = 'tree-type'
    badge.textContent = node.childCount > 0 ? `${node.type} · ${node.childCount}` : node.type
    row.appendChild(badge)

    row.addEventListener('click', (event) => {
      // Cmd/Ctrl-click adds to the canvas selection instead of replacing it.
      const additive = event.metaKey || event.ctrlKey
      if (!additive) {
        selectedId = node.id
        renderTree()
      }
      post({ type: 'pick', id: node.id, additive })
    })

    treeBox.appendChild(row)
  }
}

function toggle(node: TreeNode) {
  if (node.children === null) {
    node.expanded = true
    post({ type: 'expand', id: node.id })
    return
  }
  node.expanded = !node.expanded
  renderTree()
}

// ------------------------------------------------------------------ tabs

// The sidebar picks what you are browsing; the right pane picks which output you
// are reading. They are independent, so a list stays visible while you read code.

function markActive(nav: HTMLElement, attribute: string, value: string) {
  for (const button of Array.from(nav.querySelectorAll('.seg'))) {
    button.classList.toggle('active', (button as HTMLElement).dataset[attribute] === value)
  }
}

function setSource(source: SourceTab) {
  activeSource = source
  markActive(sourceNav, 'source', source)
  treePanel.hidden = source !== 'tree'
  selectionPanel.hidden = source !== 'selection'
  savedPanel.hidden = source !== 'saved'
  linksPanel.hidden = source !== 'links'
  renderActiveList()
  refreshPrimary()
}

function refreshCodeBox() {
  const source = code[activeCode]
  copyCodeButton.disabled = source.length === 0
  copyCodeButton.textContent =
    activeCode === 'tsx' ? 'Copy TSX' : activeCode === 'html' ? 'Copy HTML' : 'Copy CSS'

  gutter.textContent = ''
  codeView.textContent = ''

  if (source.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'placeholder pad'
    empty.textContent = 'Code appears here.'
    codeView.appendChild(empty)
    return
  }

  const language = activeCode === 'tsx' ? 'tsx' : activeCode === 'html' ? 'html' : 'css'
  const lines = highlightLines(source, language)
  const numbers = document.createDocumentFragment()
  const body = document.createDocumentFragment()

  lines.forEach((html, index) => {
    const number = document.createElement('div')
    number.textContent = String(index + 1)
    numbers.appendChild(number)

    const line = document.createElement('div')
    line.className = 'line'
    // Already escaped by the highlighter; only its own spans are markup.
    line.innerHTML = html
    body.appendChild(line)
  })

  gutter.appendChild(numbers)
  codeView.appendChild(body)
}

function setCode(tab: CodeTab) {
  activeCode = tab
  markActive(codeNav, 'code', tab)
  refreshCodeBox()
}

sourceNav.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('.seg') as HTMLElement | null
  if (!target?.dataset.source) return
  setSource(target.dataset.source as SourceTab)
})

codeNav.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest('.seg') as HTMLElement | null
  if (!target?.dataset.code) return
  setCode(target.dataset.code as CodeTab)
})

// ------------------------------------------------------------------ clipboard

/**
 * The plugin UI runs in a sandboxed iframe where the async clipboard API is
 * often unavailable, so fall back to a hidden textarea and execCommand.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through to the legacy path.
  }
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.style.position = 'fixed'
  scratch.style.top = '-1000px'
  document.body.appendChild(scratch)
  scratch.select()
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  scratch.remove()
  return copied
}

async function copyImage(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return true
  } catch {
    return false
  }
}

function fileName(name: string, scale: number): string {
  const base = name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'selection'
  return `${base}@${scale}x.png`
}

// ------------------------------------------------------------------ render

function showExtraction(extraction: Extraction) {
  if (currentUrl) URL.revokeObjectURL(currentUrl)
  currentName = extraction.name

  if (extraction.png) {
    // Copying into a fresh Uint8Array gives a plain ArrayBuffer-backed view,
    // which is what the Blob constructor's types accept.
    currentBlob = new Blob([new Uint8Array(extraction.png)], { type: 'image/png' })
    currentUrl = URL.createObjectURL(currentBlob)
    image.src = currentUrl
    image.hidden = false
    placeholder.hidden = true
  } else {
    currentBlob = null
    currentUrl = null
    image.hidden = true
    placeholder.hidden = false
  }

  title.textContent = extraction.name
  const layers = extraction.layerCount === 1 ? '1 layer' : `${extraction.layerCount} layers`
  subtitle.textContent = `${extraction.nodeType} · ${extraction.width}×${extraction.height} · ${layers}`

  code = {
    tsx: extraction.tsx ?? '',
    html: extraction.html ?? '',
    moduleCss: extraction.moduleCss ?? '',
    css: extraction.css ?? '',
    figmaCss: extraction.figmaCss ?? '',
  }
  refreshCodeBox()

  copyImageButton.disabled = currentBlob === null
  downloadButton.disabled = currentUrl === null

  if (selectedId !== extraction.id) {
    selectedId = extraction.id
    renderTree()
  }

  setStatus(extraction.truncated ? 'Stopped after 500 layers.' : '')
}

scaleSelect.addEventListener('change', () => {
  post({ type: 'scale', value: Number(scaleSelect.value) })
})

selectionOnly.addEventListener('change', () => {
  post({ type: 'scope', selectionOnly: selectionOnly.checked })
})

inlineInstances.addEventListener('change', () => {
  post({ type: 'instances', inline: inlineInstances.checked })
})

refreshButton.addEventListener('click', () => post({ type: 'capture' }))

// ------------------------------------------------------------------ sidebar
//
// Each source tab has the same shape: a header strip, a list, and the single
// primary button underneath. Running a batch decorates the rows of the tab it
// came from, so there is never a second list showing the same nodes twice.

// Mirrors the main thread's matcher so a link is validated before it is queued.
const FIGMA_URL = /https?:\/\/(?:[\w-]+\.)?figma\.com\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]+)[^\s]*/

function parseLink(raw: string): { url: string; nodeId: string } | null {
  const match = FIGMA_URL.exec(raw.trim())
  if (!match) return null
  const query = match[0].split('?')[1] ?? ''
  for (const pair of query.split('&')) {
    const [key, value] = pair.split('=')
    // Figma writes node ids with dashes in URLs; the API wants colons.
    if (key === 'node-id' && value) {
      return { url: match[0], nodeId: decodeURIComponent(value).replace(/-/g, ':') }
    }
  }
  return null
}

type RowResult = { ok: boolean; text: string }

let runSource: SourceTab | null = null
let runResults: (RowResult | undefined)[] = []

type RowSpec = {
  batchIndex: number
  name: string
  meta: string
  hint?: string
  missing?: boolean
  /** Emitted as a group label above this row; only the All view uses it. */
  heading?: string
  folder?: string
  onOpen?: () => void
  onRemove?: () => void
  onMove?: (folder: string) => void
  onCopyId?: () => void
}

function buildRow(spec: RowSpec): HTMLDivElement {
  const result = runSource === activeSource && spec.batchIndex >= 0 ? runResults[spec.batchIndex] : undefined
  const row = document.createElement('div')
  row.className = `url-row ${result ? (result.ok ? 'ok' : 'bad') : spec.missing ? 'bad missing' : 'idle'}`

  const mark = document.createElement('span')
  mark.className = 'mark'
  mark.textContent = result ? (result.ok ? '●' : '✕') : spec.missing ? '✕' : '·'
  row.appendChild(mark)

  const name = document.createElement('span')
  name.className = 'detail'
  name.textContent = spec.name
  if (spec.hint) name.title = spec.hint
  row.appendChild(name)

  const meta = document.createElement('span')
  meta.className = 'tree-type'
  meta.textContent = result ? result.text : spec.meta
  row.appendChild(meta)

  // Moving is a one-control job: the select shows where the entry is and is the
  // way to put it somewhere else.
  if (spec.onMove && savedFolders.length > 1) {
    const move = document.createElement('select')
    move.className = 'row-folder'
    move.title = 'Move to a folder'
    for (const folder of savedFolders) {
      const option = document.createElement('option')
      option.value = folder.name
      option.textContent = folder.name === '' ? 'No folder' : folder.name
      if (folder.name === (spec.folder ?? '')) option.selected = true
      move.appendChild(option)
    }
    move.addEventListener('click', (event) => event.stopPropagation())
    move.addEventListener('change', () => spec.onMove?.(move.value))
    row.appendChild(move)
  }

  if (spec.onCopyId) {
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'copy'
    copy.title = 'Copy the node id'
    copy.textContent = '\u29c9'
    copy.addEventListener('click', (event) => {
      event.stopPropagation()
      void spec.onCopyId?.()
    })
    row.appendChild(copy)
  }

  if (spec.onRemove) {
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'remove'
    remove.title = 'Remove'
    remove.textContent = '−'
    remove.addEventListener('click', (event) => {
      event.stopPropagation()
      spec.onRemove?.()
    })
    row.appendChild(remove)
  }

  if (spec.onOpen) row.addEventListener('click', spec.onOpen)
  return row
}

function fillList(box: HTMLElement, rows: RowSpec[], emptyText: string) {
  box.textContent = ''
  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'placeholder pad'
    empty.textContent = emptyText
    box.appendChild(empty)
    return
  }
  for (const spec of rows) {
    if (spec.heading !== undefined) {
      const heading = document.createElement('div')
      heading.className = 'folder-heading'
      heading.textContent = spec.heading
      box.appendChild(heading)
    }
    box.appendChild(buildRow(spec))
  }
}

function renderSelectionList() {
  selectionCount.textContent =
    selectionRows.length === 0
      ? 'Nothing selected'
      : selectionRows.length === 1
        ? '1 layer selected'
        : `${selectionRows.length} layers selected`

  fillList(
    selectionList,
    selectionRows.map((row, index) => ({
      batchIndex: index,
      name: row.name,
      meta: row.type,
      onOpen: () => post({ type: 'pick', id: row.id }),
    })),
    'Select layers on the canvas to see them here.',
  )
}

/** The folders that exist, root first, as the chips and the move control see them. */
function folderNames(): string[] {
  return savedFolders.map((folder) => folder.name)
}

function folderLabel(name: string | null): string {
  return name === null ? 'All' : name === '' ? 'No folder' : name
}

function inScope(entry: SavedEntry): boolean {
  return savedFolder === null || entry.folder === savedFolder
}

function renderFolderChips() {
  folderChips.textContent = ''
  // The root chip is pointless until there is a folder to contrast it with.
  const scopes: (string | null)[] = savedFolders.length > 1 ? [null, ...folderNames()] : []

  for (const scope of scopes) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `folder-chip${scope === savedFolder ? ' current' : ''}`

    const label = document.createElement('span')
    label.textContent = folderLabel(scope)
    chip.appendChild(label)

    const count = document.createElement('span')
    count.className = 'count'
    count.textContent = String(
      scope === null
        ? savedEntries.filter((entry) => entry.missing !== true).length
        : (savedFolders.find((folder) => folder.name === scope)?.count ?? 0),
    )
    chip.appendChild(count)

    chip.addEventListener('click', () => {
      savedFolder = scope
      closeFolderForm()
      renderSaved()
      refreshPrimary()
    })
    folderChips.appendChild(chip)
  }
}

function renderSaved() {
  const visible = savedEntries.filter(inScope)
  const live = visible.filter((entry) => entry.missing !== true).length
  const scopeName = folderLabel(savedFolder)
  savedCount.textContent =
    savedFolder === null ? (live === 1 ? '1 saved' : `${live} saved`) : `${live} in ${scopeName}`

  clearSavedButton.disabled = visible.length === 0
  clearSavedButton.title = savedFolder === null ? 'Remove all saved' : `Empty ${scopeName}`
  // The root is not a folder, so it cannot be renamed or deleted.
  const realFolder = savedFolder !== null && savedFolder !== ''
  editFolderButton.hidden = !realFolder

  renderFolderChips()

  // Only the All view mixes folders, so only it needs headings; ordering by
  // folder is what makes a heading meaningful.
  const showHeadings = savedFolder === null && savedFolders.length > 1
  let grouped: SavedEntry[] = visible
  if (showHeadings) {
    grouped = []
    for (const name of folderNames()) {
      for (const entry of savedEntries) if (entry.folder === name) grouped.push(entry)
    }
  }

  let batchIndex = -1
  let lastHeading: string | null = null
  fillList(
    savedList,
    grouped.map((entry) => {
      if (entry.missing !== true) batchIndex++
      const heading =
        showHeadings && entry.folder !== lastHeading
          ? ((lastHeading = entry.folder), folderLabel(entry.folder))
          : undefined
      return {
        batchIndex: entry.missing === true ? -1 : batchIndex,
        name: entry.name,
        meta: entry.missing === true ? 'deleted' : entry.type,
        missing: entry.missing === true,
        heading,
        folder: entry.folder,
        onOpen: entry.missing === true ? undefined : () => post({ type: 'pick', id: entry.id }),
        onRemove: () => post({ type: 'unsave', ids: [entry.id] }),
        onMove: (folder: string) => post({ type: 'move-saved', ids: [entry.id], folder }),
        // The id is what an API call needs, and it is nowhere on screen — the
        // toast doubles as a way to read it.
        onCopyId: async () => {
          const copied = await copyText(entry.id)
          if (copied) toast(`${entry.id} copied`)
          else toast(`Copy blocked — the id is ${entry.id}`, 'bad')
        },
      }
    }),
    savedFolder === null || savedFolder === ''
      ? 'Select layers, then press Save selection.'
      : `Nothing in ${scopeName} yet. Pick a folder on a row to move it here.`,
  )
}

// -------------------------------------------------------------- folder form
//
// A plugin iframe has no dependable prompt(), and a folder name is one short
// string, so creating and renaming share one inline field.

function closeFolderForm() {
  folderForm.hidden = true
  folderNameInput.value = ''
}

function openFolderForm(mode: 'create' | 'rename') {
  folderFormMode = mode
  folderForm.hidden = false
  folderSaveButton.textContent = mode === 'create' ? 'Create' : 'Rename'
  folderDeleteButton.hidden = mode === 'create'
  folderNameInput.value = mode === 'rename' ? (savedFolder ?? '') : ''
  folderNameInput.placeholder = mode === 'create' ? 'New folder name' : 'New name'
  folderNameInput.focus()
  folderNameInput.select()
}

newFolderButton.addEventListener('click', () => {
  if (!folderForm.hidden && folderFormMode === 'create') closeFolderForm()
  else openFolderForm('create')
})

editFolderButton.addEventListener('click', () => {
  if (!folderForm.hidden && folderFormMode === 'rename') closeFolderForm()
  else openFolderForm('rename')
})

folderForm.addEventListener('submit', (event) => {
  event.preventDefault()
  const name = folderNameInput.value.trim()
  if (name === '') return
  if (folderFormMode === 'create') {
    post({ type: 'create-folder', name })
    // Land in the folder just made, which is almost always where the next save goes.
    savedFolder = name
  } else if (savedFolder !== null && savedFolder !== '') {
    post({ type: 'rename-folder', from: savedFolder, to: name })
    savedFolder = name
  }
  closeFolderForm()
})

// Entries outlive their folder: deleting one returns them to the root.
folderDeleteButton.addEventListener('click', () => {
  if (savedFolder === null || savedFolder === '') return
  post({ type: 'delete-folder', name: savedFolder })
  savedFolder = null
  closeFolderForm()
})

function renderLinkQueue() {
  linkCount.textContent = linkQueue.length === 1 ? '1 link' : `${linkQueue.length} links`
  clearLinksButton.disabled = linkQueue.length === 0

  fillList(
    linkListBox,
    linkQueue.map((entry, index) => ({
      batchIndex: index,
      name: entry.nodeId,
      meta: 'queued',
      hint: entry.url,
      onRemove: () => {
        linkQueue = linkQueue.filter((other) => other !== entry)
        renderLinkQueue()
        refreshPrimary()
      },
    })),
    'Add Figma links one at a time.',
  )
}

function renderActiveList() {
  if (activeSource === 'selection') renderSelectionList()
  else if (activeSource === 'saved') renderSaved()
  else if (activeSource === 'links') renderLinkQueue()
}

/** One button, one meaning per tab: whatever the visible list would extract. */
function refreshPrimary() {
  const liveSaved = savedEntries.filter((entry) => entry.missing !== true && inScope(entry)).length
  let label = 'Click a layer to extract'
  let count = 0

  if (activeSource === 'selection') {
    count = selectionRows.length
    label = count > 0 ? `Extract ${count} selected` : 'Nothing selected'
  } else if (activeSource === 'saved') {
    count = liveSaved
    label =
      count === 0
        ? 'Nothing saved'
        : savedFolder === null || savedFolder === ''
          ? `Extract ${count} saved`
          : `Extract ${count} in ${savedFolder}`
  } else if (activeSource === 'links') {
    count = linkQueue.length
    label = count > 0 ? `Extract ${count} links` : 'No links queued'
  }

  primaryAction.textContent = label
  primaryAction.disabled = activeSource === 'tree' || count === 0

  saveSelectionButton.disabled = selectedIds.length === 0
  miniSaveButton.disabled = selectedIds.length === 0
  miniSaveButton.textContent = selectedIds.length > 1 ? `Save ${selectedIds.length}` : 'Save'
  const into = savedFolder === null || savedFolder === '' ? '' : ` to ${savedFolder}`
  saveSelectionButton.textContent =
    (selectedIds.length > 1 ? `Save ${selectedIds.length} selected` : 'Save selection') + into
}

function addLink() {
  const raw = urlInput.value
  if (raw.trim() === '') return
  const parsed = parseLink(raw)
  if (!parsed) {
    setStatus('Not a Figma link with a node-id. Use Copy link to selection in Figma.')
    return
  }
  if (linkQueue.some((entry) => entry.nodeId === parsed.nodeId)) {
    setStatus(`${parsed.nodeId} is already queued.`)
    urlInput.value = ''
    return
  }
  linkQueue.push(parsed)
  urlInput.value = ''
  setStatus('')
  renderLinkQueue()
  refreshPrimary()
}

addLinkForm.addEventListener('submit', (event) => {
  event.preventDefault()
  addLink()
})

clearLinksButton.addEventListener('click', () => {
  linkQueue = []
  renderLinkQueue()
  refreshPrimary()
})

relayToggle.addEventListener('change', () => {
  if (relayToggle.checked) bridge.connect()
  else bridge.disconnect()
})

type View = 'work' | 'relay' | 'auth'

let view: View = 'auth'

// ------------------------------------------------------------------ minimise
//
// The panel opens at 1180x760, which covers most of the canvas — awkward when
// the next thing you want to do is pick a layer. Minimised it is a 340x40 strip:
// the socket stays up, the selection keeps arriving, and the name of whatever
// you click shows in the bar, so you can line up a selection and then restore.

// Mirrors MAX_SAVED in the main thread; only used to word the "set is full"
// message, which is why it is not worth a round trip.
const MAX_SAVED_ENTRIES = 100

let minimised = false
// Its own object URL, revoked as it is replaced: one per canvas click otherwise
// leaks for as long as the panel is open.
let thumbUrl: string | null = null

function showThumb(png: Uint8Array | null) {
  if (thumbUrl) URL.revokeObjectURL(thumbUrl)
  thumbUrl = null
  if (!png) {
    miniThumb.hidden = true
    miniThumb.removeAttribute('src')
    miniPlaceholder.hidden = false
    return
  }
  thumbUrl = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }))
  miniThumb.src = thumbUrl
  miniThumb.hidden = false
  miniPlaceholder.hidden = true
}

function setMinimised(on: boolean) {
  if (minimised === on) return
  minimised = on
  document.body.classList.toggle('mini', on)
  minimiseButton.textContent = on ? '\u2922' : '\u2013'
  // The picture belongs to the strip; restoring shows the real preview instead.
  if (!on) showThumb(null)
  minimiseButton.title = on ? 'Restore the panel' : 'Minimise — clears the canvas so you can select'
  post({ type: 'minimise', on })
}

minimiseButton.addEventListener('click', () => setMinimised(!minimised))

// The strip's own save: the reason to minimise is to go and pick something, so
// keeping it means not having to restore just to save what you found.
miniSaveButton.addEventListener('click', (event) => {
  event.stopPropagation()
  post({ type: 'save-selection', folder: savedFolder ?? '' })
})

function setView(next: View) {
  view = next
  if (next === 'auth') refreshAuthPage()
  workspace.hidden = next !== 'work'
  relayPage.hidden = next !== 'relay'
  authPage.hidden = next !== 'auth'
  footbar.hidden = next !== 'work'
  // The gate is a gate: with no session there is nothing behind it to reach, so
  // the chrome that would let someone step around it goes away too.
  topbar.hidden = next === 'auth'
  relayPageToggle.textContent = next === 'relay' ? 'Close' : 'Relay'
  if (next === 'relay') {
    relayPage.scrollTop = 0
    refreshRelayPage()
    refreshApi()
    wireInstaller()
    void loadHealth()
  }
}

relayPageToggle.addEventListener('click', () => setView(view === 'relay' ? 'work' : 'relay'))

// While minimised the strip itself restores: a 340px bar is an easier target
// than one 24px button, and there is nothing else on it to click.
topbar.addEventListener('click', (event) => {
  if (!minimised) return
  const target = event.target as HTMLElement
  if (target.closest('#minimise') || target.closest('#mini-save')) return
  setMinimised(false)
})

// -------------------------------------------------------------- relay page

/** Chips need to stay narrow, and the host is the part that distinguishes them. */
function shortAddress(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'localhost' ? `localhost:${parsed.port || '80'}` : parsed.hostname
  } catch {
    return url
  }
}

const STATE_TEXT: Record<BridgeStatus, string> = {
  off: 'Disconnected',
  connecting: 'Connecting…',
  open: 'Connected',
  retrying: 'Unreachable, retrying',
}

function fact(label: string, value: string) {
  const key = document.createElement('dt')
  key.textContent = label
  const val = document.createElement('dd')
  val.textContent = value
  pageFacts.appendChild(key)
  pageFacts.appendChild(val)
}

function relayLabel(url: string): string {
  if (url === LOCAL_RELAY_URL) return 'Local'
  if (url === HOSTED_RELAY_URL) return 'Hosted'
  return shortAddress(url)
}

/**
 * One list of relays rather than two overlapping ones: the two this build knows
 * about, plus any other address used before. The one in use is shown but not
 * offered, and an address this build does not know can be forgotten.
 */
function renderRelayChoices() {
  const known = [LOCAL_RELAY_URL, HOSTED_RELAY_URL]
  const remembered = relayProfiles.map((entry) => entry.url).filter((url) => known.indexOf(url) === -1)
  const unique = [...known, ...remembered].filter((url, index, all) => all.indexOf(url) === index)

  pageRelays.textContent = ''
  for (const url of unique) {
    const current = url === relayUrl
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `installer-dir${current ? ' current' : ''}`
    chip.title = url
    chip.disabled = current

    const label = document.createElement('span')
    label.textContent = current ? `${relayLabel(url)} — in use` : relayLabel(url)
    chip.appendChild(label)

    if (!current) {
      chip.addEventListener('click', () => {
        const saved = relayProfiles.find((entry) => entry.url === url)
        if (saved) {
          // Used before, so its token is already known: switch outright.
          saveRelaySettings(saved.url, saved.token)
          return
        }
        pageUrl.value = url
        pageToken.value = ''
        pageSettingsStatus.className = 'subtitle'
        pageSettingsStatus.textContent = needsAccount(url)
          ? 'Save and reconnect, then sign in — the plugin asks for an account on a hosted relay.'
          : 'Save and reconnect to use the local relay.'
      })
    }

    if (known.indexOf(url) === -1) {
      const forget = document.createElement('button')
      forget.type = 'button'
      forget.className = 'forget'
      forget.title = 'Forget this relay'
      forget.textContent = '\u00d7'
      forget.addEventListener('click', (event) => {
        event.stopPropagation()
        post({ type: 'forget-relay', url })
      })
      chip.appendChild(forget)
    }

    pageRelays.appendChild(chip)
  }
}

function refreshRelayPage() {
  const hosted = relayHasAccounts()

  pageDot.className = `dot ${relayState}`
  pageState.textContent = STATE_TEXT[relayState]
  pageUrl.value = relayUrl
  // A changed token goes back behind dots; leaving the old one revealed after a
  // sign-in would show a credential nobody asked to see again.
  if (pageToken.value !== relayToken) revealToken(false)
  pageToken.value = relayToken
  pageTokenShow.disabled = relayToken === ''
  pageTokenCopy.disabled = relayToken === ''
  pageSettingsStatus.className = 'subtitle'
  pageSettingsStatus.textContent =
    relayToken === '' && hosted ? 'This relay needs an account. Press Sign in above.' : ''

  // A local relay has no accounts, so the whole card is about a hosted one.
  const signedIn = hosted && relayToken !== ''
  pageAccount.textContent = signedIn ? relayEmail || 'signed in' : hosted ? 'not signed in' : 'no account needed'
  pageSignOut.hidden = !signedIn
  pageSignIn.hidden = !hosted
  pageSignIn.textContent = signedIn ? 'Switch account' : 'Sign in'
  pageAccountNote.textContent = hosted
    ? signedIn
      ? 'Each account gets its own room, so this token reaches your designs and nobody else\u2019s.'
      : 'Email and password, typed here. The relay answers with a token and the plugin stores it.'
    : 'A local relay binds to 127.0.0.1, so it asks for nothing.'

  renderRelayChoices()

  // The field is only for a token obtained elsewhere; signing in is the normal path.
  pageTokenHint.textContent = hosted
    ? 'Set by signing in above. Paste one here only if you already have it.'
    : 'A local relay has no accounts, so it needs no token.'

  // Writing files needs a filesystem, which a Worker does not have: /fs and
  // /skill/install answer 501 there, so the browser is not offered at all.
  installerBox.hidden = hosted
  skillLocalOnly.hidden = !hosted

  // Samples are built from the address in use, so they are always runnable.
  pageHealthCommand.textContent = `curl -s ${httpBase()}/health`

  pageFacts.textContent = ''
  fact('Socket', relayUrl)
  fact('HTTP', httpBase())
  fact(
    'Token',
    relayToken === ''
      ? hosted
        ? 'none — this relay needs one'
        : 'none, not needed'
      : relayState === 'open'
        ? 'set, sent with every request'
        : 'set',
  )
}

/** Health is the relay's own view of things, which can differ from ours. */
async function loadHealth() {
  if (relayState !== 'open') return
  const stateWhenAsked = relayUrl
  try {
    const response = await fetch(`${httpBase()}/health`, { headers: authHeaders() })
    const data = (await response.json()) as Record<string, unknown>
    // The answer describes the relay we asked; drop it if we have since moved.
    if (relayUrl !== stateWhenAsked || relayState !== 'open') return
    if (typeof data.signedIn === 'string') fact('Relay says signed in as', data.signedIn)
    fact('Plugin seen by relay', data.pluginConnected === true ? 'yes' : 'no')
    fact('Token required', data.tokenRequired === true ? 'yes' : 'no')
    fact('Requests in flight', String(data.pendingRequests ?? 0))
    fact('Event listeners', String(data.sseClients ?? 0))
    fact('Cached images', String(data.assets ?? 0))
  } catch {
    fact('Health check', 'no answer over HTTP')
  }
}

/**
 * The token is the one thing here worth carrying elsewhere — into a terminal, a
 * CI secret, an agent's config — so it can be read and copied rather than only
 * pasted in. It stays behind dots until asked for, since the panel sits open on
 * a screen that other people can be looking at.
 */
function revealToken(shown: boolean) {
  pageToken.type = shown ? 'text' : 'password'
  pageTokenShow.textContent = shown ? 'Hide' : 'Show'
  pageTokenShow.title = shown ? 'Hide the token' : 'Show the token'
}

pageTokenShow.addEventListener('click', () => revealToken(pageToken.type === 'password'))

pageTokenCopy.addEventListener('click', async () => {
  if (pageToken.value === '') return
  const copied = await copyText(pageToken.value)
  pageSettingsStatus.className = copied ? 'ok-text' : 'bad-text'
  pageSettingsStatus.textContent = copied
    ? 'Token copied. It is a credential — treat it like a password.'
    : 'Copy blocked — press Show, then select the text and press Cmd+C.'
})

function saveRelaySettings(url: string, token: string) {
  if (!/^wss?:\/\//.test(url)) {
    pageSettingsStatus.className = 'bad-text'
    pageSettingsStatus.textContent = 'The address must start with ws:// or wss://'
    return
  }
  pageSettingsStatus.className = 'subtitle'
  pageSettingsStatus.textContent = 'Saved. Reconnecting…'
  post({ type: 'save-settings', url, token })
}

pageSave.addEventListener('click', () =>
  saveRelaySettings(pageUrl.value.trim() || DEFAULT_RELAY_URL, pageToken.value.trim()),
)
pageDefaults.addEventListener('click', () => saveRelaySettings(LOCAL_RELAY_URL, ''))
// ----------------------------------------------------------------- accounts
//
// A hosted relay has accounts; signing in happens here rather than in a browser,
// so the whole path from opening the plugin to a working API is one form. The
// password is posted to the relay over HTTPS and never stored — only the token
// it returns is, in clientStorage, which is per user and outside the project.

type SessionState = 'unknown' | 'signed-out' | 'signed-in' | 'open-relay'
type StepState = 'idle' | 'pending' | 'done' | 'failed'

const STEP_LABELS = ['Account', 'Relay socket', 'HTTP API']
const STEP_MARK: Record<StepState, string> = { idle: '\u00b7', pending: '\u2026', done: '\u2713', failed: '\u00d7' }

// Long enough for a Durable Object to spin up on a cold hosted relay.
const READY_TIMEOUT_MS = 20_000

let session: SessionState = 'unknown'
let authMode: 'login' | 'register' = 'login'
let authBusy = false

// Whether the relay in use has accounts. The address is a good guess — a
// deployed relay is `wss://`, a local one is not — but only the relay knows, and
// a remote one reached over plain `ws://` would be guessed wrong.
let relayAccounts: 'unknown' | 'yes' | 'no' = 'unknown'

function relayHasAccounts(): boolean {
  return relayAccounts === 'yes' || (relayAccounts === 'unknown' && needsAccount(relayUrl))
}

/** `hosted` is the hosted relay's own word for "this one has accounts". */
async function probeAccounts(): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const response = await fetch(`${httpBase()}/health`)
    if (!response.ok) return 'unknown'
    const data = (await response.json()) as { hosted?: unknown }
    return data.hosted === true ? 'yes' : 'no'
  } catch {
    // Not running yet, or blocked by the manifest. Either way, not an answer.
    return 'unknown'
  }
}

function authMessage(text: string, tone: 'plain' | 'good' | 'bad' = 'plain') {
  authMessageLine.textContent = text
  authMessageLine.className =
    tone === 'good' ? 'ok-text auth-message' : tone === 'bad' ? 'bad-text auth-message' : 'subtitle auth-message'
}

function setSteps(states: StepState[]) {
  authSteps.hidden = false
  authSteps.textContent = ''
  states.forEach((state, index) => {
    const row = document.createElement('li')
    row.className = state === 'done' ? 'done' : state === 'failed' ? 'failed' : ''
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = STEP_MARK[state]
    const label = document.createElement('span')
    label.textContent = STEP_LABELS[index]
    row.appendChild(mark)
    row.appendChild(label)
    authSteps.appendChild(row)
  })
}

function setAuthMode(next: 'login' | 'register') {
  authMode = next
  for (const tab of Array.from(authTabs.querySelectorAll('[data-auth]'))) {
    tab.className = (tab as HTMLElement).dataset.auth === next ? 'seg active' : 'seg'
  }
  authSubmit.textContent = next === 'register' ? 'Create account' : 'Sign in'
  // The right hint lets a password manager offer to save a new password rather
  // than to fill the old one.
  authPassword.autocomplete = next === 'register' ? 'new-password' : 'current-password'
  authPassword.placeholder = next === 'register' ? 'At least 10 characters' : 'Your password'
  authLead.textContent =
    next === 'register'
      ? 'Create an account on the relay. The socket and the HTTP API come up on their own straight after.'
      : 'Sign in to your relay account. The socket and the HTTP API come up on their own straight after.'
}

function refreshAuthPage() {
  authRelayLine.textContent = `Relay: ${shortAddress(relayUrl)}`
  authLocalButton.hidden = relayUrl === LOCAL_RELAY_URL
  // The boot line stands in for the form until the stored settings have been
  // read; after that the form is the page.
  authForm.hidden = !settingsLoaded
  authBootLine.hidden = settingsLoaded
}

/**
 * Ends the session locally and re-opens the gate. The token is dropped from
 * storage as well, so a reopened plugin does not retry a credential that the
 * relay has already refused.
 */
function sessionExpired(reason: string) {
  // A relay known to have no accounts cannot be signed into, so a refusal there
  // is a misconfigured token rather than a session to renew.
  if (session === 'signed-out' || relayAccounts === 'no') return
  session = 'signed-out'
  relayToken = ''
  relayEmail = ''
  bridge.disconnect()
  post({ type: 'sign-out' })
  setAuthMode('login')
  setSteps(['failed', 'idle', 'idle'])
  authMessage(reason, 'bad')
  setView('auth')
}

/** Confirms a stored token still resolves to an account, and learns its email. */
async function verifySession(): Promise<void> {
  const token = relayToken
  const base = httpBase()
  if (token === '') return
  try {
    const response = await fetch(`${base}/auth/me`, { headers: { 'x-relay-token': token } })
    // The answer describes the relay we asked; drop it if we have since moved.
    if (relayToken !== token || httpBase() !== base) return
    if (response.status === 401) {
      sessionExpired('That session has expired. Sign in again.')
      return
    }
    if (!response.ok) return
    const account = (await response.json()) as { email?: string }
    if (typeof account.email === 'string' && account.email !== relayEmail) {
      // Stored so the next open can name the account without a request.
      post({ type: 'save-settings', url: relayUrl, token, email: account.email })
    }
  } catch {
    // Offline, or blocked by the manifest: the socket's own retry loop says more
    // about that than a failed probe would, and a token is not wrong for it.
  }
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  if (condition()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const timer = setInterval(() => {
      if (condition()) {
        clearInterval(timer)
        resolve(true)
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        resolve(false)
      }
    }, 250)
  })
}

/** One HTTP call with the stored token, which is what an agent would do too. */
async function checkApi(): Promise<boolean> {
  try {
    const response = await fetch(`${httpBase()}/health`, { headers: authHeaders() })
    if (response.status === 401) {
      sessionExpired('The relay rejected that token. Sign in again.')
      return false
    }
    return response.ok
  } catch {
    return false
  }
}

/**
 * Everything after a successful sign-in: the socket, then one real HTTP request
 * over it, then the workspace. A socket that has not come up yet is not a reason
 * to hold the gate shut — the session is real and the bridge keeps retrying.
 */
async function finishConnecting() {
  setSteps(['done', 'pending', 'idle'])
  const opened = await waitFor(() => relayState === 'open', READY_TIMEOUT_MS)
  if (!opened) {
    setSteps(['done', 'failed', 'idle'])
    authMessage('Signed in, but the socket has not come up. It keeps retrying — the Relay page shows why.', 'bad')
    setStatus('Signed in. The relay socket is still trying to connect — see the Relay page.')
    setView('work')
    return
  }

  setSteps(['done', 'done', 'pending'])
  const ready = await checkApi()
  if (session === 'signed-out') return
  setSteps(['done', 'done', ready ? 'done' : 'failed'])
  setStatus(
    ready
      ? `Ready. Signed in as ${relayEmail || 'your account'}; the API is answering at ${httpBase()}.`
      : 'Signed in and connected, but the HTTP API did not answer — see the Relay page.',
  )
  setView('work')
}

async function submitAuth() {
  if (authBusy) return
  const email = authEmail.value.trim()
  const password = authPassword.value
  if (email === '' || password === '') {
    authMessage('Enter an email and a password.', 'bad')
    return
  }
  if (authMode === 'register' && password.length < 10) {
    authMessage('Use a password of at least 10 characters.', 'bad')
    return
  }

  // The gate only opens for a relay with accounts, so that is the one to ask.
  const target = relayUrl
  authBusy = true
  authSubmit.disabled = true
  setSteps(['pending', 'idle', 'idle'])
  authMessage(authMode === 'register' ? 'Creating the account\u2026' : 'Signing in\u2026')

  try {
    const response = await fetch(`${httpOf(target)}/auth/${authMode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = (await response.json()) as { token?: string; email?: string; error?: string }
    if (!response.ok || typeof data.token !== 'string') {
      setSteps(['failed', 'idle', 'idle'])
      authMessage(data.error ?? `The relay refused that (${response.status}).`, 'bad')
      return
    }

    // Held no longer than it takes to post it.
    authPassword.value = ''
    session = 'signed-in'
    relayToggle.checked = true
    authMessage(`Signed in as ${data.email ?? email}.`, 'good')
    // Storing the token is what starts the socket: the main thread echoes the
    // settings back, and that is the same path a reopened plugin takes.
    post({ type: 'save-settings', url: target, token: data.token, email: data.email ?? email })
    await finishConnecting()
  } catch (error) {
    setSteps(['failed', 'idle', 'idle'])
    authMessage(
      `Could not reach ${httpOf(target)}: ${error instanceof Error ? error.message : String(error)}`,
      'bad',
    )
  } finally {
    authBusy = false
    authSubmit.disabled = false
  }
}

async function signOut() {
  const base = httpBase()
  const token = relayToken
  session = 'signed-out'
  relayEmail = ''
  relayToken = ''
  bridge.disconnect()
  post({ type: 'sign-out' })
  setAuthMode('login')
  authSteps.hidden = true
  authMessage('Signed out.')
  setView('auth')
  // Best effort: the token is already gone from this machine either way.
  try {
    await fetch(`${base}/auth/revoke`, { method: 'POST', headers: { 'x-relay-token': token } })
  } catch {
    // A token nobody holds is harmless until it is revoked on next sign-in.
  }
}

authTabs.addEventListener('click', (event) => {
  const tab = (event.target as HTMLElement).closest('[data-auth]') as HTMLElement | null
  if (tab?.dataset.auth === 'login' || tab?.dataset.auth === 'register') {
    setAuthMode(tab.dataset.auth)
    authMessage('')
    authSteps.hidden = true
  }
})

authForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void submitAuth()
})

// The escape hatch from the gate: a local relay has no accounts to sign in to.
authLocalButton.addEventListener('click', () => {
  authMessage('Pointing at the local relay. Start it with npm run relay.')
  post({ type: 'save-settings', url: LOCAL_RELAY_URL, token: '', email: '' })
})

pageSignIn.addEventListener('click', () => {
  setAuthMode('login')
  authSteps.hidden = true
  authMessage('')
  setView('auth')
})

pageSignOut.addEventListener('click', () => void signOut())

/**
 * Decides what a set of stored settings means: no accounts, no session, or a
 * session to resume. Every path into a connection goes through here, so opening
 * the plugin, signing in and switching relays all behave the same way.
 */
function applySettings(first: boolean, changed: boolean) {
  // A new address is a new relay; what the last one said about accounts does not
  // carry over, so it goes back to the guess the address supports.
  if (first || changed) relayAccounts = needsAccount(relayUrl) ? 'yes' : 'unknown'

  if (relayToken !== '') {
    // A stored token is trusted enough to connect on: the socket and /auth/me
    // both report a bad one, and the fast path is worth more than a round trip.
    session = 'signed-in'
    if (first || changed) {
      connect(first)
      void verifySession()
    }
    if (view === 'auth' && !authBusy) setView('work')
    return
  }

  // No credential. A relay with accounts means the gate; one without means there
  // is nothing to ask for, so connect straight away.
  if (relayAccounts === 'yes') {
    openGate()
    return
  }
  if (first || changed) void decideWithoutToken(first)
}

function connect(first: boolean) {
  if (!relayToggle.checked) return
  if (!first) bridge.disconnect()
  bridge.connect()
}

function openGate() {
  if (session !== 'signed-out') {
    session = 'signed-out'
    bridge.disconnect()
  }
  setView('auth')
}

/** Only the relay knows whether it has accounts, so a tokenless one is asked. */
async function decideWithoutToken(first: boolean) {
  const stateWhenAsked = relayUrl
  const answer = await probeAccounts()
  // The answer describes the relay we asked, and only while it is still tokenless.
  if (relayUrl !== stateWhenAsked || relayToken !== '') return
  relayAccounts = answer
  if (answer === 'yes') {
    openGate()
    return
  }
  session = 'open-relay'
  connect(first)
  if (view === 'auth') setView('work')
  if (view === 'relay') refreshRelayPage()
}

// ------------------------------------------------------------- api browser
//
// Every endpoint, its request and its response, in the place the token and the
// address already live. The catalogue is shared with the docs so the two cannot
// disagree, and Send fires the real request rather than describing one: an agent
// making the same call gets the same answer.

const API_PLACEHOLDER_NODE = '21:10314'

let apiBuilt = false
// Each open row knows how to redraw the parts that depend on the address, the
// token or the selected node, so switching relays does not stale the page.
const apiRefreshers: (() => void)[] = []

function apiNodeId(): string {
  return apiNode.value.trim() || selectedId || API_PLACEHOLDER_NODE
}

/** Fills :id and :nodeId. The asset route needs the colon percent-encoded. */
function resolvePath(endpoint: Endpoint): string {
  const node = apiNodeId()
  return endpoint.path
    .replace(':nodeId', encodeURIComponent(node))
    .replace(':id', encodeURIComponent(node))
}

/**
 * A single extraction is thousands of characters of generated code, which buries
 * the shape of the answer. Long strings are replaced by their length so the keys
 * stay readable; nothing else is altered.
 */
function summarise(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 220 ? `… (${value.length} chars)` : value
  if (Array.isArray(value)) return value.map(summarise)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = summarise(entry)
    return out
  }
  return value
}

function pre(text: string, extra = ''): HTMLPreElement {
  const block = document.createElement('pre')
  block.className = `doc-code${extra ? ' ' + extra : ''}`
  block.textContent = text
  return block
}

function apiLabel(text: string): HTMLParagraphElement {
  const label = document.createElement('p')
  label.className = 'api-label'
  label.textContent = text
  return label
}

function buildEndpoint(endpoint: Endpoint): HTMLDivElement {
  const item = document.createElement('div')
  item.className = 'api-item'

  const head = document.createElement('button')
  head.type = 'button'
  head.className = 'api-head'

  const method = document.createElement('span')
  method.className = `api-method ${endpoint.method.toLowerCase()}`
  method.textContent = endpoint.method
  const path = document.createElement('span')
  path.className = 'api-path'
  path.textContent = endpoint.path
  const summary = document.createElement('span')
  summary.className = 'api-summary'
  summary.textContent = endpoint.summary
  const lock = document.createElement('span')
  lock.className = 'api-lock'
  lock.textContent = endpoint.auth === 'required' ? 'token' : endpoint.auth === 'optional' ? 'token optional' : 'public'
  head.appendChild(method)
  head.appendChild(path)
  head.appendChild(summary)
  head.appendChild(lock)

  const panel = document.createElement('div')
  panel.className = 'api-panel'
  panel.hidden = true
  head.addEventListener('click', () => {
    panel.hidden = !panel.hidden
  })

  // ---- request
  panel.appendChild(apiLabel('Request'))

  const placed: [string, string, string][] = [
    ...(endpoint.params ?? []).map((param) => [`:${param.name}`, 'path', param.note] as [string, string, string]),
    ...(endpoint.query ?? []).map((param) => [`?${param.name}=`, 'query', param.note] as [string, string, string]),
  ]
  if (placed.length > 0) {
    const params = document.createElement('dl')
    params.className = 'api-fields'
    for (const [label, kind, note] of placed) {
      const name = document.createElement('dt')
      const code = document.createElement('code')
      code.textContent = label
      name.appendChild(code)
      const type = document.createElement('dd')
      type.textContent = kind
      const detail = document.createElement('dd')
      detail.className = 'api-field-note'
      detail.textContent = note
      params.appendChild(name)
      params.appendChild(type)
      params.appendChild(detail)
    }
    panel.appendChild(params)
  }

  const headerBlock = pre('')
  panel.appendChild(headerBlock)

  let bodyInput: HTMLTextAreaElement | null = null
  if (endpoint.body) {
    const fields = document.createElement('dl')
    fields.className = 'api-fields'
    for (const field of endpoint.body.fields) {
      const name = document.createElement('dt')
      const code = document.createElement('code')
      code.textContent = field.name
      name.appendChild(code)
      const type = document.createElement('dd')
      const typeCode = document.createElement('code')
      typeCode.textContent = field.type
      type.appendChild(typeCode)
      const note = document.createElement('dd')
      note.className = 'api-field-note'
      note.textContent = field.note
      fields.appendChild(name)
      fields.appendChild(type)
      fields.appendChild(note)
    }
    panel.appendChild(fields)

    bodyInput = document.createElement('textarea')
    bodyInput.className = 'api-body-input'
    bodyInput.spellcheck = false
    bodyInput.value = JSON.stringify(endpoint.body.examples[0].value, null, 2)

    const examples = document.createElement('div')
    examples.className = 'api-examples'
    for (const example of endpoint.body.examples) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'api-example'
      chip.textContent = example.label
      chip.addEventListener('click', () => {
        if (!bodyInput) return
        bodyInput.value = JSON.stringify(example.value, null, 2)
        refresh()
      })
      examples.appendChild(chip)
    }
    panel.appendChild(examples)
    panel.appendChild(bodyInput)
    bodyInput.addEventListener('input', () => refresh())
  }

  // ---- actions
  const actions = document.createElement('div')
  actions.className = 'card-row'
  const send = document.createElement('button')
  send.type = 'button'
  send.className = 'button primary'
  send.textContent = 'Send'
  const copyCurl = document.createElement('button')
  copyCurl.type = 'button'
  copyCurl.className = 'button secondary'
  copyCurl.textContent = 'Copy curl'
  const spacer = document.createElement('span')
  spacer.className = 'spacer'
  const state = document.createElement('span')
  // The tone class changes with every result, so the identity class is separate.
  const say = (text: string, tone: 'plain' | 'good' | 'bad' = 'plain') => {
    state.className = `api-state ${tone === 'good' ? 'ok-text' : tone === 'bad' ? 'bad-text' : 'subtitle'}`
    state.textContent = text
  }
  say('')
  actions.appendChild(send)
  actions.appendChild(copyCurl)
  actions.appendChild(spacer)
  actions.appendChild(state)
  panel.appendChild(actions)

  const curlBlock = pre('')
  panel.appendChild(curlBlock)

  // ---- response
  panel.appendChild(apiLabel('Response'))
  const responseBlock = pre(
    endpoint.response ? JSON.stringify(endpoint.response, null, 2) : '(no example)',
  )
  panel.appendChild(responseBlock)
  if (endpoint.responseNote) {
    const note = document.createElement('p')
    note.className = 'subtitle'
    note.style.margin = '0'
    note.textContent = endpoint.responseNote
    panel.appendChild(note)
  }

  // An SSE stream never completes, so firing it from here would hang the panel.
  if (endpoint.stream) {
    send.disabled = true
    send.title = 'A stream stays open; follow it with curl -N instead.'
  }

  function refresh() {
    const headers = requestHeaders(endpoint)
    headerBlock.textContent = `${endpoint.method} ${resolvePath(endpoint)}\n${
      headers.length > 0 ? headers.join('\n') : '(no headers needed)'
    }`
    curlBlock.textContent = curlFor(endpoint, {
      base: httpBase(),
      path: resolvePath(endpoint),
      body: bodyInput ? bodyInput.value.replace(/\s+/g, ' ').trim() : '',
      token: relayToken,
    })
  }

  copyCurl.addEventListener('click', async () => {
    const copied = await copyText(curlBlock.textContent ?? '')
    say(copied ? 'curl copied' : 'copy blocked — select the text', copied ? 'good' : 'bad')
  })

  send.addEventListener('click', async () => {
    send.disabled = true
    say('sending…')
    const started = Date.now()
    try {
      const response = await fetch(`${httpBase()}${resolvePath(endpoint)}`, {
        method: endpoint.method,
        headers: {
          ...(endpoint.auth === 'none' ? {} : authHeaders()),
          ...(bodyInput ? { 'content-type': 'application/json' } : {}),
        },
        body: bodyInput ? bodyInput.value : undefined,
      })
      const ms = Date.now() - started
      say(`${response.status} ${response.ok ? 'OK' : 'failed'} · ${ms}ms`, response.ok ? 'good' : 'bad')

      if (endpoint.binary && response.ok) {
        const bytes = (await response.arrayBuffer()).byteLength
        responseBlock.textContent = `${response.headers.get('content-type')}, ${bytes} bytes\ncache-control: ${response.headers.get('cache-control')}`
      } else {
        const text = await response.text()
        try {
          responseBlock.textContent = JSON.stringify(summarise(JSON.parse(text)), null, 2)
        } catch {
          responseBlock.textContent = text
        }
      }
      // A 401 here means the session, not the endpoint.
      if (response.status === 401 && endpoint.auth === 'required') {
        sessionExpired('The relay rejected that token. Sign in again.')
      }
    } catch (error) {
      say('no answer', 'bad')
      responseBlock.textContent = `Could not reach ${httpBase()}: ${
        error instanceof Error ? error.message : String(error)
      }`
    } finally {
      send.disabled = Boolean(endpoint.stream)
    }
  })

  apiRefreshers.push(refresh)
  refresh()

  item.appendChild(head)
  item.appendChild(panel)
  return item
}

/** Built once: rebuilding would throw away typed bodies and open rows. */
function buildApiList() {
  if (apiBuilt) return
  apiBuilt = true
  for (const group of apiGroups) {
    const heading = document.createElement('p')
    heading.className = 'api-group'
    const title = document.createElement('strong')
    title.textContent = group.title
    heading.appendChild(title)
    heading.appendChild(document.createTextNode(` — ${group.note}`))
    apiList.appendChild(heading)
    for (const endpoint of group.endpoints) apiList.appendChild(buildEndpoint(endpoint))
  }
}

function refreshApi() {
  buildApiList()
  if (apiNode.value.trim() === '') apiNode.placeholder = selectedId ?? API_PLACEHOLDER_NODE
  for (const refresh of apiRefreshers) refresh()
}

apiNode.addEventListener('input', () => {
  for (const refresh of apiRefreshers) refresh()
})

pageReconnect.addEventListener('click', () => {
  relayToggle.checked = true
  bridge.disconnect()
  bridge.connect()
})

relayPage.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest('[data-copy]') as HTMLElement | null
  if (!button?.dataset.copy) return
  const source = document.getElementById(button.dataset.copy)
  if (!source) return
  const copied = await copyText(source.textContent ?? '')
  pageSettingsStatus.className = copied ? 'ok-text' : 'bad-text'
  pageSettingsStatus.textContent = copied ? 'Copied.' : 'Copy blocked — select the text instead.'
})

// ---------------------------------------------------------------- installer
//
// The panel cannot touch the filesystem, so browsing and writing both go through
// the relay. Only directories are listed, which is all that choosing a project
// root needs.

type FsListing = {
  path: string
  parent: string | null
  home: string
  directories: string[]
  isProject: boolean
  hasSkill: boolean
}

let browsePath = ''
// The markup is static now, so wiring twice would double every listener.
let installerWired = false

function wireInstaller() {
  if (installerWired) return
  const maybePathInput = document.getElementById('skill-path') as HTMLInputElement | null
  if (!maybePathInput) return
  installerWired = true
  const pathInput = maybePathInput
  const upButton = document.getElementById('skill-up') as HTMLButtonElement
  const goButton = document.getElementById('skill-go') as HTMLButtonElement
  const dirsBox = document.getElementById('skill-dirs') as HTMLDivElement
  const statusLine = document.getElementById('skill-status') as HTMLSpanElement
  const installButton = document.getElementById('skill-install') as HTMLButtonElement

  let listing: FsListing | null = null

  function say(text: string, tone: 'plain' | 'good' | 'bad' = 'plain') {
    statusLine.textContent = text
    statusLine.className = tone === 'good' ? 'ok-text' : tone === 'bad' ? 'bad-text' : 'subtitle'
  }

  async function browse(path: string) {
    say('Reading…')
    try {
      const response = await fetch(`${httpBase()}/fs?path=${encodeURIComponent(path)}`, {
        headers: authHeaders(),
      })
      if (response.status === 401) {
        say('The relay rejected the token.', 'bad')
        sessionExpired('The relay rejected that token. Sign in again.')
        return
      }
      const data = (await response.json()) as FsListing & { error?: string }
      if (data.error) {
        say(data.error, 'bad')
        return
      }
      listing = data
      browsePath = data.path
      pathInput.value = data.path
      upButton.disabled = data.parent === null
      dirsBox.textContent = ''
      for (const name of data.directories) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'installer-dir'
        row.textContent = name
        row.addEventListener('click', () => browse(`${data.path}/${name}`))
        dirsBox.appendChild(row)
      }
      if (data.directories.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'placeholder pad'
        empty.textContent = 'No sub-directories here.'
        dirsBox.appendChild(empty)
      }
      const marks: string[] = []
      if (data.isProject) marks.push('looks like a project')
      if (data.hasSkill) marks.push('already has a .claude directory')
      say(marks.length > 0 ? `${marks.join(', ')}.` : 'Choose the project to install into.')
    } catch (error) {
      say(`Could not read that path: ${error instanceof Error ? error.message : String(error)}`, 'bad')
    }
  }

  async function install(force: boolean) {
    if (!listing) return
    installButton.disabled = true
    say(force ? 'Overwriting…' : 'Installing…')
    try {
      const response = await fetch(`${httpBase()}/skill/install`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ directory: browsePath, force }),
      })
      const data = (await response.json()) as {
        written?: string[]
        existing?: string[]
        error?: string
        directory?: string
      }
      if (response.status === 409) {
        say(`Already installed here (${(data.existing ?? []).join(', ')}). Press again to overwrite.`, 'bad')
        installButton.textContent = 'Overwrite'
        installButton.onclick = () => install(true)
        return
      }
      if (!response.ok || data.error) {
        say(data.error ?? `Install failed (${response.status})`, 'bad')
        return
      }
      say(`Installed ${(data.written ?? []).length} files into ${data.directory}.`, 'good')
      installButton.textContent = 'Install here'
      installButton.onclick = () => install(false)
    } catch (error) {
      say(`Install failed: ${error instanceof Error ? error.message : String(error)}`, 'bad')
    } finally {
      installButton.disabled = false
    }
  }

  upButton.addEventListener('click', () => {
    if (listing?.parent) browse(listing.parent)
  })
  goButton.addEventListener('click', () => browse(pathInput.value.trim()))
  pathInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') browse(pathInput.value.trim())
  })
  installButton.addEventListener('click', () => install(false))

  browse(browsePath)
}

window.addEventListener('keydown', (event: KeyboardEvent) => {
  // Escape leaves a page, but there is nothing behind the gate to leave to.
  if (event.key === 'Escape' && view !== 'work' && view !== 'auth') setView('work')
})

clearSavedButton.addEventListener('click', () =>
  post({ type: 'clear-saved', ...(savedFolder === null ? {} : { folder: savedFolder }) }),
)
// Saves land in whichever folder the Saved tab is showing, which is the one the
// user last chose; the button says so.
saveSelectionButton.addEventListener('click', () =>
  post({ type: 'save-selection', folder: savedFolder ?? '' }),
)

primaryAction.addEventListener('click', () => {
  if (activeSource === 'tree') return
  runSource = activeSource
  runResults = []
  primaryAction.disabled = true
  setStatus('Extracting…')
  renderActiveList()
  post({
    type: 'batch',
    source: activeSource === 'links' ? 'urls' : activeSource === 'saved' ? 'saved' : 'selection',
    text: linkQueue.map((entry) => entry.url).join('\n'),
    ...(activeSource === 'saved' && savedFolder !== null ? { folder: savedFolder } : {}),
  })
})

function recordBatchResult(progress: BatchProgress) {
  runResults[progress.index] = progress.ok
    ? { ok: true, text: `${progress.nodeType} · ${progress.layerCount} layers` }
    : { ok: false, text: progress.error ?? 'Failed' }
  renderActiveList()
}

copyCodeButton.addEventListener('click', async () => {
  const copied = await copyText(code[activeCode])
  setStatus(copied ? 'Copied.' : 'Copy blocked — select the text and press Cmd+C.')
})

copyImageButton.addEventListener('click', async () => {
  if (!currentBlob) return
  const copied = await copyImage(currentBlob)
  setStatus(copied ? 'PNG copied.' : 'Image clipboard unavailable here — use Download PNG.')
})

downloadButton.addEventListener('click', () => {
  if (!currentUrl) return
  const link = document.createElement('a')
  link.href = currentUrl
  link.download = fileName(currentName, Number(scaleSelect.value))
  document.body.appendChild(link)
  link.click()
  link.remove()
  setStatus('PNG downloaded.')
})

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data.pluginMessage as FromPlugin | undefined
  if (!msg) return
  switch (msg.type) {
    case 'tree': {
      byId.clear()
      roots = toTreeNodes(msg.rows, 0)
      renderTree()
      if (!selectedId) {
        title.textContent = msg.page
        const count = msg.rows.length === 1 ? '1 top-level layer' : `${msg.rows.length} top-level layers`
        subtitle.textContent = msg.truncated ? `${count} (truncated)` : count
      }
      break
    }
    case 'children': {
      const parent = byId.get(msg.parentId)
      if (!parent) break
      parent.children = toTreeNodes(msg.rows, parent.depth + 1)
      parent.expanded = true
      renderTree()
      if (msg.truncated) setStatus('Child list truncated at 300 rows.')
      break
    }
    case 'selected': {
      selectedIds = msg.ids
      selectionRows = msg.rows
      if (msg.id && msg.id !== selectedId) selectedId = msg.id
      // A new selection invalidates any batch results shown against the old one.
      if (runSource === 'selection') {
        runSource = null
        runResults = []
      }
      renderTree()
      renderActiveList()
      refreshPrimary()
      if (msg.ids.length === 1 && msg.rows.length === 1) {
        // Named as soon as it is picked, rather than when the extraction lands:
        // minimised there is no extraction, and the bar is all there is to read.
        const row = msg.rows[0]
        title.textContent = row.name
        subtitle.textContent = `${row.type} · ${row.width}×${row.height}`
      }
      if (msg.ids.length > 1) {
        // A multi-selection has no single preview, so summarise it instead.
        title.textContent = `${msg.ids.length} layers selected`
        const types = msg.rows.map((row) => row.type)
        const unique = types.filter((entry, index) => types.indexOf(entry) === index)
        subtitle.textContent = `${unique.join(', ')} — open the Selection tab to extract them`
      }
      bridge.event('selection_changed', { ids: msg.ids, count: msg.ids.length, rows: msg.rows })
      break
    }
    case 'res': {
      const entry = pending.get(msg.id)
      if (!entry) break
      pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.data)
      else entry.reject(new Error(msg.error ?? 'Request failed'))
      break
    }
    case 'extract':
      showExtraction(msg)
      break
    case 'batch-progress':
      recordBatchResult(msg)
      setStatus(`${msg.index + 1} of ${msg.total}…`)
      break
    case 'settings': {
      const changed = msg.url !== relayUrl || msg.token !== relayToken
      const first = !settingsLoaded
      settingsLoaded = true
      relayUrl = msg.url
      relayToken = msg.token
      relayEmail = msg.email ?? ''
      relayProfiles = msg.profiles ?? []
      applySettings(first, changed)
      if (view === 'relay') {
        refreshRelayPage()
        refreshApi()
      }
      if (view === 'auth') refreshAuthPage()
      break
    }
    case 'thumb':
      showThumb(msg.png)
      break
    case 'save-result': {
      const said = saveMessage(msg)
      toast(said.text, said.tone)
      setStatus(said.text)
      break
    }
    case 'saved':
      savedEntries = msg.entries
      savedFolders = msg.folders
      // A folder can vanish under us — deleted here, or by an API caller.
      if (savedFolder !== null && !savedFolders.some((folder) => folder.name === savedFolder)) {
        savedFolder = null
      }
      renderActiveList()
      refreshPrimary()
      break
    case 'batch-done':
      setStatus(
        msg.okCount === msg.total
          ? `Extracted all ${msg.total}.`
          : `Extracted ${msg.okCount} of ${msg.total} — see the rows for what failed.`,
      )
      refreshPrimary()
      break
    case 'busy':
      setStatus('Extracting…')
      break
    case 'error':
      setStatus(`Failed: ${msg.message}`)
      break
  }
})

// Figma may reopen the window at a size the user dragged it to previously.
let resizeTimer: number | undefined
window.addEventListener('resize', () => {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (minimised) return
    post({ type: 'resize', width: window.innerWidth, height: window.innerHeight })
  }, 400)
})

setAuthMode('login')
post({ type: 'ready' })
renderActiveList()
refreshPrimary()
refreshCodeBox()
// The connection waits for the stored relay settings, which arrive right after.

