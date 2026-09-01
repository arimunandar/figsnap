// The Claude Code skill this plugin installs into a project.
//
// Generated rather than shipped as static files so the relay's real address is
// baked into the commands, and so the skill cannot drift from the API it documents.

/** @param {{ httpBase: string }} context */
export function skillFiles({ httpBase }) {
  const skill = `---
name: figsnap
description: Read and change the Figma file the designer has open - PNG renders, React components, HTML, CSS, and Figma's own CSS coming out; fills, text, layout, new layers, components and design tokens going in. Use when the user pastes a figma.com link, names a Figma frame or component, asks to implement/port/build a design as code, asks what a screen looks like, asks to compare code against a design, or asks to change something in Figma. Also use when the user mentions the Figsnap plugin, a Figma relay, or the figsnap MCP server.
---

# Reading designs out of Figma

A Figma plugin called Figsnap is running in the designer's Figma
desktop app. It holds a WebSocket open to a relay on this machine, and the relay
exposes plain HTTP. That is how you read the design: no Figma API token, no file
export, and only the file that is currently open.

Base URL: \`${httpBase}\`

The relay is a Cloudflare Worker the designer signs into from the plugin. Every
route that touches a design needs their token; \`/health\`, \`/docs.md\` and
\`/skill\` do not.

## First: which surface are you on?

There are three ways to reach the same open file, and only one of them applies
to you. Work out which before reading further.

**1. You have \`figma_*\` tools.** Check your tool list for
\`figma_get_selection\`, \`figma_extract\`, \`figma_set_fill\`. If they are there,
**use them and ignore every curl below**. They reach the same designs without
HTTP, without a token and without a response cap, and they are the only route
that can *change* the file. This is the case whether you are the agent the
designer started inside the plugin's own Agent tab, or an agent in a terminal
with the \`figsnap\` MCP server added. Skip to *Reading* and *Changing*.

**2. You have no \`figma_*\` tools but could have.** If the user is asking you to
change a design, or you need more than the relay can give, the tools are one
command away on the machine running Figma:

\`\`\`bash
claude mcp add figsnap -- npx -y figsnap-mcp
\`\`\`

It needs no configuration: \`figsnap-agent\` listens on a fixed port and writes
its token to \`~/.figsnap/agent-token\`, and the MCP server finds both. If the
user has not started the daemon, tell them to run \`npx figsnap-agent\`. Suggest
this rather than working around its absence — the relay cannot write.

**3. Neither, and reading is enough.** Then the relay below is your route.

The rest of this file applies to all three: which output to ask for, what each
one is good for, and what will bite you. Only the *calls* differ —
\`figma_extract\`'s \`formats\` argument takes the same names as \`format\` below.

## Always start here

\`\`\`bash
curl -s ${httpBase}/health
\`\`\`

\`pluginConnected: true\` means you can read the design. Anything else and you
must stop and tell the user what to fix, rather than guessing at the design:

- \`pluginConnected: false\`: the relay is up but the Figma plugin is closed, or
  signed in as someone else. The user opens it from Plugins > Development >
  Figsnap and signs in.
- \`401\`: send the token as \`-H "x-relay-token: $RELAY_TOKEN"\` on every request.
  Ask the user for it — the Relay page in the plugin has a copy button. Never
  guess, and never put it in a URL you log.
- Connection refused or a DNS failure: the relay address is wrong. Ask; do not
  try other hosts.

The full manual is \`curl -s ${httpBase}/docs.md\` — read it when something here
is not enough.

## Finding the node you want

\`\`\`bash
curl -s ${httpBase}/selection          # what the designer has selected now
curl -s ${httpBase}/tree               # top-level layers of the current page
curl -s ${httpBase}/children/21:10314  # one level down
curl -s '${httpBase}/tree?depth=all'   # the whole page at once
curl -s ${httpBase}/saved              # the set the designer curated
curl -s ${httpBase}/folders            # how that set is grouped
curl -s '${httpBase}/saved?folder=Checkout'
\`\`\`

Prefer \`/selection\` or \`/saved\` when the user says "this screen" or "these
components" — the designer has already told you which nodes matter. Walk
\`/tree\` and \`/children\` only when you must find a node by name.

\`/tree\` and \`/children\` take \`?depth=N\` or \`?depth=all\`. One deep call beats a
walk of many shallow ones — but it is capped at 2000 nodes, and a real design
page is mostly vectors nobody needs, so prefer \`depth=2\` or \`3\` and go deeper
only where \`childCount\` says there is something worth seeing.

The saved set may be grouped into folders, one level deep. \`/folders\` lists them
with counts; the folder named \`""\` is the root. When the user names a group
("the checkout screens"), match it against that list and scope the call to it
rather than extracting everything.

## Extracting

\`\`\`bash
curl -s -X POST ${httpBase}/extract \\
  -H 'content-type: application/json' \\
  -d '{"nodeId":"21:10314"}'
\`\`\`

The body selects what to extract. One node: \`{}\` for the current selection,
\`{"nodeId":"..."}\`, or \`{"url":"https://www.figma.com/design/KEY/N?node-id=21-10314"}\`.
A batch: \`{"selection":true}\`, \`{"saved":true}\`, \`{"saved":true,"folder":"Checkout"}\`,
\`{"nodeIds":[...]}\`, or \`{"urls":[...]}\`. Options on any call: \`scale\` (1-4),
\`topLayerOnly\`, \`inlineInstances\`.

**Ask only for the outputs you will use.** \`format\` takes one name or a list from
\`png\`, \`html\`, \`tsx\`, \`moduleCss\`, \`css\`, \`figmaCss\`; that whole set is the
default, and \`figmaCss\` alone can run to tens of kilobytes. Building a React
component means \`{"format":["tsx","moduleCss"]}\`, not the lot.

\`html\` is a whole page — styles, markup, icons inlined as SVG — that renders as
the design without editing. Reach for it when the user wants something to look
at; reach for \`tsx\` when they want something to build on.

\`pngData\` is outside the default: the image base64 in the body rather than the
\`png\` URL. Use it only when whatever reads your answer cannot fetch a URL later,
since it costs about 40 KB a node.

\`\`\`bash
curl -s -X POST ${httpBase}/extract \\
  -H 'content-type: application/json' \\
  -d '{"nodeId":"21:10314","format":["tsx","moduleCss"]}'
\`\`\`

A batch answers \`{results:[...]}\`, one entry per input, each \`{ok:true,extraction}\`
or \`{ok:false,error}\`. One bad entry never fails the rest.

### What comes back

| Field | Use it for |
| --- | --- |
| \`tsx\` | the component skeleton: tree, class names, text, instance boundaries |
| \`moduleCss\` | CSS module to pair with \`tsx\` (camelCase classes) |
| \`css\` | Dev Mode CSS, kebab-case, keeps design tokens as \`var(--Token, #hex)\` |
| \`figmaCss\` | Figma's legacy Copy-as-CSS: absolute geometry, gradients, walks into instances |
| \`png.url\` | fetch it and read the image when you need to *see* the design |
| \`layerCount\`, \`truncated\` | whether you got the whole subtree |

The image URL re-renders the node on request rather than serving a cached copy,
so it works only while the plugin is connected, and the bytes are never stored by
the relay. Fetch it rather than guessing at appearance:

\`\`\`bash
curl -s "<png.url from the response>" -o /tmp/node.png
\`\`\`

## Choosing an output

Match the field to the job instead of pasting everything:

- **Building a component**: \`tsx\` + \`moduleCss\`. Keep the token references from
  \`css\` — \`var(--Spacing-Large, 12px)\` maps onto the project's own variables,
  a raw \`12px\` does not.
- **Absolute positioning, gradients, or icon internals**: \`figmaCss\`. Dev Mode
  CSS carries no position data at all, so on a design without auto layout it
  gives you almost nothing.
- **Checking existing code against the design**: \`png.url\` plus \`css\`.

## Changing the design

Only the \`figma_*\` tools can write; the relay has no route that does. Two gates
stand in front of them, and neither is yours to open:

- **Edits** in the plugin's Agent column decides whether the canvas can be
  touched at all. It is enforced by the daemon, so a refusal reading *"editing
  the file is switched off"* means the designer has to tick it — say so and stop,
  rather than looking for another way in.
- Whether you are asked before each change is the harness's own business.

Every call is one undo step, so the designer takes any single change back with
one Cmd-Z. Before a run that will change several things, call
\`figma_save_version\` first: it leaves one named point to fall back to instead of
a stack of undos.

**Read the design system before changing anything.** \`figma_list_library\` returns
the components, styles and variables this file has, with their ids. Then:

- \`figma_apply_style\` for a colour or type that has a named style
- \`figma_bind_variable\` for a value that has a token
- \`figma_create_instance\` rather than drawing a lookalike

A hex code you picked will look right today and be wrong after the next
redesign; a style or a variable follows the system. Reach for \`figma_set_fill\`
with a literal colour only when the file has nothing named for it.

The rest, briefly. Making: \`figma_create_frame\`, \`figma_create_text\`,
\`figma_create_rectangle\`, \`figma_create_ellipse\`, \`figma_create_svg\` (real
editable vectors, which is how an icon gets drawn), \`figma_clone_node\`. Moving:
\`figma_move_node\`, \`figma_delete_node\`. Changing: \`figma_set_fill\`,
\`figma_set_stroke\`, \`figma_set_text\`, \`figma_set_text_style\`,
\`figma_set_bounds\`, \`figma_set_corner_radius\`, \`figma_set_effects\`,
\`figma_set_visibility\`, \`figma_set_node_name\`, \`figma_set_auto_layout\`,
\`figma_set_layout_sizing\`.

Three that catch people out:

- **Borders are strokes, not fills.** A row outline needs \`figma_set_stroke\`.
- **Inside auto layout, position and width are the parent's business.**
  \`figma_set_bounds\` is ignored there; \`figma_set_layout_sizing\` with HUG, FILL
  or FIXED is how a child is sized.
- **Text needs its font.** A layer whose font this machine does not have is
  refused rather than silently retyped in a substitute — that is a real answer,
  not a bug to route around.

After a change, \`figma_export_png\` is how you check it landed rather than
assuming. \`figma_set_fill\` and \`figma_set_stroke\` also read the colour back off
the node and return it, so a write that did not take is visible without looking.

## Things that will bite you

- **Instances are opaque by default.** Text and styling inside a component do not
  appear in \`css\` or \`tsx\`. Re-extract with \`{"inlineInstances":true}\` when the
  user asks about content you cannot see. Layer counts jump sharply.
- **Props are declared, not wired.** The \`tsx\` declares props from component
  properties, but nothing branches on them: Figma reports which variant is
  active, not which layers each variant swaps. Wire them yourself.
- **Variant values are strings.** \`sticky="False"\` is the string "False". A real
  boolean property appears bare, as \`rightText\`.
- **Extract one frame at a time.** Extraction stops after 500 layers, and
  \`truncated: true\` means you are looking at a partial tree — usually because a
  whole page or a group of screens was picked instead of one frame.
- **Hidden layers are skipped** in \`css\` and \`tsx\`. \`figmaCss\` includes them and
  marks them \`display: none\`.
- **Only the open file.** A link to a different Figma file is refused, with that
  file's key in the error. Ask the user to open it.

## Keeping context small

An extraction of one screen runs to tens of kilobytes across four formats. When
you need several nodes, or only a summary, delegate to the \`figsnap-extractor\`
agent instead of pulling every response into this conversation.
`

  const agent = `---
name: figsnap-extractor
description: Pulls designs out of the open Figma file through the Figsnap relay and reports back a compact summary. Use when several nodes are needed, when only structure or measurements matter, or when full extractions would crowd the conversation. Give it node ids, Figma links, or "the current selection".
tools: Bash, Read, Write
---

You read designs out of a running Figma plugin and report back concisely. Your
value is that the raw responses, which run to tens of kilobytes each, stay out of
the caller's context.

If you have \`figma_*\` tools, use them: \`figma_get_selection\`,
\`figma_get_children\`, \`figma_extract\` and \`figma_export_png\` do everything
below without HTTP or a token, and \`figma_extract\`'s \`formats\` argument takes
the same names as \`format\`. Otherwise the relay at \`${httpBase}\` is your route,
and the method is the same either way. **You read; you never write** — leave any
\`figma_set_*\` or \`figma_create_*\` tool alone even where you have one.

## Method

1. \`curl -s ${httpBase}/health\`. If \`pluginConnected\` is not true, stop and
   report exactly what is wrong. Do not speculate about the design.
2. Resolve what to extract: \`/selection\`, \`/saved\` (optionally one \`/folders\`
   group), \`/tree\`, \`/children/:id\`, or the ids and links you were given.
   To find a node by name, walk with \`?depth=\` — \`/tree?depth=3\` in one call
   beats a dozen shallow ones. Scope it to a node (\`/children/<id>?depth=all\`)
   rather than asking for the whole page, which is mostly vectors and will hit
   the 2000-node cap.
3. Extract with \`POST /extract\`. Use a batch body (\`nodeIds\`, \`urls\`,
   \`selection\`, \`saved\`) rather than one call per node.
   **Ask only for the outputs the caller needs**, with \`format\`. The default is
   all five and \`figmaCss\` alone is most of the payload; \`{"format":["tsx"]}\`
   is a twentieth of the size. Reach for \`figmaCss\` only when the question is
   about absolute position, gradients, or the inside of an instance.
4. **Write each extraction to a file** rather than printing it — for example
   \`/tmp/figma-<nodeId>.json\` — and save any PNG you fetch alongside it. Report
   the paths so the caller can read only what it needs.
5. If \`truncated\` is true, say so and name the node. On an extraction it means
   the 500-layer cap; on a tree walk it means 300 siblings at a level or 2000
   nodes overall. Either way, suggest a smaller frame or a shallower depth.

## What to report

Per node, a few lines at most:

- name, type, dimensions, layer count, and which outputs you asked for
- the file you wrote the extraction to, and the PNG path if you fetched one
- the component tags found in \`tsx\` (which design-system components it uses)
- anything that will surprise the caller: truncation, hidden layers, instance
  boundaries hiding content, missing positional data

Then one short paragraph of what the node actually is, from the PNG and the tree.

Never paste whole \`tsx\`, \`css\`, \`figmaCss\` or \`moduleCss\` bodies into your
report. Quote at most a few lines, and only when they are the point.

## Do not

- Do not write or edit project source files. You gather and summarise.
- Do not guess at appearance you have not fetched.
- Do not retry a failing relay more than twice; report and stop.
`

  return [
    { path: '.claude/skills/figsnap/SKILL.md', contents: skill },
    { path: '.claude/agents/figsnap-extractor.md', contents: agent },
  ]
}
