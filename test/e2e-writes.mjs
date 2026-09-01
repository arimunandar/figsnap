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
