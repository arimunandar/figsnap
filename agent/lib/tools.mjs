// The hands the agent gets in Figma.
//
// Every tool here is one command on the plugin's `handleRequest` switch, so the
// catalogue is a mapping and nothing more: no logic lives between the harness
// and the plugin except the argument shaping below. That keeps the MCP surface
// and the HTTP relay describing the same plugin rather than drifting into two.
//
// `mutates` is the one flag with teeth. A harness asks its own user before
// running a tool, but not every harness does, and a harness told to skip
// permissions would otherwise reach the canvas unannounced. So the daemon
// refuses every mutating tool until the panel turns writes on, which is a
// switch the designer holds rather than a prompt the agent can talk past.

/** Outputs the plugin can produce, in the order the plugin returns them. */
export const OUTPUTS = ['png', 'pngData', 'html', 'tsx', 'moduleCss', 'css', 'figmaCss']

// The whole point of this bridge is that a 167 kB answer is allowed, but an
// agent that asked for "the button" should still not be handed every
// representation of it at once. Naming two is a starting point it can widen.
const DEFAULT_FORMATS = ['html', 'figmaCss']

const nodeIdArgument = {
  type: 'string',
  description: 'Figma node id, like "21:10314". Omit to use whatever is selected on the canvas.',
}

/** A hex colour as designers write it, in the 0-1 triples the Plugin API wants. */
export function parseColor(value) {
  const text = String(value ?? '').trim().replace(/^#/, '')
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${value}. Use "#1e88e5" or "1e88e5".`)
  }
  return {
    r: parseInt(full.slice(0, 2), 16) / 255,
    g: parseInt(full.slice(2, 4), 16) / 255,
    b: parseInt(full.slice(4, 6), 16) / 255,
  }
}

export const TOOLS = [
  {
    name: 'figma_get_selection',
    title: 'What is selected',
    description:
      'The layers the designer has selected on the canvas right now, with their ids, names, types and sizes. Start here when the request says "this", "the selected frame", or names nothing at all.',
    mutates: false,
    command: 'get_selection',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    params: () => ({}),
  },
  {
    name: 'figma_get_tree',
    title: 'Layers on the current page',
    description:
      'The top-level layers of the page the designer is looking at. Increase depth to walk further down, but note that a deep page is thousands of rows: prefer figma_get_children on one branch.',
    mutates: false,
    command: 'get_tree',
    inputSchema: {
      type: 'object',
      properties: {
        depth: { type: 'integer', minimum: 1, maximum: 6, description: 'How many levels to walk. Default 1.' },
      },
      additionalProperties: false,
    },
    params: (args) => (args.depth === undefined ? {} : { depth: args.depth }),
  },
  {
    name: 'figma_get_children',
    title: 'Children of one layer',
    description: 'The direct children of one node, by id. The cheap way to explore a page a branch at a time.',
    mutates: false,
    command: 'get_children',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node whose children to list.' },
        depth: { type: 'integer', minimum: 1, maximum: 6, description: 'How many levels to walk. Default 1.' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => ({ id: args.nodeId, ...(args.depth === undefined ? {} : { depth: args.depth }) }),
  },
  {
    name: 'figma_extract',
    title: 'Read a design as code',
    description:
      'The full extraction of one node: HTML measured against what Figma draws, byte-exact figmaCss, a React component, plain CSS and CSS modules. Images are inlined and icons come out as real SVG, so the HTML stands on its own. This is the tool that answers "what does this design actually say".',
    mutates: false,
    command: 'extract',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        url: { type: 'string', description: 'A Figma link, as an alternative to nodeId.' },
        formats: {
          type: 'array',
          items: { type: 'string', enum: OUTPUTS },
          description: `Which representations to return. Default ${DEFAULT_FORMATS.join(' and ')}. "pngData" inlines the image as a data URI and is large; figma_export_png returns the picture itself instead.`,
        },
        topLayerOnly: { type: 'boolean', description: 'Stop at the selected layer rather than walking into it.' },
        inlineInstances: { type: 'boolean', description: 'Expand component instances instead of referencing them.' },
        scale: { type: 'number', minimum: 1, maximum: 4, description: 'Render scale for any image output. Default 2.' },
      },
      additionalProperties: false,
    },
    params: (args) => ({
      ...(args.nodeId === undefined ? {} : { nodeId: args.nodeId }),
      ...(args.url === undefined ? {} : { url: args.url }),
      format: Array.isArray(args.formats) && args.formats.length > 0 ? args.formats : DEFAULT_FORMATS,
      topLayerOnly: args.topLayerOnly === true,
      inlineInstances: args.inlineInstances === true,
      ...(args.scale === undefined ? {} : { scale: args.scale }),
    }),
  },
  {
    name: 'figma_export_png',
    title: 'See the design',
    description:
      'Renders one node and returns the picture itself, so a model that can see gets to look at the design rather than read a description of it. Nothing is stored anywhere.',
    mutates: false,
    command: 'export_png',
    image: true,
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node to render.' },
        scale: { type: 'number', minimum: 1, maximum: 4, description: 'Render scale. Default 2.' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => ({ nodeId: args.nodeId, ...(args.scale === undefined ? {} : { scale: args.scale }) }),
  },
  {
    name: 'figma_resolve_url',
    title: 'What a Figma link points at',
    description: 'Turns one or more Figma links into the nodes they name, without exporting anything.',
    mutates: false,
    command: 'resolve_urls',
    inputSchema: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'Figma links to resolve.' },
      },
      required: ['urls'],
      additionalProperties: false,
    },
    params: (args) => ({ urls: args.urls }),
  },
  {
    name: 'figma_list_saved',
    title: 'The designer’s saved set',
    description:
      'The nodes the designer curated in the panel, by folder. A shortlist of what matters in this file, which is usually a better starting point than the whole page.',
    mutates: false,
    command: 'list_saved',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Restrict to one folder.' } },
      additionalProperties: false,
    },
    params: (args) => (args.folder === undefined ? {} : { folder: args.folder }),
  },

  // ------------------------------------------------------------------ writes

  {
    name: 'figma_set_fill',
    title: 'Set a solid fill',
    description:
      'Replaces a node’s fills with one solid colour, and answers with the colour read back off the node — so a write that did not land is visible without a screenshot. It replaces every fill the node had, which is worth knowing before pointing it at a gradient or a photograph; the answer names what was there. Borders are strokes, not fills: use figma_set_stroke for those. One call is one undo step, so the designer takes it back with a single Cmd-Z.',
    mutates: true,
    command: 'set_fill',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node to fill.' },
        color: { type: 'string', description: 'Hex colour, like "#1e88e5".' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Fill opacity, 0 to 1. Default 1.' },
      },
      required: ['nodeId', 'color'],
      additionalProperties: false,
    },
    params: (args) => ({
      nodeId: args.nodeId,
      color: parseColor(args.color),
      ...(args.opacity === undefined ? {} : { opacity: args.opacity }),
    }),
  },
  {
    name: 'figma_set_stroke',
    title: 'Set or clear a stroke',
    description:
      'Replaces a node’s strokes with one solid colour, and optionally sets the stroke weight. Pass remove: true to take the stroke off entirely. Borders in Figma are strokes, not fills — a row outline or an icon drawn as an outline needs this rather than figma_set_fill.',
    mutates: true,
    command: 'set_stroke',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node to stroke.' },
        color: { type: 'string', description: 'Hex colour, like "#1e88e5". Omit only with remove.' },
        weight: { type: 'number', minimum: 0, description: 'Stroke weight in pixels. Left alone when omitted.' },
        opacity: { type: 'number', minimum: 0, maximum: 1, description: 'Stroke opacity, 0 to 1. Default 1.' },
        remove: { type: 'boolean', description: 'Remove every stroke instead of setting one.' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => {
      if (args.remove === true) return { nodeId: args.nodeId, remove: true }
      if (args.color === undefined) throw new Error('Give a color, or pass remove: true.')
      return {
        nodeId: args.nodeId,
        color: parseColor(args.color),
        ...(args.weight === undefined ? {} : { weight: args.weight }),
        ...(args.opacity === undefined ? {} : { opacity: args.opacity }),
      }
    },
  },
  {
    name: 'figma_set_text',
    title: 'Set the characters of a text layer',
    description:
      'Replaces the text of one TEXT node. The font is loaded first; a layer whose font is missing from this machine is refused rather than silently retyped in a substitute.',
    mutates: true,
    command: 'set_text',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The TEXT node to retype.' },
        text: { type: 'string', description: 'The new characters.' },
      },
      required: ['nodeId', 'text'],
      additionalProperties: false,
    },
    params: (args) => ({ nodeId: args.nodeId, text: args.text }),
  },
  {
    name: 'figma_set_auto_layout',
    title: 'Set auto layout on a frame',
    description:
      'Turns auto layout on for a frame and sets its direction, spacing, padding and alignment. Pass mode "NONE" to turn it off. Only the properties you name are changed.',
    mutates: true,
    command: 'set_auto_layout',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The frame, component or instance to lay out.' },
        mode: { type: 'string', enum: ['HORIZONTAL', 'VERTICAL', 'NONE'], description: 'Layout direction.' },
        itemSpacing: { type: 'number', description: 'Gap between children.' },
        paddingTop: { type: 'number' },
        paddingRight: { type: 'number' },
        paddingBottom: { type: 'number' },
        paddingLeft: { type: 'number' },
        padding: { type: 'number', description: 'Shorthand: sets all four paddings.' },
        primaryAxisAlignItems: {
          type: 'string',
          enum: ['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'],
          description: 'Alignment along the layout direction.',
        },
        counterAxisAlignItems: {
          type: 'string',
          enum: ['MIN', 'CENTER', 'MAX', 'BASELINE'],
          description: 'Alignment across the layout direction.',
        },
      },
      required: ['nodeId', 'mode'],
      additionalProperties: false,
    },
    params: (args) => {
      const { nodeId, padding, ...rest } = args
      const sides =
        padding === undefined
          ? {}
          : { paddingTop: padding, paddingRight: padding, paddingBottom: padding, paddingLeft: padding }
      return { nodeId, ...sides, ...rest }
    },
  },
  {
    name: 'figma_create_frame',
    title: 'Create a frame',
    description:
      'Creates an empty frame, on the current page or inside a parent you name. Returns the new node’s id so the next call can fill it.',
    mutates: true,
    command: 'create_frame',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Layer name. Default "Frame".' },
        parentId: { type: 'string', description: 'Put it inside this node. Default: the current page.' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 1, description: 'Default 100.' },
        height: { type: 'number', minimum: 1, description: 'Default 100.' },
        fill: { type: 'string', description: 'Hex colour for a solid background. Omit to keep Figma’s default white.' },
      },
      additionalProperties: false,
    },
    params: (args) => ({
      ...args,
      ...(args.fill === undefined ? {} : { fill: parseColor(args.fill) }),
    }),
  },
  {
    name: 'figma_save_version',
    title: 'Checkpoint the file',
    description:
      'Saves a named point in the file’s version history. Call this before a run that will change several things, so there is one place to fall back to that is not a stack of undos.',
    mutates: true,
    command: 'save_version',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What this checkpoint is for.' },
        description: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    params: (args) => ({ title: args.title, ...(args.description === undefined ? {} : { description: args.description }) }),
  },
]

export const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]))

/** The tool list an MCP client sees: no `command`, no `params`, no `mutates`. */
export function toolManifest() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: { readOnlyHint: !tool.mutates, destructiveHint: tool.mutates },
  }))
}
