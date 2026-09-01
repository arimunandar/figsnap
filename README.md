# Figsnap

A Figma plugin that lists the current page as a node tree the moment it opens,
then extracts any node you pick: a PNG render, a React component, a CSS module,
and plain CSS. Built with TypeScript and bundled with esbuild.

## What it does

Opening the plugin reads `figma.currentPage.children` and shows them as a tree —
no selection needed. Rows expand on demand (children are fetched per click, so a
large file is not walked up front). Clicking a row selects that node on canvas,
zooms to it, and extracts it. Selecting on canvas works too, debounced by 250ms.

Four tabs for the picked node:

- **Nodes** — the tree. Name, type, child count.
- **React** — a `.tsx` component. Frames become `div`s, text becomes `span`s with
  their content, and nested instances become JSX tags (`<Checkbox size="Large" />`)
  with import stubs at the top. Component properties on the root become typed
  props with defaults; variant properties become string-literal unions.
- **Module CSS** — the same rules with camelCase class names, matching the
  `className={s.x}` references in the React output.
- **CSS** — `getCSSAsync()` output with kebab-case classes, indented to mirror the
  layer tree.

Plus a PNG of the node at 1x–4x, with Copy and Download.

Toggles:

- **Top layer only** — extract just the picked node, no descendants.
- **Inline instances** — recurse into instances instead of emitting a JSX tag for
  them. Use this when there is no component library on the code side.

## Layout

```
manifest.json      Plugin manifest Figma reads
build.mjs          esbuild build; inlines the UI into a single HTML file
src/code.ts        Main thread: tree, export, CSS/TSX generation
src/ui/main.ts     UI thread: tree rendering, tabs, clipboard, download
src/ui/bridge.ts   UI thread: WebSocket link to the relay
server/relay.mjs   Local relay: WebSocket to the plugin, REST + SSE to agents
src/ui/index.html  UI template; build.mjs fills in <!-- STYLE --> and <!-- SCRIPT -->
src/ui/style.css   Styles, using Figma's theme variables
src/globals.d.ts   Pulls in @figma/plugin-typings
shared/docs.mjs    The manual as data, plus HTML and Markdown renderers
shared/skill.mjs   The Claude Code skill and agent this plugin installs
worker/            Optional Cloudflare Worker serving the docs publicly
test/              Suites; each starts its own relay and fake plugin
dist/              Build output (git-ignored); manifest.json points here
```

## The panel

A wide two-pane window (960×720 by default, resizable — the size is remembered per
file). The left pane is *what to extract*, the right pane is *what came out*, and
they are independent, so a list stays visible while you read the code.

Left, four source tabs, each with the same shape — a header strip, a list, and one
primary button underneath:

| Tab | List | Primary button |
| --- | --- | --- |
| **Nodes** | the page tree, expandable | none — clicking a row extracts it |
| **Selection** | what is selected on canvas | `Extract N selected` |
| **Saved** | the set you curated, optionally in folders | `Extract N saved` |
| **Links** | links you queued one by one | `Extract N links` |

There is exactly one primary button, always in the same place, and its label says
what it will do. Clicking any single row extracts that one node immediately; the
primary button runs the whole visible list as a batch and writes each node's
result back onto its own row — `FRAME · 13 layers` on success, the error text on
failure. That is the difference between the two: a row click is one node into the
preview, the primary button is the whole list with per-row pass/fail.

Centre: the PNG preview and the export controls (scale, Top layer only, Inline
instances, Save selection).

The plugin opens on a sign-in form when it has no session — see *Signing in*
below. After that there are two views, switched from the top bar: the workspace
and the **Relay** page, which holds the account, the connection, the settings,
the API browser and the Claude Code skill installer. Escape returns to the
workspace. The manual itself lives on the relay, at `/docs`.

**–** in the top bar minimises the panel to a 340×40 strip, so the canvas is
clear while you go and find a layer. The socket stays up and selection keeps
arriving: the strip names whatever you click, with its type and size, so you can
line a selection up and then restore. Clicking anywhere on the strip restores it.
While minimised the automatic preview is skipped — there is nowhere to show it,
and clicking around the canvas is the point — and the shrunken window is not
stored as the size you chose, so restoring returns to whatever you had dragged
it to.

Right: the generated output in a read-only editor with line numbers and syntax
highlighting — five tabs:

| Tab | Contents |
| --- | --- |
| **React** | the `.tsx` component |
| **HTML** | a whole page — styles, markup, icons as inline SVG — that opens as the design |
| **Module CSS** | camelCase classes matching its `className={s.x}` references |
| **CSS** | `getCSSAsync()` output, kebab-case, tree-indented |
| **Figma CSS** | Figma's legacy Copy-as-CSS format, regenerated from node properties |

The HTTP API has its own browser on the **Relay** page — see *Trying the API*
below.

## Setup

Requires **Node 20 or newer** and the **Figma desktop app** — local plugins cannot
be loaded in the browser.

```bash
git clone <this repo> && cd figma-plugin
npm install
npm run build
```

Then in Figma: **Plugins > Development > Import plugin from manifest**, and choose
this folder's `manifest.json`. Build at least once first, or the manifest points at
files that do not exist yet.

Run it with **Plugins > Development > Figsnap**, or Option-Command-P to
re-run the last plugin.

That is the whole setup for the panel. The relay below is only needed if you want
the HTTP API.

## Running the relay

```bash
npm run relay
```

It listens on `127.0.0.1:3055`. The plugin connects on open — the **Relay**
checkbox and status dot in the panel show the state, and it retries with backoff
while the relay is down.

Two environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_PORT` | `3055` | the port to listen on |
| `RELAY_TOKEN` | *(none)* | require a token on every request |

```bash
RELAY_TOKEN=$(openssl rand -hex 16) npm run relay
```

Without a token, **any process on your machine** can read the open Figma file
through the relay, browse directories, and write `.claude` files into a project.
That is contained — the relay never leaves `127.0.0.1` — but set a token before
using this for anything beyond local experimenting.

### Signing in

A fresh install points at the hosted relay, so the plugin opens on a sign-in
form: an email and a password, in the panel, no browser and no terminal. **Create
account** and **Sign in** are the same form. From there everything is automatic —
the token is stored, the WebSocket connects, one `/health` call confirms the HTTP
API, and the workspace appears with all three steps ticked off.

    Install plugin -> open plugin -> sign in -> socket -> HTTP API -> ready

The session is stored in `figma.clientStorage`, which is per user and outside the
project, so reopening the plugin resumes it without asking again. If the relay
ever refuses the token — revoked, or a redeployed relay with a fresh database —
the form comes back with *That session has expired* instead of the socket
retrying forever. **Sign out** on the Relay page revokes the token on the relay
and drops it here.

Only a hosted relay (`wss://`) has accounts. A local one binds to `127.0.0.1`, so
it asks for nothing and the gate does not appear; **Use a local relay** on the
form switches to it.

The relay also serves `/login` as an ordinary web page, which is the better place
to type a password if you want a password manager to fill it. Its pairing flow —
short code, single-use token hand-off — still works and is what an older build
used.

### Trying the API

The **Relay** page ends with a browser for the whole HTTP surface: every endpoint
grouped by purpose, each one expanding to its request headers, its body fields
with types, a set of example bodies you can click, an editable JSON body, and the
response shape it returns.

**Send** fires the real request against the address in Settings with your token
and prints the live response in place, with the status and the round-trip time.
**Copy curl** gives you the same call for a terminal. A node-id field at the top
fills every `:id` and `:nodeId` placeholder and follows your canvas selection, so
the examples are runnable as shown.

Long strings in a response — the generated `tsx`, `css` and `figmaCss` — are
shown as `… (N chars)` so the shape of the answer stays readable. The endpoint
list is generated from `shared/endpoints.mjs`, the same file the relay's own
`/docs` table is built from, so the two cannot drift apart.

### Pointing the plugin at a relay

The panel has a **Relay** page, next to Docs. It shows the live connection state,
what the relay itself reports (whether it can see the plugin, whether a token is
required, requests in flight, cached images), the address and token fields, and
the commands to start the relay with a copy button on each.

Settings are stored per user, so nothing needs recompiling and nothing is
committed. Each address remembers its own token, so switching between a local and
a hosted relay is one click. A fresh install defaults to the hosted relay in
`src/relays.ts`; the local default is `ws://localhost:3055/plugin` with no token.

One catch that is not the plugin's doing: **Figma blocks any address the manifest
does not list.** `manifest.json` allows port 3055 out of the box. A different port
means editing `networkAccess.devAllowedDomains` and re-importing the plugin, since
Figma caches the manifest.

## Develop

```bash
npm run watch       # rebuild on save
npm run typecheck   # tsc --noEmit
npm test            # every suite
```

With the watch running, enable Plugins > Development > **Hot reload plugin** so
Figma picks up each rebuild. Manifest changes still need a re-import.

### Tests

`npm test` runs the suites in `test/`. Each one starts its own relay on its own
port with a fake plugin on the other end, so they need no Figma, no network access
and no shared state. `e2e-panel-auth.mjs` goes further and runs the shipped
`dist/ui.html` in jsdom against a relay in real `workerd`, with a stand-in for the
main thread, so the sign-in flow is tested as the panel actually performs it —
run `npm run build` first, since it reads the built file:

| Suite | Covers |
| --- | --- |
| `e2e-urls.mjs` | link parsing and the batch routes |
| `e2e-multi.mjs` | selection, id lists, and body precedence |
| `e2e-saved.mjs` | the saved set, including dedupe and overwrite refusal |
| `e2e-docs.mjs` | docs as HTML, Markdown and JSON, and the token exemption |
| `e2e-skill.mjs` | skill install, path rejection, CORS policy |
| `docs-render.mjs` | the docs and skill renderers, pure functions, no runtime |
| `e2e-worker-relay.mjs` | the hosted relay in real `workerd`: Durable Object, socket, token gate |
| `e2e-auth.mjs` | accounts, lockout, room scoping, revocation, and the CORS the panel needs |
| `e2e-panel-auth.mjs` | the built `dist/ui.html` in jsdom: sign in, auto-connect, resume, expiry, the API browser |
| `e2e-folders.mjs` | the real `dist/code.js` behind a relay: the saved store, folders, migration |
| `e2e-panel-folders.mjs` | the Saved pane's folder UI in the built panel |
| `e2e-panel-minimise.mjs` | minimising: what hides, what the main thread is told, what keeps working |
| `e2e-tree.mjs` | `?depth=` walks and the `format` picker, on the real main thread |

`npm test` never touches the network. To check a relay you have actually deployed:

```bash
npm run smoke -- wss://<host>/plugin
```

That stands a WebSocket client in for the plugin, so the whole hosted path is
exercised without Figma being open. The token comes from `RELAY_TOKEN`, or from
`.relay-token` if that file exists — which is gitignored, so a generated token
stays out of version control.

## Sharing it with other people

The panel needs no relay: preview, React, Module CSS, CSS, Figma CSS, saved sets
and links all run inside Figma with no network access at all. Only the HTTP API
needs a process running. That splits the audience:

| Audience | Needs | Gets it from |
| --- | --- | --- |
| Designers who want code out of Figma | the panel | the published plugin — one click, no Node |
| Developers and agents | panel + HTTP API | the plugin, plus one command for the relay |
| Contributors | the source | this repository |

### The relay without cloning

`server/relay.mjs` is an executable with no build step, so once this package is
published it runs straight from npm:

```bash
npx figsnap-relay          # add RELAY_TOKEN / RELAY_PORT as needed
```

The package is still marked `private`, so publishing is a deliberate act, not
something `npm publish` will do by accident. Only `server/`, `shared/`,
`worker/`, `manifest.json` and this README are packed — around 70 kB, no plugin
build output.

## Publishing the plugin

Two routes, and they differ in one important way.

**A private organization plugin** is published inside your Figma org, installable
in one click, and never listed publicly. It is the right route for a team: it
keeps `enablePrivatePluginApi`, so the wrong-file detection keeps working, and it
saves every designer from cloning, building and importing a manifest.

**The public Figma Community** requires two changes:

- **Remove `enablePrivatePluginApi`** from `manifest.json`. It is what makes
  `figma.fileKey` readable, which is how a link to the wrong file is detected. It
  is only permitted for private and development plugins.
- **`networkAccess`**: `allowedDomains` is `["none"]`, so a published build cannot
  reach anything. `devAllowedDomains` covers the local relay while running from
  Plugins > Development. A published plugin that should talk to a relay needs that
  address in `allowedDomains` instead.

`id` is assigned by Figma on first publish; the placeholder is correct until then.

## Hosting the relay on Cloudflare

`worker/` is the same relay on Cloudflare, plus the public docs. Deploy it when
the agent is not on the same machine as Figma — a cloud session, CI, or a
teammate reading the frame you have selected.

A Worker is stateless, and the relay's job is holding one WebSocket open and
matching replies to requests, so the socket lives in a **Durable Object**
(`worker/src/room.js`). It writes nothing to storage: the plugin owns the file and
the saved set, and images are re-rendered through the live socket rather than
cached, so no part of a design is ever at rest.

```bash
npm run worker:check                  # validate without deploying
npm run worker:dev                    # real workerd, locally
npx wrangler secret put RELAY_TOKEN   # optional; accounts cover this already
npm run worker:deploy                 # needs `wrangler login`
```

Change `name` in `worker/wrangler.jsonc` first. Then point the plugin at it on the
**Relay** page: `wss://<name>.<your-subdomain>.workers.dev/plugin`, then sign in.
Setting `HOSTED_RELAY_URL` in `src/relays.ts` makes it the address a fresh install
opens against.

Three differences from running it locally:

- **A token is mandatory**, and normally comes from an account: sign in from the
  plugin, or at `/login`. Without one the API answers `401` and only the docs are
  readable — on a public address there is no `127.0.0.1` to hide behind. A shared
  `RELAY_TOKEN` secret still works for a single-room deployment.
- **`/fs` and `/skill/install` answer `501`.** A Worker has no filesystem, so
  browsing directories and installing the skill stay local. Fetch `/skill` and
  write the files yourself, or run the local relay for that.
- **`manifest.json` must list the address.** Add
  `wss://<name>.<subdomain>.workers.dev` to `networkAccess.devAllowedDomains`
  (or `allowedDomains` for a published plugin) and re-import the plugin. List the
  exact host rather than `wss://*.workers.dev`: a wildcard lets the plugin reach
  every Worker on the internet, not only yours. The committed manifest points at
  one deployment, so change it to your own.

Deploying without `RELAY_TOKEN` gives you the docs and the skill files on a public
URL and nothing else — the API stays shut. `vars.RELAY_BASE` then fills in the
printed commands, pointing readers at the relay they run themselves.

## How the two threads talk

The main thread and the UI run in separate sandboxes and exchange messages:

- UI to main: `parent.postMessage({ pluginMessage: {...} }, '*')`
- Main to UI: `figma.ui.postMessage({...})`, received as `event.data.pluginMessage`

## Limits worth knowing

- The generated React is a starting point, not a finished component. Props are
  declared but not wired to the markup: Figma reports which variant is currently
  active, not which layers each variant swaps. The tree, the class names, the
  text content and the instance boundaries are the parts that carry over.
- `getCSSAsync()` returns the properties Figma shows in its inspect panel. There
  is no layout relationship between the rules; nothing is nested.
- Extraction stops after 500 layers; a child list stops after 300 rows.
- Invisible layers are skipped everywhere.
- Image clipboard writes are blocked in some Figma builds, so **Download PNG** is
  the reliable path. Text copy falls back to `execCommand('copy')`.

## Sending nodes to an AI agent

The plugin cannot be reached from outside Figma and cannot host a server, so it
dials out instead. `server/relay.mjs` holds that WebSocket and exposes a plain
HTTP API, which is what an agent talks to:

```
AI agent  --REST/SSE-->  relay (127.0.0.1:3055)  <--WS--  Figma plugin UI
```

WebSocket is the transport between plugin and relay because the agent needs to
*ask* for nodes, not only receive pushes. REST alone would leave the plugin
polling; SSE alone is one-directional.

### Endpoints and bodies

### A saved set

Re-selecting the same layers every session is the tedious part, so the panel keeps
a set. Select layers, press **Save selection** in the **Saved** tab, and they stay
there — across plugin runs and across Figma restarts. The list shows each entry's
current name and type; click one to jump to it on canvas, press the minus to drop
it, or **Extract all** to run the whole set as a batch.

Entries are re-checked against the file every time the set loads, so a layer
deleted since it was saved shows greyed out and labelled rather than failing
silently. Up to 100 entries.

Storage is `figma.clientStorage`, keyed by document id. That means the set is per
user and per file, always writable even in a file the user can only view, and it
never modifies the file itself. It does not travel to teammates — switching to
`figma.root.setPluginData` would make it shared but would require edit access and
would show up as a file change.

#### Folders

Press **+** in the Saved pane to make a folder. Chips along the top switch between
**All** and each folder: whichever is showing is where **Save selection** puts the
next layers and what the primary button extracts, and both say so
(`Save selection to Checkout`, `Extract 2 in Checkout`). In the **All** view the
list groups under folder headings; a dropdown on each row moves that entry
somewhere else. **✎** renames the folder on screen and offers to delete it.

Folders are **one level deep**, on purpose: the Saved pane is a narrow list, a
tree in it costs more to navigate than the grouping saves, and a slash in a folder
name is refused rather than quietly implying nesting. Up to 30 folders.

A folder is a thing in its own right, not just a label that happens to be shared:
it can exist while empty, it survives being emptied, and deleting it returns its
entries to the root rather than throwing them away (`deleteEntries: true` if you
do want them gone). Saving something already saved moves it instead of
duplicating it.

An older set — a flat list with no folders — loads unchanged, with every entry at
the root; the next write is in the new shape.

Agents get the same set:

```bash
curl -s localhost:3055/saved                       # what is in the set

curl -s -X POST localhost:3055/saved \
  -H 'content-type: application/json' -d '{"selection":true}'

curl -s -X POST localhost:3055/saved \
  -H 'content-type: application/json' -d '{"nodeIds":["21:10314"]}'

curl -s -X POST localhost:3055/extract \
  -H 'content-type: application/json' -d '{"saved":true}'

curl -s -X DELETE localhost:3055/saved \
  -H 'content-type: application/json' -d '{"nodeIds":["21:10314"]}'
curl -s -X DELETE localhost:3055/saved \
  -H 'content-type: application/json' -d '{"all":true}'
```

This is the useful handshake for an agent: the designer curates a set once, the
agent asks for `{"saved":true}` whenever it needs the current definition of "the
components we care about".

### Multiple nodes at once

Select several layers on canvas and the panel shows `N layers selected` instead of
a preview — extracting every one of them automatically would be slow and
surprising. Press **Extract selection** in the **Batch** tab to run them all, or
Cmd-click rows in the **Nodes** tree to build the selection without leaving the
panel.

Over HTTP, `POST /extract` takes either one node or a batch:

| Body | Result |
| --- | --- |
| `{}` | the first selected node, single object |
| `{ "nodeId": "21:10314" }` | that node, single object |
| `{ "url": "https://…?node-id=21-10314" }` | that node, single object |
| `{ "selection": true }` | every selected node, batch |
| `{ "nodeIds": ["21:10314", "21:10384"] }` | those nodes, batch |
| `{ "urls": [...] }` or a text blob | those links, batch |
| `{ "saved": true }` | the saved set, batch |
| `{ "saved": true, "folder": "Checkout" }` | one folder of it, batch |

`format` picks what comes back: one name or a list from `png`, `html`, `tsx`,
`moduleCss`, `css`, `figmaCss`. That set is the default, and `figmaCss` alone can
run to tens of kilobytes — so an agent building a React component should ask for
`{"format":["tsx","moduleCss"]}` and nothing else. Only those keys are present in
the response, and `outputs` echoes which were produced. An unknown name is
refused rather than ignored. One name sits outside the default: `pngData` returns
the image base64 in the body as `{ dataUri, bytes, scale }` instead of the `png`
URL, for when nothing will be able to fetch that URL later.

### The HTML output

`{"format":"html"}` returns a complete document that renders as the design with
no editing. It is the React output as plain markup — same deduped class names,
same real text — plus five corrections Dev Mode CSS needs before a browser agrees
with Figma:

- **Icons become SVG.** Dev Mode describes a vector with `fill` and
  `stroke-width`; those are SVG properties and do nothing on a `div`, so icons
  rendered as empty boxes. A layer that is nothing but vectors is exported once
  as `SVG_STRING` and inlined, and its wrapper layers collapse with it.
- **`position: relative`** is added to any layer with an absolutely positioned
  child, which Figma never emits.
- **Stroked layers get their size pinned** — a Figma stroke is drawn inside the
  bounds, but Dev Mode omits a content-derived height, so the border would add
  2px to it.
- **The font is linked and given a fallback.** `font-family: Inter` on its own
  falls back to the browser default, a serif.
- **The root gets its own width and height**, which Dev Mode leaves to a parent
  that only exists inside Figma.

Measured against the Figma render of a real bottomsheet, every layer lands within
0.6px of the size Figma reports.

`?depth=` walks the tree in one call instead of many: `/tree?depth=3` nests three
levels under a `children` array on each row, `?depth=all` goes to the bottom.
Capped at 300 siblings per level and 2000 nodes overall, with `truncated` saying
whether either limit bit.

```bash
# whatever the designer has selected right now
curl -s -X POST localhost:3055/extract -H 'content-type: application/json' \
  -d '{"selection":true}'

# a known set of ids
curl -s -X POST localhost:3055/extract -H 'content-type: application/json' \
  -d '{"nodeIds":["21:10314","21:10384"],"scale":1}'
```

`GET /selection` lists what is selected without exporting anything, which is the
cheap way for an agent to ask "what is the designer looking at?" before deciding
what to pull. The `selection_changed` SSE event carries every selected id.

When more than one batch key is present, `urls` wins, then `nodeIds`, then
`selection`, then `saved`.

### Working from Figma links

Anywhere a node is needed you can pass a Figma URL instead of an id. The
`node-id=21-10314` in a Figma link uses dashes; the plugin rewrites it to the
`21:10314` the API expects. `/file`, `/design`, `/proto`, `/board` and `/slides`
links all parse.

```bash
# one link
curl -s -X POST localhost:3055/extract -H 'content-type: application/json' \
  -d '{"url":"https://www.figma.com/design/KEY/Name?node-id=21-10314"}'

# many links: an array, or one blob of text with links in it
curl -s -X POST localhost:3055/extract -H 'content-type: application/json' \
  -d '{"urls":["https://…?node-id=21-10314","https://…?node-id=21-10384"]}'

# what do these links point at? (no export, much faster)
curl -s -X POST localhost:3055/resolve -H 'content-type: application/json' \
  -d '{"urls":"…paste anything containing figma links…"}'
```

Every batch — links, ids or selection — returns `{ results: [...] }`, one entry
per input, each either `{ ok: true, extraction }` or `{ ok: false, error }`, with
`ref` echoing what you passed. One bad entry does not fail the rest. Up to 20
entries per call, processed in order.

The plugin's **Links** tab does the same thing one link at a time: paste a link,
press Enter, and it joins the queue with its node id shown. A link that is not a
Figma URL or has no `node-id` is rejected on the spot rather than at extraction
time. `Extract N links` runs the queue and marks each row with its result.

Two limits are inherent to plugins, not choices:

- **A plugin can only read the file it is running in.** A link to a different file
  is rejected with the file key in the error. Reading another file needs Figma's
  REST API and a personal access token, which is a different tool.
- Nodes on other pages work: the plugin calls `loadAllPagesAsync()` and switches
  the current page when a link points somewhere else in the same file.

`enablePrivatePluginApi: true` in the manifest is what makes `figma.fileKey`
readable, which is how the wrong-file check works. It is fine for a private or
development plugin; remove it before publishing to the Figma Community.

### Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | relay state and whether the plugin is connected (no token needed) |
| GET | `/tree` | layers of the current page; `?depth=N` or `?depth=all` nests them |
| GET | `/children/:id` | under one node; takes the same `?depth=` |
| GET | `/selection` | what is selected on canvas |
| POST | `/extract` | `{ nodeId? \| url? \| urls?, format?, scale?, topLayerOnly?, inlineInstances? }` |
| POST | `/resolve` | `{ url \| urls }` — what each link points at, no export |
| GET | `/assets/:nodeId@2x.png` | re-renders that node; nothing cached |
| GET | `/saved` | the saved set with its folders; `?folder=X` narrows it |
| POST | `/saved` | add: `{ selection: true }` or `{ nodeIds }`, plus `folder?` |
| POST | `/saved/move` | `{ nodeIds, folder }` — move entries; `""` is the root |
| DELETE | `/saved` | remove: `{ nodeIds }`, `{ folder }` or `{ all: true }` |
| GET | `/folders` | every folder with its count; the root is the one named `""` |
| POST | `/folders` | create `{ name }`, or rename `{ from, to }` |
| DELETE | `/folders` | `{ name, deleteEntries? }` |
| GET | `/events` | SSE stream: `plugin_connected`, `plugin_disconnected`, `selection_changed` (all selected ids) |

`/extract` with no `nodeId` uses the current canvas selection. The response holds
`tsx`, `moduleCss`, `css`, the layer count, and `png: { url, bytes }` — the image
is a URL rather than base64, so nothing large lands in the agent's context.
Fetching it renders the node again through the live socket: nothing is cached, so
the URL works only while the plugin is connected.

```bash
curl -H "x-relay-token: $RELAY_TOKEN" localhost:3055/tree

curl -X POST localhost:3055/extract \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d '{"nodeId":"1:23","scale":2}'

curl -N -H "x-relay-token: $RELAY_TOKEN" localhost:3055/events
```
