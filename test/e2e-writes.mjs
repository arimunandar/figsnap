// The commands that change the file, on the real main thread.
//
// These are the only commands in this plugin that write, so what matters is not
// only that they land but that the two things which make an edit safe happen
// too: `figma.commitUndo()`, without which the change is not in undo history at
// all, and the re-extract, without which the panel goes on showing the design
// as it was while the canvas has moved on — an edit that looks like it failed.
//
// dist/code.js runs against the stand-in figma from test/support/plugin.mjs, so
// everything from an HTTP request to the property assignment is shipped code.

import { startPlugin, makeNode } from './support/plugin.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const settled = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const label = makeNode('1:3', 'Done', 'TEXT')
const button = makeNode('1:2', 'Done button', 'FRAME', [label])
const screen = makeNode('1:1', 'Watchlist', 'FRAME', [button])

const plugin = await startPlugin({ pageChildren: [screen], label: 'writes' })
const { figma, panelMessages } = plugin

// One node selected is what the panel previews, and what a re-extract renders.
figma.currentPage.selection = [screen]

// --------------------------------------------------------------------- fills

button.fills = [{ type: 'SOLID', color: { r: 0.38, g: 0.3, b: 0.81 } }]
panelMessages.length = 0

const filled = await plugin.body('POST', '/extract', { nodeId: '1:2', format: ['css'] })
check('the fixture reads before it is written to', filled.status === 200)

// The relay exposes no write routes on purpose: writing is the agent daemon's
// path, and it reaches `handleRequest` through the panel. Drive it the same way.
const command = (name, params = {}) =>
  new Promise((resolve) => {
    const id = `w${Math.random().toString(36).slice(2)}`
    const listen = setInterval(() => {
      const answer = panelMessages.find((message) => message.type === 'res' && message.id === id)
      if (answer === undefined) return
      clearInterval(listen)
      resolve(answer)
    }, 10)
    plugin.toMain({ type: 'req', id, command: name, params })
  })

figma.undos.length = 0
panelMessages.length = 0

// The exact channels #f74c4c parses to, so the answer proves a round trip
// rather than agreeing with itself.
const setFill = await command('set_fill', { nodeId: '1:2', color: { r: 247 / 255, g: 76 / 255, b: 76 / 255 } })
check('set_fill answers', setFill.ok === true, setFill.error ?? '')
check('the node is actually filled',
  button.fills.length === 1 && button.fills[0].type === 'SOLID' && Math.round(button.fills[0].color.r * 255) === 247)
check('and the colour is read back off the node, not echoed',
  setFill.data.fill === '#f74c4c', String(setFill.data.fill))
check('naming what it replaced, so a gradient is not thrown away silently',
  setFill.data.replaced === 'SOLID', String(setFill.data.replaced))
check('the edit is in undo history', figma.undos.length === 1, `${figma.undos.length} commits`)

// The bug this suite exists for: an agent editing the file does not change the
// selection, so nothing used to make the panel look again.
await settled(500)
check('the panel is re-sent the design after an edit',
  panelMessages.some((message) => message.type === 'extract' && message.id === '1:1'),
  panelMessages.map((message) => message.type).join(','))

// A burst of edits is one re-render, not one per edit.
panelMessages.length = 0
for (const shade of [0.1, 0.2, 0.3, 0.4, 0.5]) {
  await command('set_fill', { nodeId: '1:2', color: { r: shade, g: shade, b: shade } })
}
await settled(500)
check('five edits cost one re-render',
  panelMessages.filter((message) => message.type === 'extract').length === 1,
  `${panelMessages.filter((message) => message.type === 'extract').length} renders`)

// ------------------------------------------------------------------- strokes

figma.undos.length = 0
const setStroke = await command('set_stroke', { nodeId: '1:2', color: { r: 0, g: 0, b: 1 }, weight: 2 })
check('set_stroke answers', setStroke.ok === true, setStroke.error ?? '')
check('a border is a stroke, and lands as one',
  button.strokes.length === 1 && button.strokeWeight === 2)
check('read back like a fill', setStroke.data.stroke === '#0000ff' && setStroke.data.weight === 2)

const cleared = await command('set_stroke', { nodeId: '1:2', remove: true })
check('and it can be taken off again', cleared.ok === true && button.strokes.length === 0)
check('both were undoable', figma.undos.length === 2, `${figma.undos.length} commits`)

// ---------------------------------------------------------------------- text

const setText = await command('set_text', { nodeId: '1:3', text: 'Save' })
check('set_text retypes a TEXT layer', setText.ok === true && label.characters === 'Save', setText.error ?? '')

label.hasMissingFont = true
const missing = await command('set_text', { nodeId: '1:3', text: 'Nope' })
check('a font this machine lacks is refused rather than substituted',
  missing.ok === false && String(missing.error).includes('font'), String(missing.error))
check('and the text is left alone', label.characters === 'Save')
label.hasMissingFont = false

const notText = await command('set_text', { nodeId: '1:2', text: 'Nope' })
check('so is a layer that has no characters',
  notText.ok === false && String(notText.error).includes('TEXT'), String(notText.error))

// ------------------------------------------------------------------- layout

const layout = await command('set_auto_layout', {
  nodeId: '1:2',
  mode: 'VERTICAL',
  itemSpacing: 8,
  paddingTop: 4,
})
check('set_auto_layout applies only what it was given',
  layout.ok === true && button.layoutMode === 'VERTICAL' && button.itemSpacing === 8 && button.paddingTop === 4,
  layout.error ?? '')
check('and leaves the rest of the padding alone', button.paddingLeft === undefined || button.paddingLeft === 0)

const badMode = await command('set_auto_layout', { nodeId: '1:2', mode: 'SIDEWAYS' })
check('an invented mode is refused', badMode.ok === false, String(badMode.error))

// -------------------------------------------------------------------- frames

panelMessages.length = 0
const created = await command('create_frame', { name: 'New card', parentId: '1:1', width: 200, height: 80 })
check('create_frame answers with the new id', created.ok === true && typeof created.data.id === 'string',
  created.error ?? '')
check('and puts it where it was told', screen.children.some((child) => child.name === 'New card'))
await settled(500)
check('a new layer refreshes the tree, not only the picture',
  panelMessages.some((message) => message.type === 'tree'),
  panelMessages.map((message) => message.type).join(','))

// -------------------------------------------------------------- making things

panelMessages.length = 0
const madeText = await command('create_text', { text: 'Sign in', parentId: '1:1', fontSize: 16, x: 8, y: 8 })
check('create_text answers with the new id', madeText.ok === true && typeof madeText.data.id === 'string',
  madeText.error ?? '')
const textNode = plugin.nodes.get(madeText.data.id)
check('and the layer holds the words', textNode.characters === 'Sign in' && textNode.fontSize === 16)
check('named after them when nothing else was given', textNode.name === 'Sign in')
check('placed where it was told', textNode.parent === screen && textNode.x === 8)

const missingFont = await command('create_text', { text: 'x', fontFamily: 'A Font Nobody Has' })
check('a font this machine lacks is refused, not substituted',
  missingFont.ok === false && String(missingFont.error).includes('no "A Font Nobody Has'), String(missingFont.error))

const rect = await command('create_rectangle', {
  parentId: '1:1', width: 200, height: 2, fill: { r: 0, g: 0, b: 0 }, cornerRadius: 1,
})
check('create_rectangle answers', rect.ok === true, rect.error ?? '')
const rectNode = plugin.nodes.get(rect.data.id)
check('sized and filled as asked', rectNode.width === 200 && rectNode.fills.length === 1)

const ellipse = await command('create_ellipse', { parentId: '1:1', width: 40, height: 40 })
check('create_ellipse answers', ellipse.ok === true, ellipse.error ?? '')

const svg = await command('create_svg', { svg: '<svg viewBox="0 0 4 4"><rect width="4" height="4"/></svg>', parentId: '1:1' })
check('create_svg draws real vectors rather than an image', svg.ok === true, svg.error ?? '')
const notSvg = await command('create_svg', { svg: 'not markup' })
check('and refuses what Figma cannot read', notSvg.ok === false, String(notSvg.error))

// ----------------------------------------------------- moving things about

const copy = await command('clone_node', { nodeId: rect.data.id })
check('clone_node duplicates into the same parent',
  copy.ok === true && screen.children.some((child) => child.id === copy.data.id),
  copy.error ?? screen.children.map((child) => child.id).join())

const moved = await command('move_node', { nodeId: rect.data.id, parentId: '1:2', index: 0 })
check('move_node reparents and reorders',
  moved.ok === true && button.children[0].id === rect.data.id, moved.error ?? '')

const removed = await command('delete_node', { nodeId: copy.data.id })
check('delete_node takes a layer away',
  removed.ok === true && !screen.children.some((child) => child.id === copy.data.id), removed.error ?? '')

// -------------------------------------------------------------- appearance

const bounds = await command('set_bounds', { nodeId: '1:2', x: 12, width: 320 })
check('set_bounds moves and resizes what it was given',
  bounds.ok === true && button.x === 12 && button.width === 320, bounds.error ?? '')
check('and leaves what it was not', button.height === 100)

const radius = await command('set_corner_radius', { nodeId: '1:2', radius: 8 })
check('set_corner_radius rounds every corner', radius.ok === true && button.cornerRadius === 8, radius.error ?? '')
const corners = await command('set_corner_radius', { nodeId: '1:2', topLeftRadius: 2, bottomRightRadius: 6 })
check('or each on its own',
  corners.ok === true && button.topLeftRadius === 2 && button.bottomRightRadius === 6, corners.error ?? '')

const renamed = await command('set_node_name', { nodeId: '1:2', name: 'Primary button' })
check('set_node_name renames', renamed.ok === true && button.name === 'Primary button', renamed.error ?? '')
const blank = await command('set_node_name', { nodeId: '1:2', name: '  ' })
check('and refuses an empty one', blank.ok === false, String(blank.error))

const faded = await command('set_visibility', { nodeId: '1:2', opacity: 0.5, locked: true })
check('set_visibility fades and locks',
  faded.ok === true && button.opacity === 0.5 && button.locked === true, faded.error ?? '')
const clamped = await command('set_visibility', { nodeId: '1:2', opacity: 4 })
check('and refuses an opacity outside 0-1', clamped.ok === false, String(clamped.error))

const shadow = await command('set_effects', {
  nodeId: '1:2',
  effects: [{ type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0 }, alpha: 0.2, offsetY: 4, radius: 12 }],
})
check('set_effects gives it a shadow',
  shadow.ok === true && button.effects[0].type === 'DROP_SHADOW' && button.effects[0].radius === 12,
  shadow.error ?? '')
check('with the alpha folded into the colour', button.effects[0].color.a === 0.2)
const noEffects = await command('set_effects', { nodeId: '1:2', effects: [] })
check('and an empty list clears them', noEffects.ok === true && button.effects.length === 0)
const nonsense = await command('set_effects', { nodeId: '1:2', effects: [{ type: 'GLOW' }] })
check('an invented effect is refused', nonsense.ok === false, String(nonsense.error))

// -------------------------------------------------------------------- type

const typed = await command('set_text_style', { nodeId: '1:3', fontSize: 22, align: 'CENTER', lineHeight: 28 })
check('set_text_style applies only what it was given',
  typed.ok === true && label.fontSize === 22 && label.textAlignHorizontal === 'CENTER' &&
  label.lineHeight.value === 28, typed.error ?? '')
check('and leaves the characters alone', label.characters === 'Save')

// ------------------------------------------------------------------ layout

const sizing = await command('set_layout_sizing', { nodeId: '1:3', horizontal: 'FILL' })
check('set_layout_sizing is how a width is set inside auto layout',
  sizing.ok === true && label.layoutSizingHorizontal === 'FILL', sizing.error ?? '')

// ------------------------------------------------------ the design system

figma.styles.set('S:brand', { id: 'S:brand', name: 'Brand/Primary', type: 'PAINT' })
figma.variables.collections = [{ id: 'C:1', name: 'Tokens' }]
figma.variables.store.set('V:radius', { id: 'V:radius', name: 'Radius/Large', resolvedType: 'FLOAT', variableCollectionId: 'C:1' })

const library = await command('list_library', {})
check('list_library reports the styles this file has',
  library.ok === true && library.data.styles.paint[0].name === 'Brand/Primary', library.error ?? '')
check('and its variables, with the collection they came from',
  library.data.variables[0].collection === 'Tokens', JSON.stringify(library.data.variables))
check('and the components an instance could be made from',
  Array.isArray(library.data.components))

const styled = await command('apply_style', { nodeId: '1:2', styleId: 'S:brand' })
check('apply_style links the layer to the style rather than copying its value',
  styled.ok === true && button.fillStyleId === 'S:brand', styled.error ?? '')
const noStyle = await command('apply_style', { nodeId: '1:2', styleId: 'S:nope' })
check('and an id that resolves to nothing says so', noStyle.ok === false, String(noStyle.error))

const bound = await command('bind_variable', { nodeId: '1:2', variableId: 'V:radius', field: 'cornerRadius' })
check('bind_variable ties a property to a token',
  bound.ok === true && button.boundVariables.cornerRadius === 'V:radius', bound.error ?? '')

button.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }]
figma.variables.store.set('V:brand', { id: 'V:brand', name: 'Colour/Brand', resolvedType: 'COLOR', variableCollectionId: 'C:1' })
const boundFill = await command('bind_variable', { nodeId: '1:2', variableId: 'V:brand', field: 'fill' })
check('a colour binds through the paint, which is where it lives',
  boundFill.ok === true && button.fills[0].boundVariables.color.id === 'V:brand', boundFill.error ?? '')

button.fills = []
const nothingToBind = await command('bind_variable', { nodeId: '1:2', variableId: 'V:brand', field: 'fill' })
check('and a node with no fill is told to set one first',
  nothingToBind.ok === false && String(nothingToBind.error).includes('set one first'), String(nothingToBind.error))

// ------------------------------------------------------------------ versions

const version = await command('save_version', { title: 'Before purple to red swap' })
check('save_version writes a named checkpoint',
  version.ok === true && figma.versions[0]?.title === 'Before purple to red swap')

// ------------------------------------------------------------------- refusal

const nowhere = await command('set_fill', { nodeId: 'does:not:exist', color: { r: 1, g: 0, b: 0 } })
check('an id that resolves to nothing says so', nowhere.ok === false, String(nowhere.error))

const badColor = await command('set_fill', { nodeId: '1:2', color: { r: 5, g: 0, b: 0 } })
check('and a channel out of range is refused rather than clamped', badColor.ok === false, String(badColor.error))

plugin.stop()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
