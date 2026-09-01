# Figsnap

A Figma plugin that turns any node into a PNG, a React component, a standalone
HTML page and three flavours of CSS — and a relay so an AI agent can read the
same designs over HTTP while you work.

- **In Figma**: pick a layer, get code. No account needed for that part.
- **Over HTTP**: `POST /extract` with a node id or a Figma link, from an agent,
  a script or CI.
- **Inside the plugin**: an [agent you chat with in the panel](#an-agent-inside-the-plugin),
  running on your own machine under your own login, that can read the open file
  and — when you let it — change it.

TypeScript, bundled with esbuild. The relay is a Cloudflare Worker.

## Quick start

Requires **Node 20 or newer** and the **Figma desktop app** — plugins in
development cannot be loaded in the browser.

**1. Clone and build.**

```bash
git clone https://github.com/arimunandar/figsnap.git && cd figsnap
npm install
npm run build
```

Build at least once before importing: `manifest.json` points at `dist/code.js`
and `dist/ui.html`, which do not exist until you do.

**2. Point it at a relay.** The committed `manifest.json` and `src/relays.ts`
point at one deployment, which is not yours. Either
[run your own](#run-your-own-relay) — a few minutes, and recommended — or leave
it and share that one.

**3. Import into Figma.** Desktop app → **Plugins → Development → Import plugin
from manifest** → pick this folder's `manifest.json`.

**4. Run it.** **Plugins → Development → Figsnap**, or `Option-Command-P` to
re-run the last plugin.

**5. Sign in.** The plugin opens on a sign-in form. Create an account with an
email and a password; the token it returns is stored for you, the socket
connects, and the workspace appears. Nothing else to configure.

Pick a layer and you have code. To drive it from outside, copy the token from
the **Relay** page and see [Sending nodes to an AI agent](#sending-nodes-to-an-ai-agent).

While developing, `npm run watch` rebuilds on save — turn on **Plugins →
Development → Hot reload plugin** so Figma picks each build up. Manifest changes
still need a re-import.

## Run your own relay

The relay is what an agent talks to, and what carries your saved set between
machines. It is a Cloudflare Worker; deploying one takes about two minutes and
the free tier is ample.

**1. Name it.** In `worker/wrangler.jsonc`, change `name` from `figsnap-relay`
to something of your own.

**2. Deploy.**

```bash
npx wrangler login
npm run worker:deploy      # prints your address
```

**3. Tell the plugin.** Put the address it printed into `src/relays.ts`:

```ts
export const HOSTED_RELAY_URL = 'wss://<your-name>.<your-subdomain>.workers.dev/plugin'
```

**4. Tell Figma.** Figma blocks any address the manifest does not list. Put the
same host in **both** lists in `manifest.json`:

```json
"allowedDomains":    ["wss://<host>", "https://<host>"],
"devAllowedDomains": ["wss://<host>", "https://<host>"]
```

List the exact host. `wss://*.workers.dev` would let this plugin reach every
Worker on the internet, not only yours.

**5. Rebuild and re-import.** `npm run build`, then import the manifest again —
Figma caches it, so a re-import is required for manifest changes.

Then sign in from the plugin. You are the first account on your own relay.

```bash
npm run worker:check   # validate without deploying
npm run worker:dev     # real workerd, on localhost
```

### What it stores

Almost nothing. The socket lives in a Durable Object (`worker/src/room.js`)
because a Worker cannot hold one between requests, and that object writes
nothing at all: image URLs re-render through the live socket rather than serving
a cached copy, so no part of a design is ever at rest.

The one exception is your saved set (`worker/src/library.js`), kept per account
so it follows you between machines: node ids, layer names, types and folder
names. No image, no CSS, no geometry — the database could not reconstruct any
part of a design.

Accounts live in `worker/src/accounts.js`. Passwords are stored as a chained
PBKDF2 hash, tokens only as a SHA-256 hash, and each account gets its own room,
so a token reaches the designs of the plugin signed in as that same account and
nobody else's.

## What it does

Opening the plugin reads `figma.currentPage.children` and shows them as a tree,
three levels deep, with no selection needed. Anything deeper expands on click.
Clicking a row selects that node on canvas, zooms to it, and extracts it.
Selecting on canvas works too, debounced by 250ms.

Five outputs for the picked node:

| Output | What it is |
| --- | --- |
| **React** | a `.tsx` component. Frames become `div`s, text becomes `span`s with its content, nested instances become JSX tags (`<Checkbox size="Large" />`) with import stubs. Root component properties become typed props; variants become string-literal unions. |
| **HTML** | a whole page — styles, markup, icons as inline SVG, images embedded — that opens as the design with no editing |
| **Module CSS** | the same rules with camelCase classes, matching the `className={s.x}` references |
| **CSS** | `getCSSAsync()` output, kebab-case, indented to mirror the layer tree |
| **Figma CSS** | Figma's own *Copy as CSS*, reproduced byte for byte from node properties |

Plus a PNG at 1×–4×, with Copy and Download.

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
src/ui/bridge.ts   UI thread: WebSocket link to the relay and to the daemon
src/ui/markdown.ts UI thread: the Markdown subset an agent actually writes
agent/index.mjs    The local bridge daemon: WS server, ACP client, MCP server
agent/lib/tools.mjs   The figma_* tools an agent is handed
agent/lib/sessions.mjs  What was said before, so it can be picked up again
agent/mcp-stdio.mjs   figsnap-mcp: the figma_* tools, for the harness or any MCP client
probe/             Throwaway: measures how long Figma leaves a plugin running
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
| **Nodes** | the page tree, three levels open already | none — clicking a row extracts it |
| **Selection** | what is selected on canvas | `Extract N selected` |
| **Saved** | the set you curated, optionally in folders | `Extract N saved` |
| **Links** | links you queued one by one | `Extract N links` |

The Nodes tree arrives with three levels already walked, so finding a frame
inside a group takes no clicking; anything deeper still expands on demand. Long
names are not truncated — the pane scrolls sideways instead, because a deep tree
of similarly named layers is unreadable clipped.

Each saved row carries a button that copies its node id, which is what an API
call needs and is otherwise nowhere on screen.

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

**–** in the top bar minimises the panel to a 400px-wide strip, so the canvas is
clear while you go and find a layer. It keeps working down there:

- The strip names whatever you click, with its type and size.
- A preview of the selection sits below it, at the **full width of the panel**,
  and the window's height follows the component's aspect ratio — a tall frame
  gets a tall window, a wide one a short window, rather than being letterboxed
  in a fixed box. Nothing selected means the strip alone.
- **Save** puts the selection straight into the saved set without restoring,
  and says what happened: `Saved 1`, `Saved 2 to Checkout`, or `Already saved`
  when the layer is in the set already. An id is never stored twice.
- The relay socket stays up, so `/extract` and `/events` work throughout.

Clicking anywhere on the strip restores it. The full 2× preview and the CSS walk
are skipped while minimised — clicking around the canvas is the point, so only a
cheap fitted thumbnail is exported — and the shrunken window is not stored as
the size you chose, so restoring returns to whatever you had dragged it to.

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

## The relay

The relay is a Cloudflare Worker. There is nothing to run: the plugin connects to
it on open, and the **Relay** page shows the live connection, what the relay
itself reports, the address and token, an API browser and the commands to install
the Claude Code skill.

A Durable Object holds the plugin's WebSocket, because a Worker cannot hold a
socket between requests. One object per account, so a token reaches the designs
of the plugin signed in as that same account and nobody else's.

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

Every relay has accounts, so the plugin always opens on this form until a
session is stored.

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

The **Relay** page holds the account, the live connection, what the relay itself
reports, the address and token, the API browser and the skill install commands.

Settings are stored per user, so nothing needs recompiling and nothing is
committed. Each address remembers its own token, so moving between deployments is
a click. A fresh install points at the address in `src/relays.ts`.

One catch that is not the plugin's doing: **Figma blocks any address the manifest
does not list.** A relay of your own means adding its exact host to
`networkAccess.devAllowedDomains` in `manifest.json` and re-importing the plugin,
since Figma caches the manifest.

## An agent inside the plugin

The relay sends designs *out*. This sends a conversation *in*: a chat in the
plugin's **Agent** tab, backed by a coding harness already installed and signed
in on your own machine, which can read the open file and — once you allow it —
change it.

```
  Figma desktop                       Your machine
 ┌────────────────────┐        ┌──────────────────────────────────┐
 │  main thread       │        │   figsnap-agent  (npm run agent) │
 │  figma.* , no net  │        │    · ACP client, over stdio      │
 │        ▲           │        │    · owns fs/* and terminal/*    │──┐ stdio
 │        │ postMessage        │    · MCP server: figma_* tools   │  ▼
 │        ▼           │  ws:// │    · WebSocket server            │ ┌──────────┐
 │  UI iframe: chat   │◄──────►│                                  │ │ Claude   │
 └────────────────────┘  :3056 └──────────────────────────────────┘ │ Codex    │
                                                                    │ Gemini   │
                                                                    └──────────┘
```

**Why a daemon at all.** The only transport the Agent Client Protocol blesses is
stdio, and the client is the side that *launches* the agent as a subprocess. A
browser can do neither. An ACP client also has to answer `fs/read_text_file` and
`terminal/create` on the agent's behalf, and a plugin iframe has no filesystem
and no shell. So the daemon is the client, and the panel is that client's face.

**Why MCP as well as ACP.** ACP alone would give you a chat about your project.
The `figma_*` tools are how the agent gets hands in the file: each one proxies
over the same WebSocket into `figma.*`, which is the request/response path the
relay has always used. All three harnesses speak both protocols.

### Using it

**1. Start the daemon**, in this project:

```bash
npm run agent          # or, once published: npx figsnap-agent
```

It prints a token, its port, and the harnesses it found. It looks for `claude`,
`codex` and `gemini` on your `PATH`; each brings its own login and billing, and
this plugin never sees a model key. To use something else, name it yourself:

```bash
FIGSNAP_AGENT_COMMAND='npx -y @agentclientprotocol/some-adapter' npm run agent
```

**2. Open the plugin.** The third column is the chat — it takes the place of the
generated code, so the layer tree and the preview stay beside it. The **Code**
button in the top bar swaps back.

Pair once from **⋯ → Setup**: paste the token, **Connect**, pick a harness. Then
click the folder name at the top of the column to choose the project the agent
works in, and press **Start**. The token and the folder are stored per user, so
after the first time **Start** is the whole ritual. Changing the folder later is
the same click; on a live session it says that it restarts the session, because
the working directory is fixed when the session opens.

**3. Ask for something.**

> what does the selected frame actually say?

> make the CTA match our Button component in src/components

Whatever is selected on the canvas travels with each message by default — names,
types, sizes and node ids, not the design itself, which is a tool call away. It
shows above the composer as a row of chips.

The list follows your selection until you touch it. **+** offers two things:
pin what is selected, or attach a file. Pinning stops the list following, so you
can select something else and add that too — which is what *"make the button
match the sheet"* needs, since only one of those two can be selected at a time.
**✕** drops a chip, **⟳** goes back to following, and an empty list sends
nothing. Ten layers is the most one message carries. **Add to context** beside
the preview does the same thing from where you are already looking at the layer.

Where the harness says it reads images, a render of the first pinned layer goes
with the message too — a model that can look at the frame settles questions
about spacing and colour that no description would. Attached files ride as
images or as embedded resources depending on what the harness takes; anything it
takes neither of is reported rather than dropped in silence.

**⋯ → History** lists what was said before — titled by the question that started
it, and labelled with the harness, the folder and the file it belonged to.
Opening one relaunches that harness in that folder and asks it to replay, so
picking up yesterday's Codex conversation does not mean starting over in Claude
Code. Where a harness supports ACP's own `session/list` its titles win; the
local record at `~/.figsnap/sessions.json` is what spans harnesses, since no
harness knows about the others. Forgetting one drops it there and, where the
harness will take the instruction, from the harness too.

Type while it is still answering and the message queues, shown dimmed until its
turn. **Stop** replaces Send while a turn runs. A slash offers whatever commands
the harness publishes, and the picker beside Send switches its own modes — plan,
full access, whatever it has — which is ACP's answer to "how much may it do
unattended" and a better one than any switch invented here.

Answers are rendered as Markdown — headings, bullets, code spans, fenced blocks,
tables — and everything the agent *did* rather than said folds into one
**Worked for 4s** line per stretch, which opens when you want it. A tool call
shows its own evidence: the diff it wrote, the terminal it ran in, the text it
returned. Calls that can change the file carry a red dot.

Reading is always on. **Edits** in the strip decides whether the canvas can be
touched at all — off by default, and enforced by the daemon rather than the
agent, so a harness run without permission prompts still cannot get past it.

Who answers the harness when it *does* ask is a separate question, and it has no
switch in the chrome on purpose. Where the harness publishes its own modes, the
picker beside Send is the answer and it is the harness's own. Otherwise the
daemon answers for you — on by default, each one written into the transcript
with **Ask me instead** beside it — and when it is asking, the prompt itself
carries **Allow these without asking for the rest of this session**. A control
that only decides whether a prompt appears belongs on the prompt.

The choice is remembered per user. Each approved edit is committed with
`figma.commitUndo()`, so **one Cmd-Z takes back one change**. Ask for a
checkpoint before a long run and you get a named entry in version history.

### The tools

| Tool | |
| --- | --- |
| `figma_get_selection` | what is selected right now |
| `figma_get_tree`, `figma_get_children` | walk the page, a branch at a time |
| `figma_extract` | the full extraction: HTML, `figmaCss`, TSX, CSS modules |
| `figma_export_png` | the picture itself, as an image the model can look at |
| `figma_resolve_url`, `figma_list_saved` | Figma links, and the curated set |
| `figma_list_library` | the components, styles and variables this file has |
| **making things** | |
| `figma_create_frame`, `figma_create_text` | the two most of a layout is built from |
| `figma_create_rectangle`, `figma_create_ellipse` | dividers, bars, avatars, placeholders |
| `figma_create_svg` | SVG markup into real editable vectors — this is how an icon gets drawn |
| `figma_create_instance` | place a real component, not a lookalike |
| `figma_clone_node` | a second row that matches the first exactly |
| **moving them** | |
| `figma_move_node` | reparent, or reorder among siblings |
| `figma_delete_node` | take one away |
| **changing them** | |
| `figma_set_fill`, `figma_set_stroke` | colour, and borders — which are strokes, not fills |
| `figma_set_text`, `figma_set_text_style` | the words, and the type they are set in |
| `figma_set_bounds`, `figma_set_corner_radius` | position, size, rounding |
| `figma_set_auto_layout`, `figma_set_layout_sizing` | the frame, and how its children hug or fill |
| `figma_set_effects` | shadows and blurs |
| `figma_set_visibility`, `figma_set_node_name` | opacity, hidden, locked, and what it is called |
| **through the design system** | |
| `figma_apply_style` | a paint, text or effect style, so it keeps following that style |
| `figma_bind_variable` | a token, so the value follows the token |
| `figma_save_version` | a named checkpoint in version history |

The last two are the ones worth reaching for. Anything can be given a hex code;
applying the style or binding the variable is what makes a change survive the
next redesign, and an agent that has read `figma_list_library` knows which one
to use.

Nothing is truncated on the way through. Figma's own MCP server caps a response
at 20 kB; `figma_extract` returns whatever the node is, which for a real screen
is well past that, with images inlined and icons as real SVG.

### The same designs from a terminal

The `figma_*` tools are an MCP server, and nothing about it is private to the
plugin's own chat. Any MCP client on the machine running Figma can spawn it:

```bash
claude mcp add figsnap -- npx -y figsnap-mcp
```

No configuration. `figsnap-agent` listens on a fixed port and writes its token
to `~/.figsnap/agent-token`; `figsnap-mcp` finds both. `figsnap-agent --mcp`
prints the same thing as a JSON block for clients that want one.

So there are three ways to reach the open file, and the skill in
`.claude/skills/figsnap` teaches an agent to work out which one it is on:

| | reads | writes | needs |
| --- | --- | --- | --- |
| the plugin's Agent column | ✓ | ✓ | nothing |
| `figsnap-mcp` from a project | ✓ | ✓ | the daemon running |
| the relay over HTTP | ✓ | — | an account |

**Edits still gates it.** An agent reaching in from a terminal gets the same
refusal on the writing tools until the designer turns Edits on in the panel,
because that switch lives in the daemon rather than in any one client.

### Keeping it to your machine

A port on localhost is reachable by any page you happen to have open, so the
socket is guarded twice:

- the `Origin` of the handshake must be `null` (a sandboxed plugin iframe) or
  `figma.com`. A web page cannot forge that header, and CORS does not apply to a
  WebSocket upgrade, so this check is done by hand on the connection.
- a token must be in the query string, because a browser `WebSocket` cannot set
  headers. The daemon prints one and remembers it in `~/.figsnap/agent-token`;
  `npm run agent -- --new-token` rotates it.

The directory you chose bounds the daemon's own file routes: a path that climbs
out of it is refused rather than resolved. Be clear about what that is and is
not, though — the agent also gets a terminal, and a shell command is arbitrary.
It runs as you, with your permissions, exactly as it would if you had typed
`claude` in that directory yourself. The boundary is the account, not the folder.

### How long a plugin lives

A plugin exists only while it is open, and Figma may tear the runtime down on its
own. The session id is stored in `clientStorage`, so reopening the panel asks the
harness to `session/load` and replay the conversation instead of starting a new
one. `probe/` is a throwaway plugin that measures how aggressive this actually is
on your machine:

```bash
npm run probe          # then import probe/manifest.json in Figma, leave it an hour
```

It logs every disconnect, every new runtime and every frozen timer with a
timestamp, and prints a verdict on the way out.

## Develop

```bash
npm run watch       # rebuild on save
npm run typecheck   # tsc --noEmit
npm test            # every suite
```

With the watch running, enable Plugins > Development > **Hot reload plugin** so
Figma picks up each rebuild. Manifest changes still need a re-import.

### Tests

`npm test` starts one `wrangler dev` and runs the suites in `test/` against it.
Each suite registers its own account, which puts it in its own room, so they need
no Figma, no network beyond localhost, and no shared state — and they run in any
order. A suite that finds no relay skips rather than fails. `e2e-panel-auth.mjs` goes further and runs the shipped
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
| `e2e-skill.mjs` | the Claude Code skill files as the relay serves them |
| `e2e-tree.mjs` | `?depth=` walks and the `format` picker, on the real main thread |
| `e2e-agent-bridge.mjs` | the daemon against a scripted ACP harness: streaming, permissions, MCP, resume |
| `e2e-panel-agent.mjs` | the Agent column in the built panel, against a fake daemon |
| `e2e-writes.mjs` | the mutating commands on the real main thread: undo, re-render, refusals |

`npm test` never touches the network. To check a relay you have actually deployed:

```bash
npm run smoke -- wss://<host>/plugin
```

That stands a WebSocket client in for the plugin, so the whole hosted path is
exercised without Figma being open. The token comes from `RELAY_TOKEN`, or from
`.relay-token` if that file exists — which is gitignored, so a generated token
stays out of version control.

## Sharing it with other people

The panel needs no relay for most of what it does: preview, React, HTML, the
three CSS flavours, saved sets and links all run inside Figma. The relay is what
an agent talks to, and what carries a saved set between machines.

| Audience | Needs | Gets it from |
| --- | --- | --- |
| Designers who want code out of Figma | the panel | the published plugin — one click, no Node |
| Developers and agents | panel + HTTP API | the plugin, and an account on the relay |
| Contributors | the source | this repository |

Licensed MIT — see `LICENSE`. If you fork it, change `HOSTED_RELAY_URL` in
`src/relays.ts` and the two host lists in `manifest.json` so your build talks to
your relay rather than someone else's.

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
- **`networkAccess`**: `allowedDomains` is what a *published* build may reach and
  `devAllowedDomains` what it may reach from Plugins > Development. Both currently
  name the relay and `ws://localhost:3056` / `http://localhost:3056` for the agent
  daemon, exact hosts rather than wildcards, and both need updating if you deploy
  your own relay — Figma caches the manifest, so re-import afterwards. Naming a
  local server makes the `reasoning` string mandatory; the one committed here
  explains both addresses. Figma publishes no policy on `ws://localhost`, but it
  is a documented pattern and at least one Community plugin ships it, so it has
  passed review before. Drop both localhost entries if you would rather not
  find out.

`id` is assigned by Figma on first publish; the placeholder is correct until then.

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
- A plugin exists only while somebody has it open. There is no headless or
  scheduled mode and no keep-alive API, so the in-panel agent cannot work in the
  background, and Figma may take the runtime away mid-answer. The stored session
  id is the answer to that: reopening resumes rather than restarts.
- A plugin sees one open file. Nothing here can create a file or read a second one.
- Writing to the canvas is refused in Dev Mode, which is why the manifest is
  `editorType: ["figma"]`.

## Sending nodes to an AI agent

The examples below use two shell variables: `RELAY` is your relay's address, and
`RELAY_TOKEN` is the token the plugin's Relay page will copy for you.

```bash
export RELAY=https://your-relay.workers.dev
export RELAY_TOKEN=...        # Relay page > Token > copy
```

Every route that touches a design needs the token, as `-H "x-relay-token: $RELAY_TOKEN"`.

The plugin cannot be reached from outside Figma and cannot host a server, so it
dials out instead. `server/relay.mjs` holds that WebSocket and exposes a plain
HTTP API, which is what an agent talks to:

```
AI agent  --REST/SSE-->  relay (Cloudflare Worker)  <--WS--  Figma plugin UI
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
curl -s $RELAY/saved                       # what is in the set

curl -s -X POST $RELAY/saved \
  -H 'content-type: application/json' -d '{"selection":true}'

curl -s -X POST $RELAY/saved \
  -H 'content-type: application/json' -d '{"nodeIds":["21:10314"]}'

curl -s -X POST $RELAY/extract \
  -H 'content-type: application/json' -d '{"saved":true}'

curl -s -X DELETE $RELAY/saved \
  -H 'content-type: application/json' -d '{"nodeIds":["21:10314"]}'
curl -s -X DELETE $RELAY/saved \
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
- **Padding larger than its frame gives way to the frame.** Figma allows that and
  clips; CSS with `border-box` lets the padding win, so a 4px tab underline with
  10px padding rendered as a 20px blob over the label.
- **A negative auto-layout gap becomes a margin.** `gap: -4px` is not valid CSS
  and is discarded outright, which shifts every sibling.
- **Images come with it.** A fill points at a file inside Figma, so the layer is
  rendered and inlined as a data URI: the page you copy carries its own pictures
  and stays one file. Bounded at 400 kB a layer and 2 MB in total. Past that — or
  when a painted layer also has children, since baking it would draw them twice —
  the box falls back to a flat placeholder colour, and the comment above the rule
  says so.
- **Instances are expanded.** React writes `<Title />` because the component
  exists somewhere in your codebase; a page has nowhere to defer to, so an
  unexpanded instance is an empty div that collapses to nothing. The React and
  CSS outputs still stop at the boundary, and `layerCount` still counts what
  React describes, so asking for HTML does not change it.

Icons collapse at the outermost vector-only node, so a fifty-path flag is one
`<svg>` rather than fifty. The byte budget is a total (600 kB) rather than
per-node, because failing a per-node cap was strictly worse: the walk then
inlined every vector inside separately — the same bytes, fifty elements, and any
paint that lived on the wrapper lost.

Measured against the Figma render of a real bottomsheet, every layer lands within
0.6px of the size Figma reports.

`?depth=` walks the tree in one call instead of many: `/tree?depth=3` nests three
levels under a `children` array on each row, `?depth=all` goes to the bottom.
Capped at 300 siblings per level and 2000 nodes overall, with `truncated` saying
whether either limit bit.

```bash
# whatever the designer has selected right now
curl -s -X POST $RELAY/extract -H 'content-type: application/json' \
  -d '{"selection":true}'

# a known set of ids
curl -s -X POST $RELAY/extract -H 'content-type: application/json' \
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
curl -s -X POST $RELAY/extract -H 'content-type: application/json' \
  -d '{"url":"https://www.figma.com/design/KEY/Name?node-id=21-10314"}'

# many links: an array, or one blob of text with links in it
curl -s -X POST $RELAY/extract -H 'content-type: application/json' \
  -d '{"urls":["https://…?node-id=21-10314","https://…?node-id=21-10384"]}'

# what do these links point at? (no export, much faster)
curl -s -X POST $RELAY/resolve -H 'content-type: application/json' \
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
curl -H "x-relay-token: $RELAY_TOKEN" $RELAY/tree

curl -X POST $RELAY/extract \
  -H "x-relay-token: $RELAY_TOKEN" -H 'content-type: application/json' \
  -d '{"nodeId":"1:23","scale":2}'

curl -N -H "x-relay-token: $RELAY_TOKEN" $RELAY/events
```
