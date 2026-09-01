// The relay's HTTP surface, described once.
//
// The panel renders this as a browsable reference you can fire requests from,
// and the docs build their endpoint table out of it, so the two cannot drift.
// Every example here is a real response shape, trimmed — not an invention.

/** @typedef {{ name: string, type: string, note: string }} Field */

const TOKEN_HEADER = 'x-relay-token: <your token>'

export const groups = [
  {
    id: 'design',
    title: 'Design data',
    note: 'What the plugin can see, read live from the open Figma file.',
    endpoints: [
      {
        id: 'health',
        method: 'GET',
        path: '/health',
        summary: 'Relay state, and whether a plugin is on the other end.',
        auth: 'optional',
        authNote:
          'Public, but room state is private: without a token the answer omits pluginConnected rather than reporting a misleading false.',
        response: {
          ok: true,
          hosted: true,
          storesImages: false,
          accounts: 9,
          sharedToken: false,
          authenticated: true,
          pluginConnected: true,
          pendingRequests: 0,
          sseClients: 0,
          signedIn: 'you@example.com',
        },
      },
      {
        id: 'tree',
        method: 'GET',
        path: '/tree',
        summary: 'Layers of the current page, one level or the whole subtree.',
        auth: 'required',
        query: [
          {
            name: 'depth',
            note: 'How many levels. 1 (the default) is a flat list; a number goes that deep; "all" goes to the bottom.',
          },
        ],
        response: {
          page: 'Page 1',
          depth: 2,
          nodeCount: 31,
          truncated: false,
          rows: [
            {
              id: '21:15617',
              name: 'Group 1',
              type: 'GROUP',
              width: 2275,
              height: 3592,
              childCount: 30,
              children: [
                { id: '21:10073', name: 'Bottomsheet Add to WG', type: 'FRAME', width: 375, height: 420, childCount: 3 },
              ],
            },
          ],
        },
        responseNote:
          'A row has a children array only where the walk went deeper. A row with childCount above zero and no children is where to ask again. Capped at 300 siblings per level and 2000 nodes overall; truncated says whether either bit.',
      },
      {
        id: 'children',
        method: 'GET',
        path: '/children/:id',
        summary: 'Under one node, one level or the whole subtree.',
        auth: 'required',
        params: [{ name: 'id', note: 'Node id. A Figma link uses 21-10073; the API wants 21:10073.' }],
        query: [{ name: 'depth', note: 'Same as /tree: a number, or "all". Defaults to 1.' }],
        response: {
          parentId: '21:10073',
          depth: 1,
          nodeCount: 3,
          truncated: false,
          rows: [{ id: '21:10074', name: 'Title', type: 'INSTANCE', width: 375, height: 44, childCount: 2 }],
        },
      },
      {
        id: 'selection',
        method: 'GET',
        path: '/selection',
        summary: 'What is selected on canvas right now.',
        auth: 'required',
        response: {
          page: 'Page 1',
          rows: [{ id: '21:10073', name: 'Bottomsheet Add to WG', type: 'FRAME', width: 375, height: 420, childCount: 3 }],
        },
      },
      {
        id: 'extract',
        method: 'POST',
        path: '/extract',
        summary: 'One node, or a batch. Pick which outputs you want back.',
        auth: 'required',
        body: {
          fields: [
            { name: '(empty)', type: '{}', note: 'Whatever is selected on canvas.' },
            { name: 'nodeId', type: 'string', note: 'One node by id.' },
            { name: 'url', type: 'string', note: 'One node by Figma link.' },
            { name: 'nodeIds', type: 'string[]', note: 'A batch, by id. Up to 20.' },
            { name: 'urls', type: 'string | string[]', note: 'A batch, by link. Newline-separated is fine.' },
            { name: 'selection', type: 'true', note: 'A batch of everything selected.' },
            { name: 'saved', type: 'true', note: 'A batch of the plugin’s Saved set.' },
            { name: 'folder', type: 'string', note: 'With saved: true, only that folder. \'\' is the root.' },
            {
              name: 'format',
              type: 'string | string[]',
              note: 'Which outputs: png, html, tsx, moduleCss, css, figmaCss. Default all but pngData.',
            },
            {
              name: 'format: "pngData"',
              type: 'opt-in',
              note: 'The image inline as a data URI instead of a URL. ~40 KB a node, so never a default.',
            },
            { name: 'scale', type: '1 – 4', note: 'PNG resolution. Default 2.' },
            { name: 'topLayerOnly', type: 'boolean', note: 'Do not walk into children.' },
            { name: 'inlineInstances', type: 'boolean', note: 'Walk into instances instead of stopping at them.' },
          ],
          examples: [
            { label: 'Current selection', value: {} },
            { label: 'One node', value: { nodeId: '21:10073', scale: 2 } },
            { label: 'React only', value: { format: 'tsx' } },
            { label: 'React and its CSS', value: { format: ['tsx', 'moduleCss'] } },
            { label: 'A page to open', value: { format: 'html' } },
            { label: 'Image inline', value: { format: ['tsx', 'pngData'] } },
            { label: 'One link', value: { url: 'https://www.figma.com/design/KEY/Name?node-id=21-10073' } },
            { label: 'Batch: selection', value: { selection: true } },
            { label: 'Batch: saved set', value: { saved: true } },
            { label: 'Batch: one folder', value: { saved: true, folder: 'Checkout' } },
            { label: 'Batch: ids', value: { nodeIds: ['21:10073', '21:15617'] } },
          ],
        },
        response: {
          id: '21:10073',
          name: 'Bottomsheet Add to WG',
          nodeType: 'FRAME',
          width: 375,
          height: 420,
          layerCount: 13,
          truncated: false,
          outputs: ['png', 'html', 'tsx', 'moduleCss', 'css', 'figmaCss'],
          png: {
            url: 'https://<relay>/assets/21%3A10073@2x.png',
            bytes: 30627,
            note: 'Rendered on request; the relay stores no image.',
          },
          html: '<!DOCTYPE html> … a whole page, styles and markup, openable as-is',
          tsx: "import s from './BottomsheetAddToWG.module.css' …",
          moduleCss: '.bottomsheetAddToWg { … }',
          css: 'padding: var(--Spacing-Large, 16px); …',
          figmaCss: '/* Bottomsheet Add to WG */ …',
        },
        responseNote:
          'html is a standalone document: deduped class names, the real text, icons inlined as SVG, and the two things Figma never emits — position: relative on a layer with an absolutely positioned child, and the root\u2019s own size. pngData answers { dataUri, bytes, scale } beside or instead of png. Only the outputs asked for are present, and `outputs` echoes which those were — asking for one keeps the answer small, which matters when figmaCss alone can run to tens of kilobytes. A batch answers { results: [ … ] } instead, one entry per input: { ref, nodeId, ok: true, extraction } or { ref, nodeId, ok: false, error }. Never both.',
      },
      {
        id: 'resolve',
        method: 'POST',
        path: '/resolve',
        summary: 'What links point at, without exporting anything.',
        auth: 'required',
        body: {
          fields: [{ name: 'urls', type: 'string | string[]', note: 'Figma links. Newline-separated is fine.' }],
          examples: [{ label: 'One link', value: { urls: 'https://www.figma.com/design/KEY/Name?node-id=21-10073' } }],
        },
        response: {
          results: [
            { ref: 'https://www.figma.com/design/KEY/Name?node-id=21-10073', nodeId: '21:10073', name: 'Bottomsheet Add to WG', type: 'FRAME', ok: true },
          ],
        },
      },
      {
        id: 'asset',
        method: 'GET',
        path: '/assets/:nodeId@2x.png',
        summary: 'Re-renders that node as a PNG. Nothing is cached.',
        auth: 'required',
        binary: true,
        params: [{ name: 'nodeId', note: 'URL-encoded: a colon becomes %3A. The @2x part is 1x to 4x.' }],
        responseNote:
          'image/png bytes, with cache-control: no-store. The relay holds no copy — the request goes back through the live socket and the plugin renders it again.',
      },
    ],
  },
  {
    id: 'saved',
    title: 'Saved set',
    note:
      'A set curated in the plugin, optionally grouped into folders. Stored in the plugin, never on the relay. Folders are one level deep; an entry with folder "" sits at the root.',
    endpoints: [
      {
        id: 'saved-get',
        method: 'GET',
        path: '/saved',
        summary: 'The Saved set, with the folders that exist.',
        auth: 'required',
        query: [
          { name: 'folder', note: 'Only that folder. Pass an empty value for the root; omit it for everything.' },
        ],
        response: {
          folders: [
            { name: '', count: 2 },
            { name: 'Checkout', count: 3 },
          ],
          entries: [
            { id: '21:10073', name: 'Bottomsheet Add to WG', type: 'FRAME', addedAt: 1788190494870, folder: 'Checkout' },
          ],
        },
      },
      {
        id: 'saved-post',
        method: 'POST',
        path: '/saved',
        summary: 'Add to the set, optionally straight into a folder.',
        auth: 'required',
        body: {
          fields: [
            { name: 'selection', type: 'true', note: 'Add everything selected on canvas.' },
            { name: 'nodeIds', type: 'string[]', note: 'Add specific nodes.' },
            { name: 'folder', type: 'string', note: 'An existing folder. Omit for the root. Re-saving moves an entry.' },
          ],
          examples: [
            { label: 'From selection', value: { selection: true } },
            { label: 'Into a folder', value: { selection: true, folder: 'Checkout' } },
            { label: 'By id', value: { nodeIds: ['21:10073'] } },
          ],
        },
        response: {
          added: 1,
          folders: [{ name: '', count: 2 }, { name: 'Checkout', count: 3 }],
          entries: [{ id: '21:10073', name: 'Bottomsheet Add to WG', type: 'FRAME', addedAt: 1788190494870, folder: 'Checkout' }],
        },
      },
      {
        id: 'saved-move',
        method: 'POST',
        path: '/saved/move',
        summary: 'Move entries between folders without re-saving them.',
        auth: 'required',
        body: {
          fields: [
            { name: 'nodeIds', type: 'string[]', note: 'The entries to move.' },
            { name: 'folder', type: 'string', note: 'Destination. An empty string moves them back to the root.' },
          ],
          examples: [
            { label: 'Into a folder', value: { nodeIds: ['21:10073'], folder: 'Checkout' } },
            { label: 'Back to the root', value: { nodeIds: ['21:10073'], folder: '' } },
          ],
        },
        response: { moved: 1, folders: [{ name: '', count: 3 }, { name: 'Checkout', count: 2 }], entries: [] },
      },
      {
        id: 'saved-delete',
        method: 'DELETE',
        path: '/saved',
        summary: 'Remove entries, or empty one folder.',
        auth: 'required',
        body: {
          fields: [
            { name: 'nodeIds', type: 'string[]', note: 'Remove specific entries.' },
            { name: 'folder', type: 'string', note: 'Empty that folder. The folder itself stays.' },
            { name: 'all', type: 'true', note: 'Empty the whole set. Folders stay.' },
          ],
          examples: [
            { label: 'By id', value: { nodeIds: ['21:10073'] } },
            { label: 'Empty a folder', value: { folder: 'Checkout' } },
            { label: 'Everything', value: { all: true } },
          ],
        },
        response: { removed: 1, folders: [{ name: '', count: 2 }], entries: [] },
      },
    ],
  },
  {
    id: 'folders',
    title: 'Folders',
    note: 'One level of grouping over the Saved set. A folder can exist while empty, and outlives the entries in it.',
    endpoints: [
      {
        id: 'folders-get',
        method: 'GET',
        path: '/folders',
        summary: 'Every folder with how much is in it. The root is the entry named "".',
        auth: 'required',
        response: {
          folders: [
            { name: '', count: 2 },
            { name: 'Checkout', count: 3 },
          ],
        },
      },
      {
        id: 'folders-post',
        method: 'POST',
        path: '/folders',
        summary: 'Create a folder, or rename one.',
        auth: 'required',
        body: {
          fields: [
            { name: 'name', type: 'string', note: 'Create. Creating one that exists is not an error.' },
            { name: 'from', type: 'string', note: 'Rename: the current name.' },
            { name: 'to', type: 'string', note: 'Rename: the new name. Entries follow it.' },
          ],
          examples: [
            { label: 'Create', value: { name: 'Checkout' } },
            { label: 'Rename', value: { from: 'Checkout', to: 'Checkout v2' } },
          ],
        },
        response: { name: 'Checkout', folders: [{ name: '', count: 2 }, { name: 'Checkout', count: 0 }] },
      },
      {
        id: 'folders-delete',
        method: 'DELETE',
        path: '/folders',
        summary: 'Delete a folder. Its entries return to the root unless you say otherwise.',
        auth: 'required',
        body: {
          fields: [
            { name: 'name', type: 'string', note: 'The folder to delete.' },
            { name: 'deleteEntries', type: 'boolean', note: 'Delete what was in it too. Default false.' },
          ],
          examples: [
            { label: 'Keep the entries', value: { name: 'Checkout' } },
            { label: 'Delete them too', value: { name: 'Checkout', deleteEntries: true } },
          ],
        },
        response: { affected: 3, folders: [{ name: '', count: 5 }], entries: [] },
      },
    ],
  },
  {
    id: 'live',
    title: 'Live',
    note: 'For following a designer while they work.',
    endpoints: [
      {
        id: 'events',
        method: 'GET',
        path: '/events',
        summary: 'Server-sent events: selection and connection changes.',
        auth: 'required',
        stream: true,
        responseNote:
          'text/event-stream, held open. Events: hello, plugin_connected, plugin_disconnected, selection_changed. Follow it with: curl -N',
      },
    ],
  },
  {
    id: 'account',
    title: 'Account',
    note: 'Only a hosted relay has these. A local one binds to 127.0.0.1 and asks for nothing.',
    endpoints: [
      {
        id: 'register',
        method: 'POST',
        path: '/auth/register',
        summary: 'Create an account and get its first token.',
        auth: 'none',
        body: {
          fields: [
            { name: 'email', type: 'string', note: 'Lowercased on the way in.' },
            { name: 'password', type: 'string', note: 'At least 10 characters.' },
          ],
          examples: [{ label: 'New account', value: { email: 'you@example.com', password: 'a long enough one' } }],
        },
        response: { email: 'you@example.com', room: '7ef9be28-ad3b-45bd-815e-3625f73fe097', token: '<48 hex characters>' },
      },
      {
        id: 'login',
        method: 'POST',
        path: '/auth/login',
        summary: 'Sign in. Issues a fresh token; older ones keep working until revoked.',
        auth: 'none',
        body: {
          fields: [
            { name: 'email', type: 'string', note: '' },
            { name: 'password', type: 'string', note: '' },
          ],
          examples: [{ label: 'Sign in', value: { email: 'you@example.com', password: 'a long enough one' } }],
        },
        response: { email: 'you@example.com', room: '7ef9be28-ad3b-45bd-815e-3625f73fe097', token: '<48 hex characters>' },
      },
      {
        id: 'me',
        method: 'GET',
        path: '/auth/me',
        summary: 'Which account a token belongs to. 401 once it is revoked.',
        auth: 'required',
        response: { email: 'you@example.com', room: '7ef9be28-ad3b-45bd-815e-3625f73fe097' },
      },
      {
        id: 'revoke',
        method: 'POST',
        path: '/auth/revoke',
        summary: 'Revoke the token you present. This is what Sign out does.',
        auth: 'required',
        response: { revoked: true },
      },
    ],
  },
  {
    id: 'docs',
    title: 'Docs and skill',
    note: 'Public: they describe the API, not any file.',
    endpoints: [
      {
        id: 'docs-json',
        method: 'GET',
        path: '/docs.json',
        summary: 'This manual as structured sections.',
        auth: 'none',
        response: { sections: [{ heading: 'What it does', blocks: ['…'] }] },
      },
      {
        id: 'docs-md',
        method: 'GET',
        path: '/docs.md',
        summary: 'This manual as Markdown, for pasting into an agent.',
        auth: 'none',
        responseNote: 'text/markdown.',
      },
      {
        id: 'skill',
        method: 'GET',
        path: '/skill',
        summary: 'The Claude Code skill files, with this relay’s address baked in.',
        auth: 'none',
        response: {
          note: 'Install these into a project as-is.',
          files: [{ path: '.claude/skills/figsnap/SKILL.md', bytes: 4210, contents: '…' }],
        },
      },
    ],
  },
]

/** Every endpoint, flattened, for callers that do not care about grouping. */
export function allEndpoints() {
  return groups.flatMap((group) => group.endpoints)
}

/** The docs table, generated so it cannot fall behind this list. */
export function endpointTableRows() {
  return allEndpoints().map((endpoint) => [endpoint.method, endpoint.path, endpoint.summary])
}

/** The headers a request needs, as a client would write them. */
export function requestHeaders(endpoint) {
  const headers = []
  if (endpoint.auth !== 'none') headers.push(TOKEN_HEADER)
  if (endpoint.body) headers.push('content-type: application/json')
  return headers
}

/** The runnable form, for a terminal or a copy button. */
export function curlFor(endpoint, { base, path, body, token }) {
  const parts = ['curl -s']
  if (endpoint.stream) parts.push('-N')
  if (endpoint.method !== 'GET') parts.push(`-X ${endpoint.method}`)
  if (endpoint.auth !== 'none') parts.push(`-H 'x-relay-token: ${token || '<your token>'}'`)
  if (body) parts.push("-H 'content-type: application/json'")
  parts.push(`${base}${path}`)
  if (body) parts.push(`\\\n  -d '${body}'`)
  return parts.join(' ')
}
