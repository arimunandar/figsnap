// The plugin's manual, held as data so it can be rendered three ways from one
// source: HTML for the panel, HTML for a browser, and Markdown for an agent.
//
// Inline markup in text is deliberately Markdown: `code` and **bold**. Markdown
// output passes it through untouched; the HTML renderer converts it.

import { endpointTableRows } from './endpoints.mjs'

/**
 * @typedef {{ httpBase: string, relayState: string, nodeId: string, surface?: 'panel' | 'http' }} DocsContext
 * @typedef {{ type: 'lead' | 'p', text: string }
 *   | { type: 'ul', items: string[] }
 *   | { type: 'code', text: string }
 *   | { type: 'table', head: string[], rows: string[][] }
 *   | { type: 'h3', text: string }} Block
 */

/** @param {DocsContext} context @returns {{ heading: string, blocks: Block[] }[]} */
export function docsSections({ httpBase, relayState, nodeId, surface = 'http' }) {
  const connected = relayState === 'open'

  const isPublic = surface === 'public'

  /** @type {Block[]} */
  const relayBlocks = [
    {
      type: 'p',
      text:
        'A Figma plugin cannot be reached from outside Figma and cannot host a server, so it dials out instead: the plugin opens a WebSocket to a small relay on your machine, and the relay exposes plain HTTP. That is why the transport is a socket and not REST — a program needs to *ask* for nodes, not only receive what the plugin decides to push.',
    },
    { type: 'code', text: 'your program  --REST/SSE-->  relay  <--WS--  this plugin' },
    {
      type: 'p',
      text:
        'The relay runs either on your own machine (`npm run relay`, bound to `127.0.0.1`) or on Cloudflare, where a Durable Object holds the socket because a Worker cannot. The plugin does not care which: pick the address on the Relay page. A hosted relay has accounts and always requires a token, and two routes stay local-only — `/fs` and `/skill/install` need a filesystem, so a hosted one answers `501`.',
    },
  ]

  if (isPublic) {
    relayBlocks.push(
      {
        type: 'p',
        text:
          'The relay runs on **your own machine**, not on the host serving this page. Nothing about any Figma file passes through here: this address serves documentation and the skill files, and holds no connection to any plugin. The endpoints below answer on your local relay once you start it.',
      },
      { type: 'code', text: 'npm run relay' },
    )
  } else {
    relayBlocks.push({
      type: 'p',
      text: connected
        ? 'Relay status right now: **connected**.'
        : `Relay status right now: **not connected (${relayState})**. Start it with:`,
    })
    if (!connected) relayBlocks.push({ type: 'code', text: 'npm run relay' })
  }

  return [
    {
      heading: 'Figsnap',
      blocks: [
        {
          type: 'lead',
          text:
            'Pick a layer in a Figma file and get four things back: a PNG of it, a React component, a stylesheet, and Figma’s own CSS. Anything the panel can do, an external program can do over HTTP.',
        },
      ],
    },
    {
      heading: 'The three columns',
      blocks: [
        {
          type: 'p',
          text:
            'Left is *what to extract*, centre is *what it looks like*, right is *what it compiles to*. The left and right columns are independent, so a list stays visible while you read code.',
        },
      ],
    },
    {
      heading: 'Choosing what to extract',
      blocks: [
        {
          type: 'p',
          text:
            'Four tabs on the left, each with the same shape: a header strip, a list, and one primary button underneath. Two different actions:',
        },
        {
          type: 'ul',
          items: [
            '**Click any row** — extracts that one node into the preview and the code pane.',
            '**The primary button** — runs the whole visible list as a batch and writes each result back onto its own row: `FRAME · 13 layers` on success, the error text on failure.',
          ],
        },
        {
          type: 'table',
          head: ['Tab', 'List', 'Primary button'],
          rows: [
            ['Nodes', 'the page tree, expandable', 'none — click a row'],
            ['Selection', 'what is selected on canvas', 'Extract N selected'],
            ['Saved', 'the set you curated', 'Extract N saved'],
            ['Links', 'links you queued one at a time', 'Extract N links'],
          ],
        },
        {
          type: 'p',
          text:
            'In the Nodes tree, **Cmd-click** adds a row to the canvas selection instead of replacing it, so you can build a multi-selection without leaving the panel. Selecting several layers on canvas shows a summary instead of a preview: exporting all of them automatically would be slow and surprising.',
        },
      ],
    },
    {
      heading: 'The Saved set',
      blocks: [
        {
          type: 'p',
          text:
            'Re-selecting the same layers every session is the tedious part. Select layers, press **Save selection**, and they persist — across plugin runs and Figma restarts. Names and types are re-read from the file each time the set loads, so a renamed layer shows its new name and a deleted one greys out and says so rather than failing silently later. Up to 100 entries.',
        },
        {
          type: 'p',
          text:
            'Storage is `figma.clientStorage` keyed by document id: per user, per file, writable even in a file you can only view, and it never modifies the file. It does not travel to teammates.',
        },
        { type: 'h3', text: 'Folders' },
        {
          type: 'p',
          text:
            'Press **+** in the Saved pane to make a folder. Chips along the top switch between **All** and each folder; whichever is showing is where **Save selection** puts the next layers, and what the primary button extracts. A row’s dropdown moves that entry somewhere else. Folders are **one level deep** — a narrow list is a bad place for a tree, and grouping a curated set of screens rarely needs more.',
        },
        {
          type: 'p',
          text:
            'A folder exists in its own right: it survives being emptied, and deleting it returns its entries to the root rather than throwing them away. The **✎** button renames the folder currently showing, and offers to delete it. Up to 30 folders.',
        },
        {
          type: 'p',
          text:
            'Over HTTP the same set is at `/saved` and `/folders`. `GET /saved?folder=Checkout` narrows the listing, `POST /saved` takes a `folder`, `POST /saved/move` moves entries between folders, and `POST /extract` with `{ "saved": true, "folder": "Checkout" }` extracts just that folder as a batch.',
        },
      ],
    },
    {
      heading: 'Working from links',
      blocks: [
        {
          type: 'p',
          text:
            'Paste a Figma link in the Links tab and press Enter. The `node-id=21-10314` in a Figma URL uses dashes; it is rewritten to the `21:10314` the API expects. A link that is not a Figma URL, or has no node id, is rejected as you add it rather than at extraction time. `/file`, `/design`, `/proto`, `/board` and `/slides` all parse.',
        },
        {
          type: 'p',
          text:
            'A plugin can only read the file it is running in, so a link to another file is refused with that file’s key in the message. Links to other pages of *this* file work: the plugin loads the pages and switches to the right one.',
        },
      ],
    },
    {
      heading: 'Controls',
      blocks: [
        {
          type: 'table',
          head: ['Control', 'Effect'],
          rows: [
            ['Scale', 'PNG resolution, 1× to 4×'],
            ['Top layer only', 'describe just the picked node, no descendants'],
            ['Inline instances', 'walk into instances instead of emitting a component tag for them'],
            ['Save selection', 'add the current canvas selection to the Saved set, into whichever folder is showing'],
          ],
        },
      ],
    },
    {
      heading: 'The five outputs',
      blocks: [
        { type: 'h3', text: 'React' },
        {
          type: 'p',
          text:
            'A `.tsx` component. Frames become `div`s, text becomes `span`s with their content, and nested instances become JSX tags with import stubs at the top. Component properties on the root become typed props; variant properties become string-literal unions.',
        },
        { type: 'code', text: '<SelectionList className={s.selectionList} type="Multi Select" state="Selected" />' },
        {
          type: 'p',
          text:
            'Two things to know. Props are *declared but not wired*: Figma reports which variant is currently active, not which layers each variant swaps. And variant values are always strings — `sticky="False"` is the string "False", while a real boolean property appears bare as `rightText`.',
        },
        { type: 'h3', text: 'HTML' },
        {
          type: 'p',
          text:
            'A whole page, not a fragment: styles and markup in one file you can save and open. It is the React output rendered as plain markup — the same deduped class names, the same real text — plus the things Dev Mode CSS leaves out and a browser needs.',
        },
        {
          type: 'ul',
          items: [
            '**Icons become SVG.** Dev Mode describes a vector with `fill` and `stroke-width`, which are SVG properties and do nothing on a `div`, so icons used to render as empty boxes. A layer that is nothing but vectors is exported once as `SVG_STRING` and inlined; its wrapper layers collapse with it.',
            '**`position: relative`** is added to any layer with an absolutely positioned child. Figma never emits it, and without it the child is placed against the page.',
            '**Stroked layers get their size pinned.** A Figma stroke is drawn inside the bounds, but Dev Mode omits a height it considers content-derived, so the border would add to it.',
            '**The font is requested and given a fallback.** `font-family: Inter` alone falls back to the browser default — a serif — so the page links the face it needs and appends a generic family.',
            '**The root gets its own width and height**, which Dev Mode leaves to a parent that does not exist outside Figma.',
          ],
        },
        { type: 'h3', text: 'Module CSS' },
        {
          type: 'p',
          text: 'The same rules with camelCase class names, matching the `className={s.x}` references in the React output.',
        },
        { type: 'h3', text: 'CSS' },
        {
          type: 'p',
          text:
            '`getCSSAsync()` — the properties Figma shows in its inspect panel, kebab-case, indented to mirror the layer tree. Design tokens survive as real references, which is its main advantage:',
        },
        {
          type: 'code',
          text: 'padding: var(--Spacing-Extra-Large, 16px);\nbackground: var(--Color-Brand-color-B1-Brand-color, #624CF7);',
        },
        {
          type: 'p',
          text:
            'It is not a stylesheet. The rules are flat with no parent-child relationship, and it carries no positional data at all — on a design that does not use auto layout you will get very little. It also stops at instance boundaries, so text and styling inside a component do not appear unless you check Inline instances.',
        },
        { type: 'h3', text: 'Figma CSS' },
        {
          type: 'p',
          text:
            'Figma’s older *Copy as CSS* format: flat declarations under layer-name comments, explicit width and height, raw hex colours, absolute geometry from each node’s constraints, and the `Inside auto layout` block. The plugin API does not expose that generator, so this is rebuilt from `layoutMode`, `constraints`, `fills`, `strokes` and geometry.',
        },
        {
          type: 'p',
          text:
            'Use it where Dev Mode CSS is blind: absolutely positioned children, gradient fills, and the inside of instances (it always walks in). Its cost is size and noise — a single logo icon can produce eighty `Vector` blocks that nobody would hand-code. Export icons as SVG instead.',
        },
      ],
    },
    {
      heading: 'Driving the plugin from outside',
      blocks: [
        ...relayBlocks,
        { type: 'h3', text: 'Signing in' },
        {
          type: 'p',
          text:
            'A fresh install points at the hosted relay, so the plugin opens on a sign-in form: an email and a password, in the panel, no browser. The relay answers with a token, the plugin stores it, and the socket and the HTTP API come up on their own. Reopening the plugin resumes that session; if the relay refuses the token the form comes back rather than the socket retrying forever.',
        },
        {
          type: 'p',
          text:
            'Each account gets its own room, so a token reaches the designs of the plugin signed in as that same account and nobody else’s. Passwords are stored as a chained PBKDF2 hash and tokens only as a SHA-256 hash, so neither can be read back out of the relay.',
        },
        { type: 'h3', text: 'Pointing the plugin at a relay' },
        {
          type: 'p',
          text:
            'A local relay is the other option — `ws://localhost:3055/plugin`, no accounts, since it binds to `127.0.0.1` — and it is the only kind with a filesystem, so `/fs` and `/skill/install` need it. Switch between them on the Relay page; each address remembers its own token, and nothing needs recompiling. A token is sent as `x-relay-token` on requests and as `?token=` on the socket.',
        },
        {
          type: 'code',
          text: 'RELAY_PORT=3055 RELAY_TOKEN=$(openssl rand -hex 16) npm run relay',
        },
        {
          type: 'p',
          text:
            'One catch that is not the plugin’s doing: Figma blocks any network address the manifest does not list. `manifest.json` allows port 3055 out of the box, so a different port means editing `networkAccess.devAllowedDomains` and re-importing the plugin — Figma caches the manifest.',
        },
        { type: 'h3', text: 'Walking the tree' },
        {
          type: 'p',
          text:
            '`/tree` and `/children/:id` return one level by default. `?depth=N` walks N levels and nests the descendants under a `children` array on each row; `?depth=all` goes to the bottom. A row with a `childCount` above zero and no `children` array is where to ask again.',
        },
        {
          type: 'p',
          text:
            'A deep walk is capped at 300 siblings per level and 2000 nodes overall, and `truncated` says whether either limit bit. A real design page is mostly vectors nobody needs, so `depth=2` or `3` usually beats `all`.',
        },
        { type: 'h3', text: 'Choosing the outputs' },
        {
          type: 'p',
          text:
            '`/extract` returns every output unless told otherwise, and `figmaCss` alone can run to tens of kilobytes. `format` takes one name or a list from `png`, `html`, `tsx`, `moduleCss`, `css` and `figmaCss`; only those keys come back, and `outputs` echoes what was produced. An unknown name is refused rather than ignored, since silently returning nothing looks like an empty node.',
        },
        {
          type: 'code',
          text: `curl -s -X POST ${httpBase}/extract \\\n  -H 'content-type: application/json' \\\n  -d '{"nodeId":"${nodeId}","format":["tsx","moduleCss"]}'`,
        },
        {
          type: 'p',
          text:
            'One name is outside the default: `pngData` returns the image itself, base64 in the body as `{ dataUri, bytes, scale }`, instead of the `png` URL that re-renders on request. It makes a response stand alone at the cost of roughly a third more than the file, every time — ask for it when nothing will be able to fetch the URL later.',
        },
        { type: 'h3', text: 'Endpoints' },
        {
          type: 'p',
          text:
            'The plugin panel lists every one of these on its **Relay** page, with the request it expects, an editable body and a **Send** button that fires the real call — the quickest way to see a real response before writing any code.',
        },
        {
          type: 'table',
          head: ['Method', 'Path', 'Purpose'],
          // Generated from the same catalogue the panel's API browser renders,
          // so a new endpoint cannot appear in one and not the other.
          rows: endpointTableRows(),
        },
        { type: 'h3', text: 'One node or many' },
        { type: 'p', text: 'The body of `/extract` decides which:' },
        {
          type: 'table',
          head: ['Body', 'Result'],
          rows: [
            ['`{}`', 'the first selected node, single object'],
            [`\`{ "nodeId": "${nodeId}" }\``, 'that node'],
            ['`{ "url": "…?node-id=21-10314" }`', 'that node'],
            ['`{ "selection": true }`', 'every selected node, batch'],
            ['`{ "saved": true }`', 'the Saved set, batch'],
            ['`{ "saved": true, "folder": "Checkout" }`', 'one folder of it, batch'],
            ['`{ "nodeIds": [ … ] }`', 'those nodes, batch'],
            ['`{ "urls": [ … ] }`', 'those links, batch'],
          ],
        },
        {
          type: 'p',
          text:
            'When more than one is present the order of precedence is `urls`, `nodeIds`, `selection`, `saved`. Any call also accepts `scale`, `topLayerOnly` and `inlineInstances`.',
        },
        {
          type: 'code',
          text: `curl -s -X POST ${httpBase}/extract \\\n  -H 'content-type: application/json' \\\n  -d '{"nodeId":"${nodeId}","scale":2}'`,
        },
        {
          type: 'p',
          text:
            'A batch returns `{ results: [ … ] }`, one entry per input, each either `{ ok: true, extraction }` or `{ ok: false, error }`, with `ref` echoing what you passed. One bad entry never fails the rest. Up to 20 entries per call, run in order.',
        },
        {
          type: 'p',
          text:
            'The PNG is not inlined as base64: every extraction carries `png: { url, bytes }`, which keeps responses small enough to hand straight to a language model. Fetching that URL **renders the node again** through the live socket. Nothing is cached and nothing is stored, so no part of a design is ever at rest in the relay — the trade is that an image URL only works while the plugin is connected, and the response is marked `no-store`.',
        },
        { type: 'h3', text: 'A whole agent loop' },
        {
          type: 'code',
          text: `curl -s ${httpBase}/tree                       # find a node\ncurl -s -X POST ${httpBase}/extract \\\n  -H 'content-type: application/json' \\\n  -d '{"nodeId":"${nodeId}"}'                  # code + png.url\ncurl -s "<png.url from the response>" -o node.png`,
        },
        {
          type: 'p',
          text:
            'Or let the designer curate: they press Save selection in the panel, and the program asks for `{ "saved": true }` whenever it needs the current definition of "the components we care about". Folders narrow that further — `{ "saved": true, "folder": "Checkout" }` is one screen’s worth. No ids passed around.',
        },
        { type: 'h3', text: 'Security' },
        {
          type: 'p',
          text:
            'The relay listens on `127.0.0.1` only. Without a token, any process on your machine can read the open Figma file through it. Set `RELAY_TOKEN` before starting the relay to require one, sent as an `x-relay-token` header, and append `?token=…` to the plugin’s relay URL to match. `/health` and the docs stay readable without it.',
        },
      ],
    },
    {
      heading: 'Install the Claude Code skill',
      blocks: [
        {
          type: 'p',
          text:
            'This relay is most useful to an agent that knows the endpoints, the caveats, and which of the four outputs to reach for. Installing the skill writes that knowledge into a project as `.claude/skills/figsnap/SKILL.md`, plus a `figsnap-extractor` agent that pulls several nodes and reports back a summary instead of tens of kilobytes of CSS.',
        },
        {
          type: 'p',
          text:
            'The skill has the relay address baked in, so it is generated per install rather than copied. Claude Code picks it up in that project with no further setup.',
        },
        {
          type: 'p',
          text:
            'The plugin does this for you: the **Relay** page has a directory browser and an **Install here** button, against a relay running on your own machine. Over HTTP it is two calls.',
        },
        {
          type: 'code',
          text: `# read the files\ncurl -s ${httpBase}/skill\n\n# write them into a project\ncurl -s -X POST ${httpBase}/skill/install \\\n  -H 'content-type: application/json' \\\n  -d '{"directory":"/path/to/your/project"}'`,
        },
        {
          type: 'p',
          text:
            'An existing install is never overwritten silently: the call answers `409` and lists the files, and you repeat it with `force: true` to replace them.',
        },
      ],
    },
    {
      heading: 'When something looks wrong',
      blocks: [
        {
          type: 'table',
          head: ['Symptom', 'Cause'],
          rows: [
            [
              'Relay dot yellow, "unreachable"',
              'The relay is not running, or the manifest was changed without re-importing the plugin. Figma caches the manifest, and network access is declared there.',
            ],
            [
              '"Stopped after 500 layers"',
              'You picked something too big — usually a group of whole screens. Extract one frame at a time.',
            ],
            [
              'Copy PNG does nothing',
              'Figma’s UI iframe blocks image clipboard writes in some builds. Use Download PNG.',
            ],
            [
              'A layer is missing from the CSS',
              'Invisible layers are skipped, and instance interiors need Inline instances. The Figma CSS tab always walks in and marks hidden layers `display: none`.',
            ],
            ['Text is missing from the output', 'It is inside an instance. Check Inline instances and extract again.'],
          ],
        },
      ],
    },
    {
      heading: 'Limits worth knowing',
      blocks: [
        {
          type: 'ul',
          items: [
            'Extraction stops after 500 layers; a child list stops after 300 rows; a batch takes 20 entries.',
            'The generated React is a starting point. What carries over reliably: tree structure, class names, text content, instance boundaries, component property names and types.',
            'Instance tags receive a `className`, which assumes your components forward it.',
          ],
        },
      ],
    },
  ]
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (char) => ESCAPES[char])
}

/** Converts the Markdown-ish inline markup the sections are written in. */
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
}

/** @param {DocsContext} context */
export function renderDocsHtml(context) {
  const sections = docsSections(context)
  const parts = ['<article class="doc">']

  sections.forEach((section, index) => {
    parts.push(index === 0 ? `<h1>${inline(section.heading)}</h1>` : `<h2>${inline(section.heading)}</h2>`)
    for (const block of section.blocks) {
      if (block.type === 'lead') parts.push(`<p class="doc-lead">${inline(block.text)}</p>`)
      else if (block.type === 'p') parts.push(`<p>${inline(block.text)}</p>`)
      else if (block.type === 'h3') parts.push(`<h3>${inline(block.text)}</h3>`)
      else if (block.type === 'code') parts.push(`<pre class="doc-code">${escapeHtml(block.text)}</pre>`)
      else if (block.type === 'ul') {
        parts.push('<ul>' + block.items.map((item) => `<li>${inline(item)}</li>`).join('') + '</ul>')
      } else if (block.type === 'table') {
        const head = block.head.map((cell) => `<th>${inline(cell)}</th>`).join('')
        const rows = block.rows
          .map((row) => '<tr>' + row.map((cell) => `<td>${inline(cell)}</td>`).join('') + '</tr>')
          .join('')
        parts.push(`<table class="doc-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`)
      }
    }
  })

  parts.push('</article>')
  return parts.join('\n')
}

/** @param {DocsContext} context */
export function renderDocsMarkdown(context) {
  const sections = docsSections(context)
  const lines = []

  sections.forEach((section, index) => {
    lines.push(`${index === 0 ? '#' : '##'} ${section.heading}`, '')
    for (const block of section.blocks) {
      if (block.type === 'lead' || block.type === 'p') lines.push(block.text, '')
      else if (block.type === 'h3') lines.push(`### ${block.text}`, '')
      else if (block.type === 'code') lines.push('```', block.text, '```', '')
      else if (block.type === 'ul') {
        for (const item of block.items) lines.push(`- ${item}`)
        lines.push('')
      } else if (block.type === 'table') {
        lines.push(`| ${block.head.join(' | ')} |`)
        lines.push(`| ${block.head.map(() => '---').join(' | ')} |`)
        for (const row of block.rows) lines.push(`| ${row.join(' | ')} |`)
        lines.push('')
      }
    }
  })

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
