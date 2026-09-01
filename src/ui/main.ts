// UI thread: DOM and network available, no figma API.
import './style.css'
import { createBridge, type BridgeStatus } from './bridge'
import { highlightLines } from './highlight'
import { loneDataImage, renderMarkdown, scrubBase64 } from './markdown'
import { groups as apiGroups, curlFor, requestHeaders, type Endpoint } from '../../shared/endpoints.mjs'
import { AGENT_URL, DEFAULT_RELAY_URL, HOSTED_RELAY_URL } from '../relays'

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
  | { type: 'agent-settings'; url: string; token: string; cwd: string; harness: string; sessionId: string }
  | PluginResponse
  | Selected
  | BatchProgress
  | { type: 'batch-done'; total: number; okCount: number }
  | { type: 'saved'; folders: FolderCount[]; entries: SavedEntry[] }
  | { type: 'save-result'; added: number; already: number; moved: number; full: number; folder: string }
  | { type: 'thumb'; id: string | null; png: Uint8Array | null }
  | { type: 'sync'; fileId: string; folders: string[]; entries: SavedEntry[]; updatedAt: number }
  | { type: 'tree'; page: string; file?: string; rows: IncomingRow[]; truncated: boolean }
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
const pageRelays = document.getElementById('page-relays') as HTMLDivElement
const pageAccount = document.getElementById('page-account') as HTMLSpanElement
const pageAccountNote = document.getElementById('page-account-note') as HTMLParagraphElement
const pageSignIn = document.getElementById('page-signin') as HTMLButtonElement
const pageSignOut = document.getElementById('page-signout') as HTMLButtonElement
const pageTokenHint = document.getElementById('page-token-hint') as HTMLSpanElement
const editor = document.getElementById('editor') as HTMLDivElement
const agentColumn = document.getElementById('agent-column') as HTMLDivElement
const agentSessionLabel = document.getElementById('agent-session') as HTMLButtonElement
const agentFolderMenu = document.getElementById('agent-folder-menu') as HTMLDivElement
const agentFolderPath = document.getElementById('agent-folder-path') as HTMLSpanElement
const agentFolderList = document.getElementById('agent-folder-list') as HTMLDivElement
const agentFolderUp = document.getElementById('agent-folder-up') as HTMLButtonElement
const agentFolderUse = document.getElementById('agent-folder-use') as HTMLButtonElement
const agentIdle = document.getElementById('agent-idle') as HTMLDivElement
const agentIdleTitle = document.getElementById('agent-idle-title') as HTMLHeadingElement
const agentIdleLead = document.getElementById('agent-idle-lead') as HTMLParagraphElement
const agentIdleRecent = document.getElementById('agent-idle-recent') as HTMLDivElement
const agentIdleList = document.getElementById('agent-idle-list') as HTMLDivElement
const agentSetupLink = document.getElementById('agent-setup-link') as HTMLButtonElement
const agentMore = document.getElementById('agent-more') as HTMLButtonElement
const agentMoreMenu = document.getElementById('agent-more-menu') as HTMLDivElement
const agentHistoryOpen = document.getElementById('agent-history-open') as HTMLButtonElement
const agentHistoryMenu = document.getElementById('agent-history-menu') as HTMLDivElement
const agentPage = document.getElementById('agent-page') as HTMLDivElement
const agentPageToggle = document.getElementById('agent-toggle-page') as HTMLButtonElement
const agentUrlInput = document.getElementById('agent-url') as HTMLInputElement
const agentTokenInput = document.getElementById('agent-token') as HTMLInputElement
const agentConnectButton = document.getElementById('agent-connect') as HTMLButtonElement
const agentDot = document.getElementById('agent-dot') as HTMLSpanElement
const agentConn = document.getElementById('agent-conn') as HTMLSpanElement
const agentHarnessChips = document.getElementById('agent-harnesses') as HTMLDivElement
const agentCwdInput = document.getElementById('agent-cwd') as HTMLInputElement
const agentCwdUp = document.getElementById('agent-cwd-up') as HTMLButtonElement
const agentDirChips = document.getElementById('agent-dirs') as HTMLDivElement
const agentWritesToggle = document.getElementById('agent-writes') as HTMLButtonElement
const agentModePicker = document.getElementById('agent-mode') as HTMLButtonElement
const agentModeMenu = document.getElementById('agent-mode-menu') as HTMLDivElement
const agentCommandMenu = document.getElementById('agent-commands') as HTMLDivElement
const agentStartButton = document.getElementById('agent-start') as HTMLButtonElement
const agentStopButton = document.getElementById('agent-stop') as HTMLButtonElement
const agentSetupNote = document.getElementById('agent-setup-note') as HTMLParagraphElement
const agentChat = document.getElementById('agent-chat') as HTMLDivElement
const agentLog = document.getElementById('agent-log') as HTMLDivElement
const agentPermissionBox = document.getElementById('agent-permission') as HTMLDivElement
const agentPermissionTitle = document.getElementById('agent-permission-title') as HTMLParagraphElement
const agentPermissionOptions = document.getElementById('agent-permission-options') as HTMLDivElement
const agentPermissionAlways = document.getElementById('agent-permission-always') as HTMLButtonElement
const agentComposer = document.getElementById('agent-composer') as HTMLFormElement
const agentInput = document.getElementById('agent-input') as HTMLTextAreaElement
const agentSendButton = document.getElementById('agent-send') as HTMLButtonElement
const agentCancelButton = document.getElementById('agent-cancel') as HTMLButtonElement
const agentContextRow = document.getElementById('agent-context-row') as HTMLDivElement
const agentContextChips = document.getElementById('agent-context-chips') as HTMLDivElement
const agentContextAdd = document.getElementById('agent-context-add') as HTMLButtonElement
const agentContextFollow = document.getElementById('agent-context-follow') as HTMLButtonElement
const agentAttachMenu = document.getElementById('agent-attach-menu') as HTMLDivElement
const agentFileInput = document.getElementById('agent-file') as HTMLInputElement
const addContextButton = document.getElementById('add-context') as HTMLButtonElement
const agentContextLabel = document.getElementById('agent-context-label') as HTMLSpanElement
const agentTurnLine = document.getElementById('agent-turn') as HTMLParagraphElement
const agentToolList = document.getElementById('agent-tools') as HTMLDivElement
const apiList = document.getElementById('api-list') as HTMLDivElement
const apiNode = document.getElementById('api-node') as HTMLInputElement
const pageHealthCommand = document.getElementById('page-cmd-health') as HTMLPreElement
const pageSkillCommand = document.getElementById('page-cmd-skill') as HTMLPreElement
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
// The page a selection sits on is worth a word to the agent, and the tree
// message is the only thing that carries it.
let currentPageName = ''

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

// ---------------------------------------------------------------------- sync
//
// The saved set lives in clientStorage, which is per machine. A hosted relay
// keeps a copy per account, so the set follows you between machines; the main
// thread cannot reach the network, so the reconciling happens here.
//
// Last write wins at the level of the whole set. Two devices editing the same
// file's set at once is rare, and merging entry by entry would surprise more
// often than it would save.

const SYNC_DEBOUNCE_MS = 800

type SyncState = { fileId: string; folders: string[]; entries: SavedEntry[]; updatedAt: number }

let syncTimer: number | undefined
let syncPending: SyncState | null = null
let syncing = false

function canSync(): boolean {
  return relayToken !== '' && session === 'signed-in'
}

function scheduleSync(state: SyncState) {
  syncPending = state
  if (!canSync()) return
  if (syncTimer !== undefined) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => void runSync(), SYNC_DEBOUNCE_MS)
}

async function runSync(): Promise<void> {
  const state = syncPending
  if (!state || syncing || !canSync()) return
  syncing = true
  const path = `${httpBase()}/library/${encodeURIComponent(state.fileId)}`

  try {
    const response = await fetch(path, { headers: authHeaders() })
    if (response.status === 401) {
      sessionExpired('The relay rejected that token. Sign in again.')
      return
    }
    // A relay without accounts answers 501; there is nothing to sync with.
    if (response.status === 501 || !response.ok) return

    const remote = (await response.json()) as {
      folders: string[]
      entries: SavedEntry[]
      updatedAt: number
      known: boolean
    }

    if (remote.known && remote.updatedAt > state.updatedAt) {
      post({ type: 'sync-apply', folders: remote.folders, entries: remote.entries, updatedAt: remote.updatedAt })
      toast('Saved set synced from your account')
      return
    }
    // Nothing newer there, so this machine's copy is the one to keep.
    if (remote.known && remote.updatedAt === state.updatedAt) return

    await fetch(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ folders: state.folders, entries: state.entries, updatedAt: state.updatedAt }),
    })
  } catch {
    // Offline, or a relay that does not do this. The set still works locally and
    // the next change tries again.
  } finally {
    syncing = false
  }
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
  copyCodeButton.disabled = agentColumnOpen || source.length === 0
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
  addContextButton.disabled = selectedIds.length === 0
  addContextButton.textContent =
    selectedIds.length > 1 ? `Add ${selectedIds.length} to context` : 'Add to context'
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

type View = 'work' | 'relay' | 'auth' | 'agent'

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
  agentPage.hidden = next !== 'agent'
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
    void loadHealth()
  }
  if (next === 'agent') {
    agentPage.scrollTop = 0
    refreshAgentPage()
  }
}

relayPageToggle.addEventListener('click', () => setView(view === 'relay' ? 'work' : 'relay'))
// The agent replaces the third column rather than covering the panel: the point
// of a chat about a design is having the design next to it. The full page
// behind "Setup" is the pairing and the reference, which you read once.
/**
 * Swaps the third column between the generated code and the conversation. The
 * tab strip goes with the code: one column doing one job at a time beats two
 * doing halves of each.
 */
function setAgentColumn(on: boolean) {
  agentColumnOpen = on
  agentColumn.hidden = !on
  codeNav.hidden = on
  editor.hidden = on
  agentPageToggle.textContent = on ? 'Code' : 'Agent'
  if (on) {
    refreshAgentPage()
    agentInput.focus()
  }
  // Either way the footer's copy button has to agree with what is on screen.
  refreshCodeBox()
}

agentPageToggle.addEventListener('click', () => {
  if (view !== 'work') setView('work')
  setAgentColumn(!agentColumnOpen)
})

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
  return url === HOSTED_RELAY_URL ? 'Hosted' : shortAddress(url)
}

/**
 * One list of relays rather than two overlapping ones: the two this build knows
 * about, plus any other address used before. The one in use is shown but not
 * offered, and an address this build does not know can be forgotten.
 */
function renderRelayChoices() {
  const known = [HOSTED_RELAY_URL]
  const remembered = relayProfiles.map((entry) => entry.url).filter((url) => known.indexOf(url) === -1)
  const unique = [...known, ...remembered].filter((url, index, all) => all.indexOf(url) === index)

  pageRelays.textContent = ''
  for (const url of unique) {
    const current = url === relayUrl
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `chip${current ? ' current' : ''}`
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
        pageSettingsStatus.textContent =
          'Save and reconnect, then sign in — every relay has accounts.'
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
  pageSettingsStatus.textContent = relayToken === '' ? 'This relay needs an account. Press Sign in above.' : ''

  const signedIn = relayToken !== ''
  pageAccount.textContent = signedIn ? relayEmail || 'signed in' : 'not signed in'
  pageSignOut.hidden = !signedIn
  pageSignIn.textContent = signedIn ? 'Switch account' : 'Sign in'
  pageAccountNote.textContent = signedIn
    ? 'Each account gets its own room, so this token reaches your designs and nobody else\u2019s, and your saved set follows you between machines.'
    : 'Email and password, typed here. The relay answers with a token and the plugin stores it.'

  renderRelayChoices()

  // The field is only for a token obtained elsewhere; signing in is the normal path.
  pageTokenHint.textContent = 'Set by signing in above. Paste one here only if you already have it.'

  // Samples are built from the address in use, so they are always runnable.
  pageHealthCommand.textContent = `curl -s ${httpBase()}/health`
  pageSkillCommand.textContent = [
    'mkdir -p .claude/skills/figsnap .claude/agents',
    `curl -s ${httpBase()}/skill/SKILL.md > .claude/skills/figsnap/SKILL.md`,
    `curl -s ${httpBase()}/skill/figsnap-extractor.md > .claude/agents/figsnap-extractor.md`,
  ].join('\n')

  pageFacts.textContent = ''
  fact('Socket', relayUrl)
  fact('HTTP', httpBase())
  fact(
    'Token',
    relayToken === ''
      ? 'none — this relay needs one'
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
// ----------------------------------------------------------------- accounts
//
// A hosted relay has accounts; signing in happens here rather than in a browser,
// so the whole path from opening the plugin to a working API is one form. The
// password is posted to the relay over HTTPS and never stored — only the token
// it returns is, in clientStorage, which is per user and outside the project.

type SessionState = 'unknown' | 'signed-out' | 'signed-in'
type StepState = 'idle' | 'pending' | 'done' | 'failed'

const STEP_LABELS = ['Account', 'Relay socket', 'HTTP API']
const STEP_MARK: Record<StepState, string> = { idle: '\u00b7', pending: '\u2026', done: '\u2713', failed: '\u00d7' }

// Long enough for a Durable Object to spin up on a cold hosted relay.
const READY_TIMEOUT_MS = 20_000

let session: SessionState = 'unknown'
let authMode: 'login' | 'register' = 'login'
let authBusy = false

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
  if (session === 'signed-out') return
  session = 'signed-out'
  relayToken = ''
  relayEmail = ''
  announceRelayAccount()
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

    // Confirmed session: anything that was waiting on one can go now.
    if (syncPending) scheduleSync(syncPending)

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
  if (relayToken !== '') {
    // A stored token is trusted enough to connect on: the socket and /auth/me
    // both report a bad one, and the fast path is worth more than a round trip.
    session = 'signed-in'
    if (first || changed) {
      connect(first)
      void verifySession()
      // A set that was waiting for an account can go now.
      if (syncPending) scheduleSync(syncPending)
    }
    if (view === 'auth' && !authBusy) setView('work')
    return
  }

  // No credential, and every relay here has accounts: the gate is the only
  // sensible view.
  openGate()
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
        currentPageName = msg.page
        if (typeof msg.file === 'string') currentFileName = msg.file
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
      followSelection()
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
      announceRelayAccount()
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
    case 'sync':
      scheduleSync({
        fileId: msg.fileId,
        folders: msg.folders,
        entries: msg.entries,
        updatedAt: msg.updatedAt,
      })
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
    case 'agent-settings':
      applyAgentSettings(msg)
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

// -------------------------------------------------------------------- agent
//
// A chat inside the plugin, backed by a daemon on this machine holding an ACP
// client for whichever coding harness the designer already has installed.
//
// The panel is that client's human interface, not the client itself: an agent
// asks whoever it is talking to for a filesystem and a terminal, and an iframe
// has neither. So the daemon owns the machine, this owns the person, and one
// socket carries both halves — the conversation streaming down, and the tool
// calls going back into `figma.*` through the very same request/response frames
// the relay has always used.
//
// The transcript is built around one idea: what the agent *said* is the answer,
// and everything it *did* to get there — reasoning, tool calls — folds into a
// single line per stretch of work. In a 400px column that is the difference
// between a conversation and a log file.

type AgentHarness = {
  id: string
  name: string
  command: string
  available: boolean
  note: string
  /** Why not, when it is not available. Absent from daemons older than this field. */
  reason?: string
}

type AgentMode = { id: string; name: string; description?: string | null }

type AgentCommand = { name: string; description: string }

type AgentSessionRecord = {
  id: string
  harness: string
  harnessName: string
  cwd: string
  file: string | null
  title: string | null
  updatedAt: number
}

type AgentSessionState = {
  harness: { id: string; name: string } | null
  sessionId: string | null
  cwd: string
  running: boolean
  writes: boolean
  auto: boolean
  acceptsImages: boolean
  acceptsFiles: boolean
  modes: { currentModeId: string; availableModes: AgentMode[] } | null
  commands: AgentCommand[]
  connected: boolean
}

type AgentPermissionOption = { optionId: string; name: string; kind: string }

let agentUrl = AGENT_URL
let agentToken = ''
let agentCwd = ''
let agentHarnessId = ''
// Kept so a torn-down runtime can ask the harness to replay rather than forget.
let agentSessionId = ''
let agentSettingsLoaded = false
let agentHarnesses: AgentHarness[] = []
let agentStatus: BridgeStatus = 'off'
let agentSession: AgentSessionState = {
  harness: null,
  sessionId: null,
  cwd: '',
  running: false,
  writes: false,
  auto: true,
  acceptsImages: false,
  acceptsFiles: false,
  modes: null,
  commands: [],
  connected: false,
}
let agentPermission: { id: string; title: string; options: AgentPermissionOption[] } | null = null
let agentColumnOpen = true
// Both are remembered rather than re-chosen every morning: the daemon forgets
// them when it restarts, so the panel is the side that knows.
let agentWrites = false
let agentAuto = true
/** Tool names the daemon marked as writing, so a call that touches the file shows it. */
let agentWriteTools = new Set<string>()
let agentSessions: AgentSessionRecord[] = []
// The Figma file this panel is looking at, so a saved conversation can say
// which design it was about and not only which folder it ran in.
let currentFileName = ''

/** The HTTP face of the daemon, given its socket address. */
function agentHttpBase(): string {
  return agentUrl.replace(/^ws/, 'http').replace(/\/panel$/, '')
}

function agentHeaders(): Record<string, string> {
  return agentToken === '' ? {} : { 'x-figsnap-token': agentToken }
}

/** Image bytes from the main thread, as a data URI the panel can show. */
function pngDataUri(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...Array.from(bytes.subarray(offset, offset + chunk)))
  }
  return `data:image/png;base64,${btoa(binary)}`
}

const agentBridge = createBridge({
  label: 'daemon',
  url: () => (agentToken === '' ? agentUrl : `${agentUrl}?token=${encodeURIComponent(agentToken)}`),
  request: requestPlugin,
  onStatus: (status: BridgeStatus, detail?: string) => {
    agentStatus = status
    if (status === 'open') {
      // The daemon has no idea a panel appeared until one says so, and the
      // answer is both the harness list and wherever the session had got to.
      //
      // Writes is deliberately not pushed here. The daemon owns that switch —
      // it can also be seeded with `figsnap-agent --allow-edits` — and a panel
      // that announced its own stored value on connect would silently turn off
      // a flag the person at the terminal had just turned on. The `state` frame
      // that follows sets the toggle instead.
      agentBridge.send({ kind: 'hello', account: relayEmail })
      agentBridge.send({ kind: 'auto', on: agentAuto })
      void loadAgentTools()
      if (agentCwd === '') void browseAgent(null)
    }
    if (detail !== undefined && status !== 'open') agentSetupNote.textContent = detail
    refreshAgentPage()
  },
  onFrame: (message) => handleAgentFrame(message),
})

/**
 * Who this panel is signed into the relay as, told to the daemon.
 *
 * Not a credential and not treated as one: the daemon uses it only to refuse a
 * panel and a daemon signed in as two different people, which is the case that
 * makes `figsnap-agent login` mean anything. It rides with `hello` on connect,
 * and again whenever the designer signs in or out while the panel is open.
 */
function announceRelayAccount() {
  if (agentStatus !== 'open') return
  agentBridge.send({ kind: 'account', email: relayEmail })
}

// --------------------------------------------------------------- transcript

type Activity = {
  block: HTMLDivElement
  body: HTMLDivElement
  summary: HTMLButtonElement
  caption: HTMLSpanElement
  tools: Map<string, HTMLDivElement>
  startedAt: number
  touched: boolean
}

let agentActivity: Activity | null = null
let agentProse: HTMLDivElement | null = null
let agentProseFrame: number | undefined

// Delegated rather than bound per block: the transcript re-renders on every
// chunk while an answer streams, and a listener per code block would be rebuilt
// dozens of times for one paragraph.
agentLog.addEventListener('click', async (event: Event) => {
  const button = (event.target as HTMLElement).closest('.md-copy') as HTMLButtonElement | null
  if (button === null) return
  const code = button.closest('.md-code-block')?.querySelector('code')
  if (!code) return
  const copied = await copyText(code.textContent ?? '')
  button.textContent = copied ? 'Copied' : 'Select it instead'
  button.classList.toggle('done', copied)
  window.setTimeout(() => {
    button.textContent = 'Copy'
    button.classList.remove('done')
  }, 1600)
})

/** Sticks to the bottom only while the reader is already there. */
function agentScroll() {
  const nearBottom = agentLog.scrollHeight - agentLog.scrollTop - agentLog.clientHeight < 100
  if (nearBottom) agentLog.scrollTop = agentLog.scrollHeight
}

/** Anything appended means the conversation has started; the welcome goes. */
function agentAppend(node: HTMLElement) {
  const welcome = agentLog.querySelector('.agent-welcome')
  if (welcome !== null) welcome.remove()
  agentLog.appendChild(node)
  agentScroll()
}

function svg(paths: string, size = 14): SVGSVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  element.setAttribute('viewBox', '0 0 16 16')
  element.setAttribute('width', String(size))
  element.setAttribute('height', String(size))
  element.setAttribute('fill', 'none')
  element.setAttribute('stroke', 'currentColor')
  element.setAttribute('stroke-width', '1.25')
  element.setAttribute('stroke-linecap', 'round')
  element.setAttribute('stroke-linejoin', 'round')
  element.setAttribute('aria-hidden', 'true')
  element.innerHTML = paths
  return element
}

/**
 * A stretch of machine work: thinking, and the tools it called.
 *
 * It stays open while it is happening, because watching an agent work is the
 * only reassurance there is that it has not stalled, and folds itself away when
 * the stretch ends — unless the designer opened it, in which case it is theirs.
 */
function activity(): Activity {
  if (agentActivity !== null) return agentActivity
  agentProse = null

  const block = document.createElement('div')
  block.className = 'activity'
  block.dataset.open = 'true'
  block.dataset.running = 'true'

  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = 'activity-summary'
  summary.setAttribute('aria-expanded', 'true')

  const caption = document.createElement('span')
  caption.textContent = 'Working'
  const chevron = svg('<path d="M4 6.5 8 10.5l4-4"/>', 12)
  chevron.classList.add('chevron')
  summary.append(caption, chevron)

  const body = document.createElement('div')
  body.className = 'activity-body'

  summary.addEventListener('click', () => {
    const open = block.dataset.open !== 'true'
    block.dataset.open = String(open)
    body.hidden = !open
    summary.setAttribute('aria-expanded', String(open))
    // Once opened by hand it stays that way; the automatic fold is a default,
    // not a rule.
    block.dataset.pinned = 'true'
  })

  block.append(summary, body)
  agentAppend(block)

  agentActivity = { block, body, summary, caption, tools: new Map(), startedAt: Date.now(), touched: false }
  return agentActivity
}

/** Ends the current stretch: names how long it took and folds it away. */
function closeActivity() {
  const current = agentActivity
  agentActivity = null
  if (current === null) return
  const seconds = Math.max(1, Math.round((Date.now() - current.startedAt) / 1000))
  current.caption.textContent = current.touched ? `Worked for ${seconds}s` : `Thought for ${seconds}s`
  current.block.dataset.running = 'false'
  if (current.block.dataset.pinned !== 'true') {
    current.block.dataset.open = 'false'
    current.body.hidden = true
    current.summary.setAttribute('aria-expanded', 'false')
  }
}

function agentBreak() {
  closeActivity()
  agentProse = null
}

/** Whatever a content block says, as text. */
function agentContentText(content: unknown): string {
  const block = content as { type?: string; text?: string } | undefined
  if (block === undefined) return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  return `[${block.type ?? 'content'}]`
}

/** A replayed message can carry the picture that went with it the first time. */
function agentContentImage(content: unknown): string | null {
  const block = content as { type?: string; data?: string; mimeType?: string; text?: string } | undefined
  if (block?.type === 'image' && typeof block.data === 'string' && block.data !== '') {
    return `data:${block.mimeType ?? 'image/png'};base64,${block.data}`
  }
  return typeof block?.text === 'string' ? loneDataImage(block.text) : null
}

/** A render that will not decode leaves nothing behind, not its alt text. */
function shotImage(src: string): HTMLImageElement {
  const image = document.createElement('img')
  image.className = 'shot'
  image.src = src
  image.alt = 'The selection as it looks now'
  image.addEventListener('error', () => image.remove())
  return image
}

function agentUserMessage(
  text: string,
  shot?: string,
  attachments: { name: string }[] = [],
  queued = false,
): HTMLDivElement {
  agentBreak()
  const bubble = document.createElement('div')
  bubble.className = `turn-user${queued ? ' queued' : ''}`
  bubble.textContent = text
  if (shot !== undefined) bubble.appendChild(shotImage(shot))
  if (attachments.length > 0) {
    const tag = document.createElement('span')
    tag.className = 'queued-tag'
    tag.textContent = attachments.map((file) => file.name).join(', ')
    bubble.appendChild(tag)
  }
  if (queued) {
    const tag = document.createElement('span')
    tag.className = 'queued-tag'
    tag.textContent = 'Queued'
    bubble.appendChild(tag)
  }
  agentAppend(bubble)
  return bubble
}

/**
 * The answer. Chunks join into one block rather than one per token, and the
 * whole of it is re-rendered as Markdown — which is what the agent wrote, and
 * what turns a wall of asterisks back into headings, bullets and code.
 *
 * Re-rendering rather than appending because Markdown is not resumable: a
 * chunk can close a fence, finish a list, or complete a bold run that started
 * three chunks ago. Coalesced to one render per frame so a fast stream costs
 * one pass rather than one per token.
 */
function agentSay(text: string) {
  closeActivity()
  if (agentProse === null) {
    agentProse = document.createElement('div')
    agentProse.className = 'turn-agent'
    agentProse.dataset.raw = ''
    agentAppend(agentProse)
  }
  agentProse.dataset.raw = (agentProse.dataset.raw ?? '') + text
  paintProse()
}

function paintProse() {
  const block = agentProse
  if (block === null) return
  const paint = () => {
    agentProseFrame = undefined
    block.textContent = ''
    block.appendChild(renderMarkdown(block.dataset.raw ?? ''))
    agentScroll()
  }
  if (typeof requestAnimationFrame !== 'function') {
    paint()
    return
  }
  if (agentProseFrame !== undefined) return
  agentProseFrame = requestAnimationFrame(paint)
}

function agentThink(text: string) {
  const group = activity()
  let paragraph = group.body.querySelector('.activity-thought:last-child') as HTMLParagraphElement | null
  const lastIsTool = group.body.lastElementChild?.classList.contains('tool') === true
  if (paragraph === null || lastIsTool) {
    paragraph = document.createElement('p')
    paragraph.className = 'activity-thought'
    group.body.appendChild(paragraph)
  }
  paragraph.textContent = (paragraph.textContent ?? '') + text
  agentScroll()
}

/** Does this call touch the file? The daemon says which tools write. */
function toolWrites(update: Record<string, unknown>): boolean {
  const kind = String(update.kind ?? '')
  if (kind === 'edit' || kind === 'delete' || kind === 'move') return true
  const haystack = `${String(update.name ?? '')} ${String(update.title ?? '')}`
  for (const name of agentWriteTools) if (haystack.includes(name)) return true
  return false
}

const TOOL_STATE: Record<string, string> = {
  pending: 'queued',
  in_progress: 'running',
  completed: 'done',
  failed: 'failed',
}

/**
 * A tool call carries its own evidence — what it returned, the diff it wrote,
 * the terminal it ran in. ACP models all three, and rendering them is what
 * separates "it says it ran something" from being able to check.
 */
function toolEvidence(content: unknown[]): HTMLDivElement | null {
  for (const raw of content) {
    const block = raw as Record<string, any>
    if (block?.type === 'diff' && typeof block.newText === 'string') {
      const card = document.createElement('div')
      card.className = 'tool-content'
      const head = document.createElement('div')
      head.className = 'head'
      head.textContent = block.path ?? 'diff'
      const body = document.createElement('pre')
      const oldLines = typeof block.oldText === 'string' ? block.oldText.split('\n') : []
      for (const line of oldLines) {
        const row = document.createElement('span')
        row.className = 'diff-line del'
        row.textContent = `- ${line}`
        body.appendChild(row)
      }
      for (const line of block.newText.split('\n')) {
        const row = document.createElement('span')
        row.className = 'diff-line add'
        row.textContent = `+ ${line}`
        body.appendChild(row)
      }
      card.append(head, body)
      return card
    }

    if (block?.type === 'terminal') {
      const snapshot = block._figsnap as { output?: string; exitStatus?: { exitCode?: number } | null } | null
      const card = document.createElement('div')
      card.className = 'tool-content'
      const head = document.createElement('div')
      head.className = 'head'
      head.textContent = 'Terminal'
      const body = document.createElement('pre')
      body.textContent = scrubBase64(snapshot?.output ?? 'Running…')
      card.append(head, body)
      const code = snapshot?.exitStatus?.exitCode
      if (code !== undefined && code !== null) {
        const foot = document.createElement('div')
        foot.className = `foot ${code === 0 ? 'ok' : 'bad'}`
        foot.textContent = code === 0 ? '✓ Success' : `Exited ${code}`
        card.appendChild(foot)
      }
      return card
    }

    if (block?.type === 'content' && block.content?.type === 'image' && typeof block.content.data === 'string') {
      const card = document.createElement('div')
      card.className = 'tool-content'
      const image = document.createElement('img')
      image.src = `data:${block.content.mimeType ?? 'image/png'};base64,${block.content.data}`
      image.alt = 'Returned by the tool'
      card.appendChild(image)
      return card
    }

    if (block?.type === 'content' && block.content?.type === 'text' && typeof block.content.text === 'string') {
      const card = document.createElement('div')
      card.className = 'tool-content'
      // An adapter that stringifies a tool result hands back the whole image as
      // text. Shown as the picture it is, rather than as its bytes.
      const lone = loneDataImage(block.content.text)
      if (lone !== null) {
        const image = document.createElement('img')
        image.src = lone
        image.alt = 'Returned by the tool'
        image.addEventListener('error', () => image.remove())
        card.appendChild(image)
        return card
      }
      const body = document.createElement('pre')
      body.textContent = scrubBase64(block.content.text)
      card.appendChild(body)
      return card
    }
  }
  return null
}

function agentTool(update: Record<string, unknown>) {
  const id = String(update.toolCallId ?? '')
  if (id === '') return
  const group = activity()
  group.touched = true

  let row = group.tools.get(id)
  if (row === undefined) {
    row = document.createElement('div')
    row.className = 'tool'
    const mark = document.createElement('span')
    mark.className = 'mark'
    const name = document.createElement('span')
    name.className = 'name'
    const state = document.createElement('span')
    state.className = 'state'
    row.append(mark, name, state)
    group.body.appendChild(row)
    group.tools.set(id, row)
  }

  const name = row.querySelector('.name') as HTMLSpanElement
  const state = row.querySelector('.state') as HTMLSpanElement
  if (typeof update.title === 'string' && update.title !== '') name.textContent = update.title
  else if (typeof update.name === 'string') name.textContent = update.name

  const status = String(update.status ?? 'pending')
  state.textContent = TOOL_STATE[status] ?? status
  row.className = `tool ${status}${toolWrites(update) ? ' writes' : ''}`
  row.title = toolWrites(update) ? 'This call can change the Figma file' : ''

  const content = Array.isArray(update.content) ? update.content : []
  if (content.length > 0) {
    const evidence = toolEvidence(content)
    if (evidence !== null) {
      const existing = row.nextElementSibling
      if (existing?.classList.contains('tool-content')) existing.replaceWith(evidence)
      else row.after(evidence)
    }
  }
  agentScroll()
}

function agentPlan(entries: unknown) {
  const rows = Array.isArray(entries) ? (entries as { content?: string; status?: string }[]) : []
  closeActivity()
  let block = agentLog.querySelector('.plan:last-of-type') as HTMLDivElement | null
  if (block === null || block !== agentLog.lastElementChild) {
    block = document.createElement('div')
    block.className = 'plan'
    const head = document.createElement('div')
    head.className = 'plan-head'
    head.textContent = 'Plan'
    block.appendChild(head)
    agentAppend(block)
  }
  for (const stale of Array.from(block.querySelectorAll('.plan-item'))) stale.remove()
  for (const row of rows) {
    const item = document.createElement('div')
    item.className = `plan-item ${row.status ?? ''}`
    const box = document.createElement('span')
    box.className = 'box'
    box.textContent = row.status === 'completed' ? '✓' : row.status === 'in_progress' ? '→' : '·'
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = row.content ?? ''
    item.append(box, label)
    block.appendChild(item)
  }
  agentScroll()
}

function agentEvent(level: string, text: string) {
  const block = document.createElement('div')
  block.className = `event ${level}`
  const rule = document.createElement('span')
  rule.className = 'rule'
  const body = document.createElement('span')
  body.className = 'text'
  body.textContent = scrubBase64(text)
  block.append(rule, body)
  // Errors are the reason a session did not start, so the transcript they land
  // in has to be on screen even though there is no session.
  if (agentChat.hidden) window.setTimeout(refreshAgentPage, 0)
  if (level === 'auto') {
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'undo'
    undo.textContent = 'Ask me instead'
    undo.addEventListener('click', () => {
      setAgentAuto(false)
      undo.replaceWith(document.createTextNode('· asking from now on'))
    })
    body.append(document.createTextNode(' · '), undo)
  }
  agentAppend(block)
}

function agentClearLog() {
  agentLog.textContent = ''
  agentActivity = null
  agentProse = null
  renderAgentWelcome()
}

// ------------------------------------------------------------------- frames

function handleAgentFrame(message: Record<string, unknown>) {
  switch (message.kind) {
    case 'sessions':
      agentSessions = (message.sessions as AgentSessionRecord[]) ?? []
      if (!agentHistoryMenu.hidden) renderHistory()
      if (!agentIdle.hidden) renderAgentIdle()
      break

    case 'harnesses':
      agentHarnesses = (message.harnesses as AgentHarness[]) ?? []
      delete agentHistoryMenu.dataset.signature
      delete agentIdleList.dataset.signature
      if (agentHarnessId !== '' && !agentHarnesses.some((harness) => harness.id === agentHarnessId)) {
        agentHarnessId = ''
      }
      refreshAgentPage()
      break

    case 'state': {
      // A daemon older than this panel, or a test standing in for one, will not
      // send every field. Defaults here rather than a guard at each use.
      const sent = message as unknown as AgentSessionState
      const next: AgentSessionState = {
        ...sent,
        acceptsImages: sent.acceptsImages === true,
        acceptsFiles: sent.acceptsFiles === true,
        modes: sent.modes ?? null,
        commands: sent.commands ?? [],
      }
      agentSession = next
      // Adopted, not asserted: the daemon is the one gate, so whatever it says
      // about writes is what is true — including a value it was started with.
      if (next.writes !== agentWrites) {
        agentWrites = next.writes === true
        saveAgentSettings()
      }
      if (next.sessionId !== null && next.sessionId !== agentSessionId) {
        agentSessionId = next.sessionId
        saveAgentSettings()
      }
      if (next.harness !== null) agentHarnessId = next.harness.id
      if (next.cwd !== '') agentCwd = next.cwd
      // Which conversation is the current one is part of what the list shows.
      if (!agentHistoryMenu.hidden) renderHistory()
      refreshAgentPage()
      break
    }

    case 'update': {
      const update = (message.update ?? {}) as Record<string, unknown>
      switch (update.sessionUpdate) {
        case 'user_message_chunk': {
          const shot = agentContentImage(update.content)
          if (shot !== null) agentAppend(shotImage(shot))
          else agentUserMessage(agentContentText(update.content))
          break
        }
        case 'agent_message_chunk':
          agentSay(agentContentText(update.content))
          break
        case 'agent_thought_chunk':
          agentThink(agentContentText(update.content))
          break
        case 'tool_call':
        case 'tool_call_update':
          agentTool(update)
          break
        case 'plan':
        case 'plan_update':
          agentPlan(update.entries)
          break
        default:
          // Modes and commands arrive here too, but they change what the panel
          // offers rather than what it has said, so the daemon tracks them and
          // sends them back as state.
          break
      }
      break
    }

    case 'permission':
      agentPermission = {
        id: String(message.id ?? ''),
        title: String((message.toolCall as { title?: string } | undefined)?.title ?? 'this action'),
        options: ((message.options as AgentPermissionOption[]) ?? []).filter((option) => option && option.optionId),
      }
      // A turn stalls until this is answered, so it is brought into view rather
      // than left waiting behind whichever column the designer was reading.
      if (view === 'work' && !agentColumnOpen) setAgentColumn(true)
      refreshAgentPermission()
      break

    case 'turn':
      if (message.status === 'started') {
        agentSession = { ...agentSession, running: true }
        agentTurnLine.textContent = 'Working'
        refreshAgentQueueNote()
      } else {
        agentSession = { ...agentSession, running: false }
        agentBreak()
        const reason = String(message.stopReason ?? 'end_turn')
        agentTurnLine.textContent =
          reason === 'end_turn'
            ? ''
            : reason === 'cancelled'
              ? 'Stopped'
              : reason === 'refusal'
                ? 'Declined'
                : reason === 'max_tokens'
                  ? 'Ran out of room'
                  : reason === 'error'
                    ? 'Failed'
                    : reason
        if (reason === 'error') agentEvent('error', String(message.error ?? 'The turn failed.'))
        agentPermission = null
        refreshAgentPermission()
        flushQueue()
      }
      break

    case 'notice':
      agentEvent(String(message.level ?? 'info'), String(message.text ?? ''))
      break

    default:
      break
  }
}

// ------------------------------------------------------------------ chrome

function refreshAgentPermission() {
  agentPermissionBox.hidden = agentPermission === null
  if (agentPermission === null) return
  agentPermissionTitle.textContent = `Allow ${agentPermission.title}?`
  agentPermissionOptions.textContent = ''
  for (const option of agentPermission.options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = option.kind?.startsWith('allow') ? 'button primary' : 'button secondary'
    button.textContent = option.name
    button.addEventListener('click', () => answerAgentPermission(option.optionId))
    agentPermissionOptions.appendChild(button)
  }
  // Only when the harness has no standing "always" of its own. Two ways to say
  // the same thing, one of which this daemon could not later revoke, is worse
  // than one.
  agentPermissionAlways.hidden = agentPermission.options.some((option) => option.kind === 'allow_always')
}

agentPermissionAlways.addEventListener('click', () => {
  const allow = agentPermission?.options.find((option) => option.kind?.startsWith('allow'))
  setAgentAuto(true)
  if (allow !== undefined) answerAgentPermission(allow.optionId)
})

/**
 * Whether the daemon answers permission questions on the designer's behalf.
 *
 * There is no switch for this in the chrome, on purpose: a control that only
 * decides whether a prompt appears belongs on the prompt, and the way back
 * belongs on the line that says it happened. A header toggle would be a switch
 * pointing at nothing most of the time — and it would sit next to a harness's
 * own modes, which answer the same question better.
 */
function setAgentAuto(on: boolean) {
  agentAuto = on
  agentSession = { ...agentSession, auto: on }
  agentBridge.send({ kind: 'auto', on })
  saveAgentSettings()
}

function answerAgentPermission(optionId: string | null) {
  if (agentPermission === null) return
  agentBridge.send({ kind: 'permission', id: agentPermission.id, optionId })
  agentPermission = null
  refreshAgentPermission()
}

function refreshAgentHarnesses() {
  agentHarnessChips.textContent = ''
  if (agentHarnesses.length === 0 || !agentHarnesses.some((harness) => harness.available)) {
    const note = document.createElement('span')
    note.className = 'subtitle'
    note.textContent =
      agentStatus !== 'open'
        ? 'Connect to see what this machine can launch.'
        : 'No harness found. Install Claude Code, Codex or the Gemini CLI and sign in to it once — or set DEEPSEEK_API_KEY — then restart the daemon.'
    agentHarnessChips.appendChild(note)
    if (agentHarnesses.length === 0) return
  }
  for (const harness of agentHarnesses) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = `chip${harness.id === agentHarnessId ? ' current' : ''}`
    // An older daemon sends no reason, and the only one it had was this.
    chip.textContent = harness.available ? harness.name : `${harness.name} — ${harness.reason ?? 'not installed'}`
    chip.title = harness.available ? harness.command : harness.note
    chip.disabled = !harness.available || agentSession.harness !== null
    chip.addEventListener('click', () => {
      agentHarnessId = harness.id
      saveAgentSettings()
      refreshAgentPage()
    })
    agentHarnessChips.appendChild(chip)
  }
}

function setToggle(button: HTMLButtonElement, on: boolean) {
  button.setAttribute('aria-pressed', String(on))
}

function toggleIsOn(button: HTMLButtonElement): boolean {
  return button.getAttribute('aria-pressed') === 'true'
}

/** A directory is too long for the strip; its last part is what identifies it. */
function shortDirectory(path: string): string {
  const parts = path.split('/').filter((part) => part !== '')
  return parts.length === 0 ? path : parts[parts.length - 1]
}

/**
 * The panel with no session running: what will happen when you press the
 * button, the button, and the conversations you could pick up instead.
 *
 * It names the missing step rather than inviting you to start something that
 * would refuse — a harness that is not picked, a folder that is not chosen, a
 * daemon that is not running are three different problems with three answers.
 */
const RECENT = 5

function renderAgentIdle() {
  const blocked =
    agentStatus !== 'open'
      ? 'Run npm run agent in the plugin’s project, then pair it under Setup.'
      : agentHarnessId === ''
        ? 'Pick a harness under Setup.'
        : agentCwd === ''
          ? 'Choose a project folder — the name at the top of this column opens the picker.'
          : null

  const name = agentHarnesses.find((harness) => harness.id === agentHarnessId)?.name ?? agentHarnessId
  agentIdleTitle.textContent = blocked === null ? `${name} is ready` : 'Not ready yet'
  agentIdleLead.textContent =
    blocked ?? `It will work in ${shortDirectory(agentCwd)}, and can see whatever you have selected.`

  const recent = agentSessions.slice(0, RECENT)
  agentIdleRecent.hidden = recent.length === 0
  const signature = `${listSignature(recent)}~${agentSession.sessionId ?? ''}`
  if (agentIdleList.dataset.signature === signature) return
  agentIdleList.dataset.signature = signature
  agentIdleList.textContent = ''
  for (const record of recent) agentIdleList.appendChild(historyRow(record))
}

function refreshAgentStrip() {
  const live = agentSession.sessionId !== null
  agentSessionLabel.textContent = live
    ? `${agentSession.harness?.name ?? 'Session'} · ${shortDirectory(agentSession.cwd)}`
    : agentStatus === 'open'
      ? agentHarnessId === ''
        ? 'Pick a harness in Setup'
        : agentCwd === ''
          ? 'Choose a project folder'
          : `Ready · ${shortDirectory(agentCwd)}`
      : 'Not connected — open Setup'
  agentSessionLabel.disabled = agentStatus !== 'open'
  agentSessionLabel.title =
    agentStatus === 'open'
      ? `${agentCwd === '' ? 'No project folder yet' : agentCwd} — click to change`
      : 'Connect the daemon first'
  agentIdle.hidden = live || agentLog.childElementCount > 0
  if (!agentIdle.hidden) renderAgentIdle()
}

/**
 * The harness's own modes — plan, accept edits, and whatever else it publishes.
 * Shown next to Send because it is the thing that changes what pressing Send
 * will let happen, and hidden entirely by harnesses that have none.
 */
function refreshAgentModes() {
  const modes = agentSession.modes
  agentModePicker.hidden = !modes || modes.availableModes.length < 2
  if (!modes) return
  const current = modes.availableModes.find((mode) => mode.id === modes.currentModeId)
  agentModePicker.textContent = ''
  const label = document.createElement('span')
  label.className = 'label'
  label.textContent = current?.name ?? modes.currentModeId
  const chevron = svg('<path d="M4 6.5 8 10.5l4-4"/>', 11)
  chevron.classList.add('chevron')
  agentModePicker.append(label, chevron)
  agentModePicker.dataset.mode = modes.currentModeId
  agentModePicker.title =
    current?.description ??
    `${agentSession.harness?.name ?? 'The harness'} decides how much to do before asking. Edits still gates the canvas.`

  agentModeMenu.textContent = ''
  for (const mode of modes.availableModes) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `command${mode.id === modes.currentModeId ? ' current' : ''}`
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = mode.name
    const about = document.createElement('span')
    about.className = 'about'
    about.textContent = mode.description ?? ''
    row.append(name, about)
    row.addEventListener('click', () => {
      closeMenus()
      if (mode.id === modes.currentModeId) return
      agentBridge.send({ kind: 'mode', modeId: mode.id })
    })
    agentModeMenu.appendChild(row)
  }
}

agentModePicker.addEventListener('click', (event: Event) => {
  event.stopPropagation()
  const open = agentModeMenu.hidden
  closeMenus()
  agentModeMenu.hidden = !open
  agentModePicker.setAttribute('aria-expanded', String(open))
})

// ------------------------------------------------------------ session menu

function closeMenus() {
  agentMoreMenu.hidden = true
  agentAttachMenu.hidden = true
  agentFolderMenu.hidden = true
  agentHistoryMenu.hidden = true
  agentModeMenu.hidden = true
  agentMore.setAttribute('aria-expanded', 'false')
  agentModePicker.setAttribute('aria-expanded', 'false')
  agentSessionLabel.setAttribute('aria-expanded', 'false')
}

agentMore.addEventListener('click', (event: Event) => {
  event.stopPropagation()
  const open = agentMoreMenu.hidden
  closeMenus()
  agentMoreMenu.hidden = !open
  agentMore.setAttribute('aria-expanded', String(open))
})

// A menu that only closes on its own items is a menu you have to fight.
document.addEventListener('click', (event: Event) => {
  const target = event.target as HTMLElement
  if (
    target.closest(
      '#agent-more, #agent-more-menu, #agent-context-add, #agent-attach-menu,' +
        ' #agent-session, #agent-folder-menu, #agent-mode, #agent-mode-menu,' +
        ' #agent-history-open, #agent-history-menu',
    )
  ) {
    return
  }
  closeMenus()
})

function refreshAgentPage() {
  agentDot.className = `dot ${agentStatus}`
  agentConn.textContent = STATE_TEXT[agentStatus]
  // A retry loop refreshes this page every few seconds, and the fields are
  // where someone is typing the address and token that would end it.
  const fill = (field: HTMLInputElement, value: string) => {
    if (field !== document.activeElement) field.value = value
  }
  fill(agentUrlInput, agentUrl)
  fill(agentTokenInput, agentToken)
  fill(agentCwdInput, agentCwd)

  setToggle(agentWritesToggle, agentSession.writes)
  agentWritesToggle.disabled = agentStatus !== 'open'
  agentWritesToggle.title = agentSession.writes
    ? 'On: the agent can change this file. Each edit is one Cmd-Z, and figma_save_version leaves a checkpoint.'
    : 'Off: the agent can read this file but not change it. This is enforced by the daemon, not the agent.'

  refreshAgentHarnesses()

  const live = agentSession.sessionId !== null
  agentStartButton.hidden = live
  // Gone rather than greyed: a menu of three things where one cannot happen is
  // a menu that has to be read twice.
  agentStopButton.hidden = !live
  agentStartButton.disabled = agentStatus !== 'open' || agentHarnessId === '' || agentCwd === ''
  // A transcript with something in it is worth showing whether or not a session
  // is running: an error explaining why one did not start lands there, and
  // hiding it puts the answer behind the question.
  agentChat.hidden = !live && agentLog.childElementCount === 0
  agentSendButton.disabled = !live
  agentSendButton.title = agentSession.running ? 'Queue this for when the agent finishes' : 'Send'
  agentCancelButton.hidden = !agentSession.running
  agentInput.disabled = !live

  if (agentStatus === 'open' && !live) {
    agentSetupNote.textContent =
      agentHarnessId === ''
        ? 'Pick a harness.'
        : agentCwd === ''
          ? 'Pick the project directory the agent should work in.'
          : 'Ready. Start the session from the Agent column.'
  } else if (agentStatus === 'open' && live) {
    agentSetupNote.textContent = `${agentSession.harness?.name ?? 'Session'} in ${agentSession.cwd}`
  } else if (agentStatus === 'off') {
    agentSetupNote.textContent = 'Not connected. Run npm run agent in the plugin’s project, then paste its token.'
  }

  refreshAgentStrip()
  refreshAgentModes()
  refreshAgentContext()
  refreshAgentPermission()
  if (live && agentLog.childElementCount === 0) renderAgentWelcome()
}

// The same delegated copy the relay page uses, for the commands on this one.
agentPage.addEventListener('click', async (event: Event) => {
  const button = (event.target as HTMLElement).closest('[data-copy]') as HTMLElement | null
  if (!button?.dataset.copy) return
  const source = document.getElementById(button.dataset.copy)
  if (!source) return
  const copied = await copyText(source.textContent ?? '')
  agentSetupNote.className = copied ? 'subtitle ok-text' : 'subtitle bad-text'
  agentSetupNote.textContent = copied ? 'Copied.' : 'Copy blocked — select the text instead.'
})

agentSetupLink.addEventListener('click', () => {
  closeMenus()
  setView('agent')
})

// ---------------------------------------------------------------- history
//
// A session belongs to a harness and a directory as much as to an id, so
// resuming one is a full start with all three — picking yesterday's Codex
// conversation relaunches Codex, in the folder it ran in.

/** How long ago, at the resolution anyone actually cares about. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

/** One conversation, as a row. The history menu and the empty state share it. */
function historyRow(record: AgentSessionRecord): HTMLDivElement {
  // A conversation is only reopenable while the harness that owns it is still
  // installed. Saying so on the row beats failing on the click.
  const harness = agentHarnesses.find((entry) => entry.id === record.harness)
  const reachable = harness !== undefined && harness.available

  const row = document.createElement('div')
  row.className = `history-row${record.id === agentSession.sessionId ? ' current' : ''}${reachable ? '' : ' gone'}`

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'history-open'
  open.disabled = !reachable

  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = record.title ?? 'Untitled'

  const about = document.createElement('span')
  about.className = 'about'
  about.textContent = [
    reachable ? record.harnessName : `${record.harnessName} is not installed`,
    shortDirectory(record.cwd),
    record.file ?? null,
    ago(record.updatedAt),
  ]
    .filter((part) => part !== null && part !== '')
    .join(' · ')

  open.append(title, about)
  open.title = reachable
    ? `${record.title ?? 'Untitled'}\n${record.cwd}`
    : `${record.harnessName} is not on this machine any more, so this conversation cannot be reopened. Remove it with the cross.`
  open.addEventListener('click', () => {
    closeMenus()
    if (record.id === agentSession.sessionId) return
    agentHarnessId = record.harness
    agentCwd = record.cwd
    agentSessionId = record.id
    saveAgentSettings()
    agentLog.textContent = ''
    agentBridge.send({
      kind: 'start',
      harness: record.harness,
      cwd: record.cwd,
      resume: record.id,
      file: currentFileName,
    })
  })

  const drop = document.createElement('button')
  drop.type = 'button'
  drop.className = 'drop'
  drop.textContent = '✕'
  drop.title = 'Forget this conversation'
  drop.addEventListener('click', (event: Event) => {
    event.stopPropagation()
    agentBridge.send({ kind: 'forget', id: record.id })
  })

  row.append(open, drop)
  return row
}

/**
 * What a rendered list is made of. Rebuilding one that has not changed replaces
 * the row under the cursor mid-click: the handler belongs to a node that is no
 * longer in the document, so nothing happens and the menu closes as if the
 * click had missed. Opening the menu asks the daemon for the list, so an
 * unchanged answer arriving a moment later is the common case, not a rare one.
 */
function listSignature(records: AgentSessionRecord[]): string {
  return records.map((record) => `${record.id}:${record.title}:${record.updatedAt}`).join('|')
}

function renderHistory() {
  const signature = `${listSignature(agentSessions)}~${agentSession.sessionId ?? ''}`
  if (agentHistoryMenu.dataset.signature === signature) return
  agentHistoryMenu.dataset.signature = signature
  agentHistoryMenu.textContent = ''
  if (agentSessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'subtitle'
    empty.style.margin = '6px 8px'
    empty.textContent = 'No conversations yet. The first one you start will be here.'
    agentHistoryMenu.appendChild(empty)
    return
  }
  for (const record of agentSessions) agentHistoryMenu.appendChild(historyRow(record))
}

agentHistoryOpen.addEventListener('click', (event: Event) => {
  event.stopPropagation()
  closeMenus()
  agentHistoryMenu.hidden = false
  delete agentHistoryMenu.dataset.signature
  renderHistory()
  // The harness may know more than this daemon does; ask while it is on screen.
  agentBridge.send({ kind: 'sessions' })
})

// ------------------------------------------------------------ folder picker
//
// The directory is already on screen in the strip, so that is where it is
// changed. Choosing one is only half the story: `cwd` is fixed when the session
// opens, so switching it on a live session is a restart, and the button says so
// rather than quietly doing nothing.

/**
 * A path, shortened from the front. The end is what identifies a folder, and
 * CSS can only trim the other end — `direction: rtl` trims the right one but
 * reorders the separators, which reads as a different path.
 */
function shortPath(path: string, keep = 3): string {
  const parts = path.split('/').filter((part) => part !== '')
  if (parts.length <= keep) return path
  return `…/${parts.slice(-keep).join('/')}`
}

function renderFolderMenu() {
  const listing = agentBrowsing
  if (listing === null) return
  agentFolderPath.textContent = shortPath(listing.path)
  agentFolderPath.title = listing.path
  agentFolderUp.disabled = listing.parent === null
  agentFolderList.textContent = ''

  if (listing.directories.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'subtitle'
    empty.style.margin = '6px 8px'
    empty.textContent = 'No folders in here.'
    agentFolderList.appendChild(empty)
  }

  for (const name of listing.directories) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'folder-row'
    const mark = document.createElement('span')
    mark.className = 'mark'
    mark.textContent = '›'
    const label = document.createElement('span')
    label.textContent = name
    row.append(mark, label)
    row.addEventListener('click', () => void browseAgent(`${listing.path}/${name}`, false))
    agentFolderList.appendChild(row)
  }

  const live = agentSession.sessionId !== null
  const same = listing.path === agentCwd
  agentFolderUse.disabled = same
  agentFolderUse.textContent = same
    ? 'Already the project folder'
    : live
      ? 'Use this folder — restarts the session'
      : 'Use this folder'
}

agentSessionLabel.addEventListener('click', (event: Event) => {
  event.stopPropagation()
  const open = agentFolderMenu.hidden
  closeMenus()
  agentFolderMenu.hidden = !open
  agentSessionLabel.setAttribute('aria-expanded', String(open))
  // Always opens on the folder in use. Resuming a half-finished browse from
  // some earlier moment is surprising; "where am I now" is the useful anchor.
  if (open) void browseAgent(agentCwd === '' ? null : agentCwd, false)
})

agentFolderUp.addEventListener('click', () => {
  if (agentBrowsing?.parent) void browseAgent(agentBrowsing.parent, false)
})

agentFolderUse.addEventListener('click', () => {
  const chosen = agentBrowsing?.path
  if (chosen === undefined) return
  agentCwd = chosen
  saveAgentSettings()
  closeMenus()
  // A session carries its directory from the moment it opened, so a new one is
  // the only honest way to move it.
  if (agentSession.sessionId !== null) {
    agentSessionId = ''
    agentLog.textContent = ''
    agentBridge.send({ kind: 'start', harness: agentHarnessId, cwd: agentCwd, resume: '', file: currentFileName })
  }
  refreshAgentPage()
})

// -------------------------------------------------------------- empty state
//
// The first thing a new session shows. It names what is selected rather than
// asking a generic question, because the one thing a designer doubts on opening
// this is whether the panel can actually see their canvas — and four openings
// that do something useful teach the product faster than a paragraph would.

const OPENERS = [
  {
    label: 'Explain this',
    glyph: '<circle cx="8" cy="8" r="6"/><path d="M8 11v-3M8 5.2v.2"/>',
    writes: false,
    prompt: 'Explain what this contains — its layout, spacing, and which components it uses.',
  },
  {
    label: 'Write the component',
    glyph: '<path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5"/>',
    writes: false,
    prompt: 'Write this as a React component with CSS modules, matching the extraction exactly.',
  },
  {
    label: 'Compare with the code',
    glyph: '<rect x="2" y="3" width="8" height="8" rx="1"/><rect x="6" y="5" width="8" height="8" rx="1"/>',
    writes: false,
    prompt: 'Compare this design with our implementation and list what differs.',
  },
  {
    label: 'Tidy the layout',
    glyph: '<path d="M2.5 4h11M2.5 8h7M2.5 12h9"/>',
    writes: true,
    prompt: 'Give this consistent auto layout: even spacing and padding, and sensible alignment.',
  },
]

function renderAgentWelcome() {
  if (agentSession.sessionId === null) return
  const welcome = document.createElement('div')
  welcome.className = 'agent-welcome'

  const mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  mark.setAttribute('viewBox', '0 0 32 32')
  mark.setAttribute('width', '30')
  mark.setAttribute('height', '30')
  mark.setAttribute('aria-hidden', 'true')
  mark.classList.add('welcome-mark')
  // Four handles round a rectangle: what a selection looks like on the canvas,
  // which is the one thing this panel is for talking about.
  mark.innerHTML =
    '<rect x="8" y="8" width="16" height="16" rx="1" fill="none" stroke="currentColor" stroke-width="1.25"/>' +
    '<g fill="var(--figma-color-bg, #fff)" stroke="currentColor" stroke-width="1.25">' +
    '<rect x="5.5" y="5.5" width="5" height="5" rx="1.5"/><rect x="21.5" y="5.5" width="5" height="5" rx="1.5"/>' +
    '<rect x="5.5" y="21.5" width="5" height="5" rx="1.5"/><rect x="21.5" y="21.5" width="5" height="5" rx="1.5"/></g>'

  const title = document.createElement('h2')
  title.className = 'welcome-title'
  const lead = document.createElement('p')
  lead.className = 'welcome-lead'

  if (agentContextRows.length === 0) {
    title.textContent = 'Nothing selected yet'
    lead.textContent = 'Pick a layer on the canvas and it comes with your first message.'
  } else if (agentContextRows.length === 1) {
    title.textContent = agentContextRows[0].name
    title.title = agentContextRows[0].name
    lead.textContent = `${agentContextRows[0].type} · ${Math.round(agentContextRows[0].width)}×${Math.round(
      agentContextRows[0].height,
    )}${currentPageName === '' ? '' : ` on ${currentPageName}`}`
  } else {
    title.textContent = `${agentContextRows.length} layers`
    lead.textContent = agentContextRows.map((row) => row.name).join(', ')
  }

  const cards = document.createElement('div')
  cards.className = 'welcome-cards'
  for (const opener of OPENERS) {
    const card = document.createElement('button')
    card.type = 'button'
    card.className = `welcome-card${opener.writes ? ' writes' : ''}`
    const glyph = svg(opener.glyph)
    glyph.classList.add('glyph')
    const label = document.createElement('span')
    label.className = 'label'
    label.textContent = opener.label
    card.append(glyph, label)
    if (opener.writes && !agentSession.writes) {
      card.disabled = true
      card.title = 'Turn on Edits to let the agent change the file.'
      // Saying which switch, rather than leaving a dead card and a tooltip.
      const why = document.createElement('span')
      why.className = 'needs'
      why.textContent = 'Needs Edits'
      card.appendChild(why)
    } else {
      card.addEventListener('click', () => {
        agentInput.value = opener.prompt
        void sendAgentPrompt()
      })
    }
    cards.appendChild(card)
  }

  welcome.append(mark, title, lead, cards)
  agentLog.appendChild(welcome)
}

// -------------------------------------------------------------- directories

/**
 * The working-directory picker. It is a filesystem question, which is exactly
 * what a plugin iframe cannot answer, so the daemon answers it — directories
 * only, dotfiles hidden, and read-only.
 */
type Listing = { path: string; parent: string | null; directories: string[]; isProject: boolean }

// Where the folder picker is looking, which is not where the session is until
// the designer says so.
let agentBrowsing: Listing | null = null

async function browseAgent(path: string | null, pick = true) {
  try {
    const query = path === null ? '' : `?path=${encodeURIComponent(path)}`
    const response = await fetch(`${agentHttpBase()}/fs${query}`, { headers: agentHeaders() })
    if (!response.ok) throw new Error(`The daemon refused to browse (${response.status})`)
    const data = (await response.json()) as Listing
    agentBrowsing = data
    renderFolderMenu()
    if (!pick) return
    agentCwd = data.path
    agentCwdUp.disabled = data.parent === null
    agentCwdUp.dataset.parent = data.parent ?? ''
    agentDirChips.textContent = ''
    for (const name of data.directories) {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip'
      chip.textContent = name
      chip.addEventListener('click', () => void browseAgent(`${data.path}/${name}`))
      agentDirChips.appendChild(chip)
    }
    saveAgentSettings()
    refreshAgentPage()
  } catch (error) {
    agentSetupNote.textContent = error instanceof Error ? error.message : String(error)
  }
}

/** The tool list, so the designer can see exactly what the agent was handed. */
async function loadAgentTools() {
  try {
    const response = await fetch(`${agentHttpBase()}/tools`, { headers: agentHeaders() })
    if (!response.ok) return
    const data = (await response.json()) as {
      tools: { name: string; title: string; description: string; annotations?: { readOnlyHint?: boolean } }[]
    }
    agentWriteTools = new Set(
      data.tools.filter((tool) => tool.annotations?.readOnlyHint === false).map((tool) => tool.name),
    )
    agentToolList.textContent = ''
    for (const tool of data.tools) {
      const row = document.createElement('div')
      row.className = 'card tight'
      const head = document.createElement('div')
      head.className = 'card-row'
      const name = document.createElement('code')
      name.textContent = tool.name
      const spacer = document.createElement('span')
      spacer.className = 'spacer'
      const kind = document.createElement('span')
      kind.className = 'subtitle'
      kind.textContent = tool.annotations?.readOnlyHint === false ? 'edits the file' : 'read only'
      head.append(name, spacer, kind)
      const body = document.createElement('p')
      body.className = 'subtitle'
      body.style.margin = '0'
      body.textContent = tool.description
      row.append(head, body)
      agentToolList.appendChild(row)
    }
  } catch {
    // The list is a courtesy; the session works without it.
  }
}

// ------------------------------------------------------------------ context
//
// One list, one rule: it follows the canvas selection until the designer edits
// it, and then it is theirs. "Make B match A" needs two nodes and only one of
// them can be selected, so pinning has to be possible; having to pin every time
// would make the common case worse.

const MAX_CONTEXT = 10

let agentContextRows: TreeRow[] = []
let agentContextPinned = false

function agentContext(): { page: string; rows: TreeRow[] } | null {
  if (agentContextRows.length === 0) return null
  return { page: currentPageName, rows: agentContextRows }
}

/** Called when the canvas selection changes; ignored once the list is pinned. */
function followSelection() {
  if (agentContextPinned) return
  agentContextRows = selectionRows.slice(0, MAX_CONTEXT)
  refreshAgentContext()
  if (agentLog.querySelector('.agent-welcome') !== null) agentClearLog()
}

function pinContext(rows: TreeRow[]) {
  const merged = [...agentContextRows]
  for (const row of rows) {
    if (merged.length >= MAX_CONTEXT) break
    if (!merged.some((entry) => entry.id === row.id)) merged.push(row)
  }
  agentContextRows = merged
  agentContextPinned = true
  refreshAgentContext()
}

function dropContext(id: string) {
  agentContextRows = agentContextRows.filter((row) => row.id !== id)
  // Removing something is a decision, so the list stays pinned even when it
  // empties: sending nothing is a thing the designer might mean.
  agentContextPinned = true
  refreshAgentContext()
}

function refreshAgentContext() {
  agentContextChips.textContent = ''
  for (const row of agentContextRows) {
    const chip = document.createElement('span')
    chip.className = `context-chip${agentContextPinned ? '' : ' live'}`
    chip.title = `${row.name} — ${row.type} ${row.width}×${row.height} · ${row.id}${
      agentContextPinned ? '' : '\nFollowing the canvas: replaced when you select something else.'
    }`

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = row.name

    const drop = document.createElement('button')
    drop.type = 'button'
    drop.className = 'drop'
    drop.textContent = '✕'
    drop.title = `Remove ${row.name}`
    drop.addEventListener('click', () => dropContext(row.id))

    chip.append(name, drop)
    agentContextChips.appendChild(chip)
  }

  for (const file of agentAttachments) {
    const chip = document.createElement('span')
    chip.className = 'context-chip file'
    chip.title = `${file.name} · ${file.mimeType}`
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = file.mimeType.startsWith('image/') ? '🖼' : '📎'
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = file.name
    const drop = document.createElement('button')
    drop.type = 'button'
    drop.className = 'drop'
    drop.textContent = '✕'
    drop.title = `Remove ${file.name}`
    drop.addEventListener('click', () => {
      agentAttachments = agentAttachments.filter((entry) => entry.id !== file.id)
      refreshAgentContext()
    })
    chip.append(kind, name, drop)
    agentContextChips.appendChild(chip)
  }

  const empty = agentContextRows.length === 0 && agentAttachments.length === 0
  agentContextRow.hidden = empty
  agentContextLabel.hidden = !empty
  agentContextLabel.textContent = agentContextPinned ? 'No context' : 'Nothing selected'
  agentContextFollow.hidden = !agentContextPinned
  agentContextAdd.disabled = false
  agentContextAdd.title = 'Add the selection, or attach a file'
}

// ------------------------------------------------------------ attachments
//
// A design question often comes with something that is not in the file: a
// screenshot of the bug, a PDF of the brand guidelines, a spec. ACP carries
// both — images as image blocks, everything else as an embedded resource — so
// the panel offers both and the daemon drops what the harness cannot read.

const MAX_ATTACHMENT_BYTES = 5_000_000

type Attachment = { id: string; name: string; mimeType: string; data: string }

let agentAttachments: Attachment[] = []

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      // A data URI, of which only the payload travels.
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

async function attachFiles(files: FileList | null) {
  for (const file of Array.from(files ?? [])) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      agentEvent('error', `${file.name} is ${(file.size / 1_000_000).toFixed(1)} MB; 5 MB is the limit.`)
      continue
    }
    try {
      agentAttachments = [
        ...agentAttachments,
        {
          id: `${file.name}:${file.size}:${file.lastModified}`,
          name: file.name,
          mimeType: file.type === '' ? 'application/octet-stream' : file.type,
          data: await readAsBase64(file),
        },
      ]
    } catch (error) {
      agentEvent('error', error instanceof Error ? error.message : String(error))
    }
  }
  refreshAgentContext()
}

agentFileInput.addEventListener('change', () => {
  void attachFiles(agentFileInput.files).then(() => {
    agentFileInput.value = ''
  })
})

/** The + offers both things it could mean rather than guessing at one. */
function openAttachMenu() {
  agentAttachMenu.textContent = ''
  const options: { label: string; about: string; disabled?: string; run: () => void }[] = [
    {
      label: 'Add the selection',
      about:
        selectionRows.length === 0
          ? 'Nothing is selected'
          : selectionRows.length === 1
            ? selectionRows[0].name
            : `${selectionRows.length} layers`,
      disabled: selectionRows.length === 0 ? 'Select something on the canvas first' : undefined,
      run: () => pinContext(selectionRows),
    },
    {
      label: 'Attach a file',
      about: agentSession.acceptsFiles || agentSession.acceptsImages ? 'Image, PDF, anything' : 'This harness reads neither',
      disabled:
        agentSession.acceptsFiles || agentSession.acceptsImages
          ? undefined
          : 'This harness takes no attachments',
      run: () => agentFileInput.click(),
    },
  ]
  for (const option of options) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'command'
    row.disabled = option.disabled !== undefined
    if (option.disabled !== undefined) row.title = option.disabled
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = option.label
    const about = document.createElement('span')
    about.className = 'about'
    about.textContent = option.about
    row.append(name, about)
    row.addEventListener('click', () => {
      agentAttachMenu.hidden = true
      option.run()
    })
    agentAttachMenu.appendChild(row)
  }
  agentAttachMenu.hidden = false
}

agentContextAdd.addEventListener('click', () => {
  if (agentAttachMenu.hidden) openAttachMenu()
  else agentAttachMenu.hidden = true
})

addContextButton.addEventListener('click', () => {
  pinContext(selectionRows)
  if (view === 'work' && !agentColumnOpen) setAgentColumn(true)
})

agentContextFollow.addEventListener('click', () => {
  agentContextPinned = false
  agentContextRows = selectionRows.slice(0, MAX_CONTEXT)
  refreshAgentContext()
})

// ----------------------------------------------------------- slash commands
//
// Harnesses publish their own commands over ACP. Offering them when a message
// starts with a slash is where somebody would look for them.

let agentCommandIndex = 0

function matchingCommands(): AgentCommand[] {
  const typed = agentInput.value
  if (!typed.startsWith('/') || typed.includes(' ') || typed.includes('\n')) return []
  const prefix = typed.slice(1).toLowerCase()
  return (agentSession.commands ?? [])
    .filter((command) => command.name.toLowerCase().startsWith(prefix))
    .slice(0, 8)
}

function refreshAgentCommands() {
  const matches = matchingCommands()
  agentCommandMenu.hidden = matches.length === 0
  agentCommandMenu.textContent = ''
  if (matches.length === 0) return
  agentCommandIndex = Math.min(agentCommandIndex, matches.length - 1)
  matches.forEach((command, index) => {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `command${index === agentCommandIndex ? ' active' : ''}`
    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = `/${command.name}`
    const about = document.createElement('span')
    about.className = 'about'
    about.textContent = command.description
    row.append(name, about)
    row.addEventListener('click', () => useCommand(command))
    agentCommandMenu.appendChild(row)
  })
}

function useCommand(command: AgentCommand) {
  agentInput.value = `/${command.name} `
  agentCommandMenu.hidden = true
  agentInput.focus()
}

// ------------------------------------------------------------------ actions

function saveAgentSettings() {
  if (!agentSettingsLoaded) return
  post({
    type: 'save-agent-settings',
    url: agentUrl,
    token: agentToken,
    cwd: agentCwd,
    harness: agentHarnessId,
    sessionId: agentSessionId,
    writes: agentWrites,
    auto: agentAuto,
  })
}

function connectAgent() {
  agentUrl = agentUrlInput.value.trim() === '' ? AGENT_URL : agentUrlInput.value.trim()
  agentToken = agentTokenInput.value.trim()
  saveAgentSettings()
  agentBridge.disconnect()
  agentBridge.connect()
}

agentConnectButton.addEventListener('click', connectAgent)

agentCwdUp.addEventListener('click', () => {
  const parent = agentCwdUp.dataset.parent
  if (parent) void browseAgent(parent)
})

agentCwdInput.addEventListener('change', () => void browseAgent(agentCwdInput.value.trim()))

// Flipped here and now rather than when the daemon answers: a switch that waits
// for a round trip before it looks switched reads as one that did not work.
// The state frame that follows either agrees or corrects it.
agentWritesToggle.addEventListener('click', () => {
  agentWrites = !toggleIsOn(agentWritesToggle)
  agentSession = { ...agentSession, writes: agentWrites }
  setToggle(agentWritesToggle, agentWrites)
  agentBridge.send({ kind: 'writes', on: agentWrites })
  saveAgentSettings()
  if (agentLog.querySelector('.agent-welcome') !== null) agentClearLog()
})

agentStartButton.addEventListener('click', () => {
  agentStartButton.disabled = true
  agentLog.textContent = ''
  agentSetupNote.textContent = 'Starting the harness. A first run downloads it, which can take a few minutes.'
  agentBridge.send({
    kind: 'start',
    harness: agentHarnessId,
    cwd: agentCwd,
    // A stored id from a previous run is offered, not insisted on: the daemon
    // falls back to a new session when the harness cannot load it.
    resume: agentSessionId,
    file: currentFileName,
  })
})

agentStopButton.addEventListener('click', () => {
  closeMenus()
  agentBridge.send({ kind: 'stop' })
  // The session stays in the history; it is only no longer the one in use, and
  // the stored id going with it is what stops the next Start silently resuming.
  agentSessionId = ''
  saveAgentSettings()
  agentLog.textContent = ''
  agentBridge.send({ kind: 'sessions' })
})

agentCancelButton.addEventListener('click', () => agentBridge.send({ kind: 'cancel' }))

/**
 * Sends the message, and — where the harness said it reads images — a picture
 * of what is selected alongside it. This is a design tool: a model that can
 * look at the frame settles questions about spacing and colour that no amount
 * of CSS in a text block would.
 */
type Outgoing = {
  text: string
  context: { page: string; rows: TreeRow[] } | null
  attachments: Attachment[]
  shot?: string
  bubble?: HTMLDivElement
}

// Typing while the agent is still answering is the normal way to use a chat, so
// the message waits its turn instead of being refused. It is shown the moment
// it is written, dimmed and labelled, because a message that vanished until
// some later moment would look lost.
let agentQueue: Outgoing[] = []

function deliver(message: Outgoing) {
  if (message.bubble !== undefined) {
    message.bubble.classList.remove('queued')
    message.bubble.querySelector('.queued-tag')?.remove()
  }
  agentBridge.send({
    kind: 'prompt',
    text: message.text,
    ...(message.context === null
      ? {}
      : {
          context: {
            ...message.context,
            ...(message.shot === undefined
              ? {}
              : { images: [{ data: message.shot.split(',')[1], mimeType: 'image/png' }] }),
          },
        }),
    ...(message.attachments.length === 0
      ? {}
      : {
          attachments: message.attachments.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            data: file.data,
          })),
        }),
  })
}

function flushQueue() {
  const next = agentQueue.shift()
  if (next === undefined) return
  deliver(next)
  refreshAgentQueueNote()
}

function refreshAgentQueueNote() {
  if (agentQueue.length === 0) return
  agentTurnLine.textContent = `Working · ${agentQueue.length} queued`
}

/**
 * Sends the message, and — where the harness said it reads images — a picture
 * of what is selected alongside it. This is a design tool: a model that can
 * look at the frame settles questions about spacing and colour that no amount
 * of CSS in a text block would.
 */
async function sendAgentPrompt() {
  const text = agentInput.value.trim()
  if (text === '' || agentSession.sessionId === null) return
  const context = agentContext()
  const attachments = agentAttachments
  agentInput.value = ''
  agentAttachments = []
  agentCommandMenu.hidden = true
  agentAttachMenu.hidden = true
  refreshAgentContext()
  resizeComposer()

  // The bubble goes up first. Rendering the frame takes a moment, and a message
  // that does not appear until it finishes looks like a message that was lost.
  const queued = agentSession.running
  const bubble = agentUserMessage(text, undefined, attachments, queued)

  let shot: string | undefined
  if (context !== null && agentSession.acceptsImages) {
    try {
      const data = (await requestPlugin('export_png', { nodeId: context.rows[0].id, scale: 1 })) as {
        png?: Uint8Array
      }
      if (data?.png instanceof Uint8Array) {
        shot = pngDataUri(data.png)
        bubble.insertBefore(shotImage(shot), bubble.querySelector('.queued-tag'))
        agentScroll()
      }
    } catch {
      // A frame that will not render is not a reason to hold the message.
    }
  }

  const message: Outgoing = { text, context, attachments, shot, bubble }
  if (queued) {
    agentQueue.push(message)
    refreshAgentQueueNote()
    return
  }
  deliver(message)
}

/** The box grows with what is typed, up to the height the stylesheet allows. */
function resizeComposer() {
  agentInput.style.height = 'auto'
  agentInput.style.height = `${Math.min(agentInput.scrollHeight, 140)}px`
}

agentComposer.addEventListener('submit', (event: Event) => {
  event.preventDefault()
  void sendAgentPrompt()
})

agentInput.addEventListener('input', () => {
  resizeComposer()
  refreshAgentCommands()
})

// Enter sends, Shift-Enter is a newline: this is a chat box, not a document.
agentInput.addEventListener('keydown', (event: KeyboardEvent) => {
  const matches = matchingCommands()
  if (matches.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault()
    agentCommandIndex =
      (agentCommandIndex + (event.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length
    refreshAgentCommands()
    return
  }
  if (event.key === 'Escape' && !agentCommandMenu.hidden) {
    event.stopPropagation()
    agentCommandMenu.hidden = true
    return
  }
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    if (matches.length > 0) {
      useCommand(matches[agentCommandIndex])
      return
    }
    void sendAgentPrompt()
  }
})

function applyAgentSettings(settings: {
  url: string
  token: string
  cwd: string
  harness: string
  sessionId: string
  writes?: boolean
  auto?: boolean
}) {
  agentUrl = settings.url === '' ? AGENT_URL : settings.url
  agentToken = settings.token
  agentCwd = settings.cwd
  agentHarnessId = settings.harness
  agentSessionId = settings.sessionId
  agentWrites = settings.writes === true
  // Asking every time is the safe default but not the useful one, and the gate
  // that matters is `writes`. Absent means a panel that predates this setting.
  agentAuto = settings.auto !== false
  agentSession = { ...agentSession, writes: agentWrites, auto: agentAuto }
  agentSettingsLoaded = true
  refreshAgentPage()
  // A stored token means the daemon was paired before; dialling straight away
  // is the difference between the chat being there and being three clicks away.
  if (agentToken !== '') agentBridge.connect()
}

setAuthMode('login')
// The third column opens on the agent. Code is a click away on the same button.
setAgentColumn(true)
post({ type: 'ready' })
renderActiveList()
refreshPrimary()
refreshCodeBox()
// The connection waits for the stored relay settings, which arrive right after.

