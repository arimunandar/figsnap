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

  {
    name: 'figma_list_library',
    title: 'The design system in this file',
    description:
      'The components, styles and variables this file has, with the ids the other tools need. Read this before "make it match our button" or "use our brand colour" — instantiating the real component or binding the real variable is what makes a change survive contact with the design system, rather than a hex code that looks right today.',
    mutates: false,
    command: 'list_library',
    inputSchema: {
      type: 'object',
      properties: {
        only: {
          type: 'string',
          enum: ['components', 'styles', 'variables', 'all'],
          description: 'Narrow the answer. Default all three.',
        },
      },
      additionalProperties: false,
    },
    params: (args) => (args.only === undefined ? {} : { only: args.only }),
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
    name: 'figma_create_text',
    title: 'Add a text layer',
    description:
      'Creates a TEXT layer with the words you give it. The font is loaded before anything is typed, and a font this machine does not have is refused rather than substituted. Give a width to make it wrap; without one it hugs its text.',
    mutates: true,
    command: 'create_text',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The characters.' },
        parentId: { type: 'string', description: 'Put it inside this node. Default: the current page.' },
        name: { type: 'string', description: 'Layer name. Defaults to the text itself.' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 1, description: 'Fixed width, so the text wraps.' },
        fontFamily: { type: 'string', description: 'Default Inter.' },
        fontStyle: { type: 'string', description: 'Weight or style, like "Bold". Default Regular.' },
        fontSize: { type: 'number', minimum: 1 },
        color: { type: 'string', description: 'Hex colour for the text.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    params: (args) => ({ ...args, ...(args.color === undefined ? {} : { color: parseColor(args.color) }) }),
  },

  {
    name: 'figma_create_rectangle',
    title: 'Add a rectangle',
    description:
      'Creates a rectangle. The workhorse shape: dividers, bars, backgrounds, placeholders. Omit the fill for an empty one.',
    mutates: true,
    command: 'create_rectangle',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: { type: 'string', description: 'Put it inside this node. Default: the current page.' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 0.01, description: 'Default 100.' },
        height: { type: 'number', minimum: 0.01, description: 'Default 100.' },
        cornerRadius: { type: 'number', minimum: 0 },
        fill: { type: 'string', description: 'Hex colour. Omit for no fill.' },
      },
      additionalProperties: false,
    },
    params: (args) => ({ ...args, ...(args.fill === undefined ? {} : { fill: parseColor(args.fill) }) }),
  },

  {
    name: 'figma_create_ellipse',
    title: 'Add an ellipse',
    description: 'Creates an ellipse. Equal width and height give a circle — an avatar, a dot, a radio button.',
    mutates: true,
    command: 'create_ellipse',
    inputSchema: {
      type: 'object',
      properties: {
        parentId: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 0.01, description: 'Default 100.' },
        height: { type: 'number', minimum: 0.01, description: 'Default 100.' },
        fill: { type: 'string', description: 'Hex colour. Omit for no fill.' },
      },
      additionalProperties: false,
    },
    params: (args) => ({ ...args, ...(args.fill === undefined ? {} : { fill: parseColor(args.fill) }) }),
  },

  {
    name: 'figma_create_svg',
    title: 'Draw with SVG',
    description:
      'Turns SVG markup into real Figma vectors — not an image, but editable paths in a frame. This is how to add an icon, a logo or any shape the other create tools cannot express. Extraction returns icons as SVG too, so a shape can be read out of one place and drawn into another unchanged.',
    mutates: true,
    command: 'create_svg',
    inputSchema: {
      type: 'object',
      properties: {
        svg: { type: 'string', description: 'The <svg> markup.' },
        parentId: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 0.01, description: 'Scale it to this width.' },
        height: { type: 'number', minimum: 0.01 },
      },
      required: ['svg'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_create_instance',
    title: 'Place a component',
    description:
      'Creates an instance of a component in this file. Get the id from figma_list_library. Naming a variant set places its default variant. Prefer this over drawing a lookalike: an instance keeps its link to the component and updates with it.',
    mutates: true,
    command: 'create_instance',
    inputSchema: {
      type: 'object',
      properties: {
        componentId: { type: 'string', description: 'From figma_list_library.' },
        parentId: { type: 'string' },
        name: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['componentId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_clone_node',
    title: 'Duplicate a layer',
    description:
      'Copies a node, with everything inside it, into the same parent or one you name. The cheapest way to make a second row, card or list item that matches the first exactly.',
    mutates: true,
    command: 'clone_node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node to copy.' },
        parentId: { type: 'string', description: 'Where the copy goes. Default: beside the original.' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_move_node',
    title: 'Reparent or reorder a layer',
    description:
      'Moves a node into another parent, or to a different position among its siblings. Index 0 is the back of the canvas and the top of a layer list; leaving it out puts the node last.',
    mutates: true,
    command: 'move_node',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { ...nodeIdArgument, description: 'The node to move.' },
        parentId: { type: 'string', description: 'New parent. Default: keep the one it has.' },
        index: { type: 'integer', minimum: 0, description: 'Position among siblings.' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_delete_node',
    title: 'Delete a layer',
    description:
      'Removes a node and everything inside it. One undo step, so the designer can take it back with a single Cmd-Z — but say what you are deleting before you do it.',
    mutates: true,
    command: 'delete_node',
    inputSchema: {
      type: 'object',
      properties: { nodeId: { ...nodeIdArgument, description: 'The node to delete.' } },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => ({ nodeId: args.nodeId }),
  },

  {
    name: 'figma_set_bounds',
    title: 'Move or resize',
    description:
      'Sets position and size. Position is ignored inside an auto-layout frame, where the parent decides it — use figma_set_layout_sizing and the parent’s spacing there instead.',
    mutates: true,
    command: 'set_bounds',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', minimum: 0.01 },
        height: { type: 'number', minimum: 0.01 },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_set_corner_radius',
    title: 'Round the corners',
    description: 'Sets one radius for every corner, or each corner on its own.',
    mutates: true,
    command: 'set_corner_radius',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        radius: { type: 'number', minimum: 0, description: 'All four corners.' },
        topLeftRadius: { type: 'number', minimum: 0 },
        topRightRadius: { type: 'number', minimum: 0 },
        bottomRightRadius: { type: 'number', minimum: 0 },
        bottomLeftRadius: { type: 'number', minimum: 0 },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_set_node_name',
    title: 'Rename a layer',
    description:
      'Renames a layer. Layer names are what the generated code turns into class names, so tidying them is a real change and not cosmetic.',
    mutates: true,
    command: 'set_node_name',
    inputSchema: {
      type: 'object',
      properties: { nodeId: nodeIdArgument, name: { type: 'string' } },
      required: ['nodeId', 'name'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_set_visibility',
    title: 'Hide, lock or fade a layer',
    description: 'Sets opacity, visibility and lock. Hidden layers are skipped by extraction, which is often the point.',
    mutates: true,
    command: 'set_visibility',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        opacity: { type: 'number', minimum: 0, maximum: 1 },
        visible: { type: 'boolean' },
        locked: { type: 'boolean' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_set_effects',
    title: 'Set shadows and blurs',
    description:
      'Replaces a node’s effects with the list you give. An empty list clears them. Elevation in most design systems is a drop shadow, so this is what "make it look raised" means.',
    mutates: true,
    command: 'set_effects',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        effects: {
          type: 'array',
          description: 'In back-to-front order. Empty clears every effect.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['DROP_SHADOW', 'INNER_SHADOW', 'LAYER_BLUR', 'BACKGROUND_BLUR'] },
              color: { type: 'string', description: 'Hex colour of the shadow. Default black.' },
              alpha: { type: 'number', minimum: 0, maximum: 1, description: 'Shadow opacity. Default 0.25.' },
              offsetX: { type: 'number', description: 'Default 0.' },
              offsetY: { type: 'number', description: 'Default 2.' },
              radius: { type: 'number', minimum: 0, description: 'Blur radius. Default 4.' },
              spread: { type: 'number', description: 'Default 0.' },
            },
            required: ['type'],
            additionalProperties: false,
          },
        },
      },
      required: ['nodeId', 'effects'],
      additionalProperties: false,
    },
    params: (args) => ({
      nodeId: args.nodeId,
      effects: (args.effects ?? []).map((effect) => ({
        ...effect,
        ...(effect.color === undefined ? {} : { color: parseColor(effect.color) }),
      })),
    }),
  },

  {
    name: 'figma_set_text_style',
    title: 'Set type on a text layer',
    description:
      'Font, size, line height, letter spacing, alignment and colour, on a TEXT layer. Only what you name is changed. Prefer figma_apply_style where the file has a text style for it — a named style survives a redesign and a hard-coded 14px does not.',
    mutates: true,
    command: 'set_text_style',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        fontFamily: { type: 'string' },
        fontStyle: { type: 'string', description: 'Weight or style, like "Semi Bold".' },
        fontSize: { type: 'number', minimum: 1 },
        lineHeight: { type: 'number', minimum: 0, description: 'In pixels.' },
        letterSpacing: { type: 'number', description: 'In pixels.' },
        align: { type: 'string', enum: ['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] },
        autoResize: { type: 'string', enum: ['NONE', 'WIDTH_AND_HEIGHT', 'HEIGHT', 'TRUNCATE'] },
        color: { type: 'string', description: 'Hex colour.' },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => ({ ...args, ...(args.color === undefined ? {} : { color: parseColor(args.color) }) }),
  },

  {
    name: 'figma_set_layout_sizing',
    title: 'Hug, fill or fix a size',
    description:
      'How a child behaves inside an auto-layout frame: HUG shrinks to its contents, FILL stretches to the parent, FIXED keeps its size. This, not figma_set_bounds, is how widths are set inside auto layout.',
    mutates: true,
    command: 'set_layout_sizing',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        horizontal: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
        vertical: { type: 'string', enum: ['FIXED', 'HUG', 'FILL'] },
      },
      required: ['nodeId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_apply_style',
    title: 'Apply a shared style',
    description:
      'Applies a paint, text or effect style from this file by id, from figma_list_library. The right way to make something "match": the layer follows the style afterwards, where a copied hex code does not.',
    mutates: true,
    command: 'apply_style',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        styleId: { type: 'string', description: 'From figma_list_library.' },
      },
      required: ['nodeId', 'styleId'],
      additionalProperties: false,
    },
    params: (args) => args,
  },

  {
    name: 'figma_bind_variable',
    title: 'Bind a variable',
    description:
      'Binds a variable from this file to a property, so the value follows the token rather than being a copy of it. Use "fill" or "stroke" for a colour variable; for a number use the property name, like cornerRadius, itemSpacing, paddingLeft, width or opacity.',
    mutates: true,
    command: 'bind_variable',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: nodeIdArgument,
        variableId: { type: 'string', description: 'From figma_list_library.' },
        field: {
          type: 'string',
          description: '"fill", "stroke", or a numeric property such as cornerRadius or itemSpacing.',
        },
      },
      required: ['nodeId', 'variableId', 'field'],
      additionalProperties: false,
    },
    params: (args) => args,
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
