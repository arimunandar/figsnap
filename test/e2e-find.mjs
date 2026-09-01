// Reaching the rest of the file, on the real main thread.
//
// The reading tools that came before all answer about `figma.currentPage`, which
// is a silent lie on a file that has more than one page: a frame on another page
// looks exactly like a frame that does not exist, and an agent has no way to
// tell those apart. So the fixture here has two pages, and half of what this
// asserts is that the second one is reachable at all.
//
// dist/code.js runs against the stand-in figma from test/support/plugin.mjs, so
// this is shipped code doing the searching, grouping and decoding.

import { startPlugin, makeNode } from './support/plugin.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ------------------------------------------------------------------ fixture

const label = makeNode('1:3', 'Label', 'TEXT')
label.characters = 'Add to cart'
const icon = makeNode('1:4', 'Icon', 'VECTOR')
const button = makeNode('1:2', 'Primary button', 'INSTANCE', [label, icon])
button.componentProperties = {
  'Size': { type: 'VARIANT', value: 'Medium', variantOptions: ['Small', 'Medium', 'Large'] },
  'Label#8:2': { type: 'TEXT', value: 'Add to cart' },
  'Has icon#8:3': { type: 'BOOLEAN', value: true },
}
const source = makeNode('1:9', 'Button', 'COMPONENT_SET')
source.componentPropertyDefinitions = {
  'Size': { type: 'VARIANT', defaultValue: 'Medium', variantOptions: ['Small', 'Medium', 'Large'] },
  'Label#8:2': { type: 'TEXT', defaultValue: 'Button' },
  'Has icon#8:3': { type: 'BOOLEAN', defaultValue: true },
}
button.mainComponent = source

const heading = makeNode('1:5', 'Heading', 'TEXT')
heading.characters = 'Checkout'
const badge = makeNode('1:6', 'Badge', 'ELLIPSE')
const screen = makeNode('1:1', 'Checkout screen', 'FRAME', [button, heading, badge])

// On the other page, which is the whole point.
const spec = makeNode('2:2', 'Spec notes', 'TEXT')
spec.characters = 'Add to cart is the primary action'
const handoff = makeNode('2:1', 'Handoff frame', 'FRAME', [spec])

const plugin = await startPlugin({
  label: 'find',
  pageChildren: [screen],
  offPage: [source],
  otherPage: [handoff],
})
const { figma, panelMessages } = plugin

/** The daemon's path: a command straight at the main thread, as the panel does. */
const command = (name, params = {}) =>
  new Promise((resolve) => {
    const id = `f${Math.random().toString(36).slice(2)}`
    const listen = setInterval(() => {
      const answer = panelMessages.find((message) => message.type === 'res' && message.id === id)
      if (answer === undefined) return
      clearInterval(listen)
      resolve(answer)
    }, 10)
    plugin.toMain({ type: 'req', id, command: name, params })
  })

const settled = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

figma.undos.length = 0
panelMessages.length = 0

// --------------------------------------------------------------- find_nodes

const byType = await command('find_nodes', { types: ['TEXT'] })
check('find_nodes answers', byType.ok === true, byType.error ?? '')
check('it finds by type', byType.data.rows.map((row) => row.id).sort().join(',') === '1:3,1:5',
  byType.data.rows.map((row) => `${row.id} ${row.type}`).join(' | '))
check('and says which page each row is on', byType.data.rows.every((row) => row.page === 'Page 1'))

const byName = await command('find_nodes', { name: 'butt' })
check('name is a case-insensitive substring',
  byName.data.rows.length === 1 && byName.data.rows[0].id === '1:2',
  byName.data.rows.map((row) => row.name).join(' | '))

const byText = await command('find_nodes', { text: 'add to CART' })
check('text matches the words in a text layer, whatever the case',
  byText.data.rows.length === 1 && byText.data.rows[0].id === '1:3',
  byText.data.rows.map((row) => row.name).join(' | '))

const narrowed = await command('find_nodes', { types: ['TEXT'], name: 'heading' })
check('the filters narrow together rather than widening',
  narrowed.data.rows.length === 1 && narrowed.data.rows[0].id === '1:5')

const scoped = await command('find_nodes', { nodeId: '1:2' })
check('nodeId searches one branch',
  scoped.data.rows.map((row) => row.id).sort().join(',') === '1:3,1:4',
  scoped.data.rows.map((row) => row.id).join(' | '))

const capped = await command('find_nodes', { limit: 2 })
check('limit is honoured and the answer admits it was cut',
  capped.data.rows.length === 2 && capped.data.truncated === true)

const refused = await command('find_nodes', { types: ['BUTTON'] })
check('a type Figma would throw on is refused with the list that works',
  refused.ok === false && refused.error.includes('COMPONENT_SET'),
  String(refused.error).slice(0, 90))

// The bug the tool exists for: this text is not on the open page.
const thisPage = await command('find_nodes', { text: 'primary action' })
check('a layer on another page is not found by default', thisPage.data.rows.length === 0)
const wholeFile = await command('find_nodes', { text: 'primary action', allPages: true })
check('allPages finds it', wholeFile.data.rows.length === 1 && wholeFile.data.rows[0].id === '2:2',
  JSON.stringify(wholeFile.data.rows))
check('and names the page it is on, so the answer is actionable',
  wholeFile.data.rows[0].page === 'Handoff', String(wholeFile.data.rows[0].page))
check('the other page had to be loaded to be searched', figma.root.children[1].loaded === true)
check('searching does not touch undo history', figma.undos.length === 0, `${figma.undos.length} commits`)

// -------------------------------------------------------------------- pages

const listed = await command('pages', { action: 'list' })
check('pages list names the file and every page',
  listed.data.file === 'Test file' && listed.data.pages.length === 2,
  JSON.stringify(listed.data.pages))
check('and which one is open',
  listed.data.pages.filter((page) => page.current).map((page) => page.name).join('') === 'Page 1')

const opened = await command('pages', { action: 'open', name: 'hand' })
check('a page opens by name', opened.ok === true && figma.currentPage.id === 'p2', opened.error ?? '')
check('the answer reports the switch', opened.data.page === 'Handoff')
await settled(500)
check('the panel is re-sent the tree, which is now a different page',
  panelMessages.some((message) => message.type === 'tree'),
  panelMessages.map((message) => message.type).join(','))
check('opening a page is not an edit, so nothing is in undo history',
  figma.undos.length === 0, `${figma.undos.length} commits`)

const back = await command('pages', { action: 'open', pageId: 'p1' })
check('and by id', back.ok === true && figma.currentPage.id === 'p1')
const missing = await command('pages', { action: 'open', name: 'nope' })
check('a page that is not there says so and points at list',
  missing.ok === false && missing.error.includes('list'), String(missing.error))

// ------------------------------------------------------ component_properties

const properties = await command('component_properties', { nodeId: '1:2' })
check('component_properties answers for an instance', properties.ok === true, properties.error ?? '')
check('it names the main component',
  properties.data.mainComponent?.id === '1:9', JSON.stringify(properties.data.mainComponent))
check('it returns the definitions, variant options and all',
  properties.data.properties.find((property) => property.key === 'Size')?.options?.join(',') === 'Small,Medium,Large',
  JSON.stringify(properties.data.properties.map((property) => property.key)))
// The reason this tool exists: the key is not the name a person would guess.
check('the values carry the exact keys setProperties needs, id suffix included',
  properties.data.values.map((value) => value.key).sort().join(',') === 'Has icon#8:3,Label#8:2,Size',
  properties.data.values.map((value) => value.key).join(' | '))
check('with what the instance is set to now',
  properties.data.values.find((value) => value.key === 'Size')?.value === 'Medium')

const notOne = await command('component_properties', { nodeId: '1:5' })
check('a layer with no properties is refused rather than answered emptily',
  notOne.ok === false && notOne.error.includes('component'), String(notOne.error).slice(0, 80))

// ------------------------------------------------------------------ grouping

figma.undos.length = 0
const grouped = await command('group_nodes', { action: 'group', nodeIds: ['1:5', '1:6'], name: 'Header' })
check('group answers with the new group', grouped.ok === true && grouped.data.type === 'GROUP', grouped.error ?? '')
check('it is named', grouped.data.name === 'Header')
check('the children really moved into it',
  heading.parent?.id === grouped.data.id && badge.parent?.id === grouped.data.id,
  `${heading.parent?.id} ${badge.parent?.id}`)
check('and it lands in the first one’s own parent, not on the page',
  grouped.data.parentId === '1:1', String(grouped.data.parentId))
check('grouping is in undo history', figma.undos.length === 1, `${figma.undos.length} commits`)

const ungrouped = await command('group_nodes', { action: 'ungroup', nodeId: grouped.data.id })
check('ungroup hands back what it let go',
  ungrouped.ok === true && ungrouped.data.ungrouped.length === 2, ungrouped.error ?? '')
check('and the children are back in the frame',
  heading.parent?.id === '1:1' && badge.parent?.id === '1:1')

const nothing = await command('group_nodes', { action: 'group', nodeIds: [] })
check('grouping nothing is refused', nothing.ok === false, String(nothing.error).slice(0, 60))
const notAGroup = await command('group_nodes', { action: 'ungroup', nodeId: '1:5' })
check('ungrouping a text layer is refused with what it is',
  notAGroup.ok === false && notAGroup.error.includes('TEXT'), String(notAGroup.error).slice(0, 70))

// -------------------------------------------------------------- insert_image

// A one-pixel PNG, which is a real one: the point is that the bytes survive
// base64 and arrive as something Figma will accept.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

figma.undos.length = 0
const inserted = await command('insert_image', { data: PNG, name: 'Hero', x: 10, y: 20 })
check('insert_image answers', inserted.ok === true, inserted.error ?? '')
check('it arrives as a rectangle at its own pixel size',
  inserted.data.type === 'RECTANGLE' && inserted.data.width === 24 && inserted.data.height === 12,
  JSON.stringify({ type: inserted.data.type, width: inserted.data.width, height: inserted.data.height }))
check('named as asked', inserted.data.name === 'Hero')
check('the bytes were decoded, not passed through as text',
  figma.images.length === 1 && figma.images[0].bytes[0] === 0x89,
  `${figma.images.length} images`)
const placed = figma.currentPage.children.find((node) => node.id === inserted.data.id)
check('and it is filled with the image, by the hash Figma gave back',
  placed?.fills?.[0]?.type === 'IMAGE' && placed.fills[0].imageHash === figma.images[0].hash,
  JSON.stringify(placed?.fills?.[0] ?? null))
check('inserting is in undo history', figma.undos.length === 1, `${figma.undos.length} commits`)

const dataUrl = await command('insert_image', { data: `data:image/png;base64,${PNG}` })
check('a data: URL prefix is accepted rather than breaking the decode', dataUrl.ok === true, dataUrl.error ?? '')

const onto = await command('insert_image', { data: PNG, nodeId: '1:6', scaleMode: 'FIT' })
check('with a nodeId it fills that layer instead of making one',
  onto.ok === true && onto.data.id === '1:6' && badge.fills[0]?.type === 'IMAGE',
  JSON.stringify(badge.fills[0] ?? null))
check('and the scale mode is the one asked for', badge.fills[0]?.scaleMode === 'FIT')

const notImage = await command('insert_image', { data: 'bm90IGFuIGltYWdl' })
check('something that is not an image is refused with Figma’s own reason',
  notImage.ok === false && notImage.error.includes('image'), String(notImage.error).slice(0, 80))
const tooBig = await command('insert_image', { data: 'A'.repeat(800_000) })
check('and one too large to carry says so, with both sizes',
  tooBig.ok === false && tooBig.error.includes('800KB') && tooBig.error.includes('700KB'),
  String(tooBig.error).slice(0, 90))

// --------------------------------------------------- set_instance_properties

figma.undos.length = 0
const setVariant = await command('set_instance_properties', { nodeId: '1:2', properties: { Size: 'Large' } })
check('set_instance_properties answers', setVariant.ok === true, setVariant.error ?? '')
check('the variant actually changed',
  button.componentProperties['Size'].value === 'Large', String(button.componentProperties['Size'].value))
check('and the answer reads the values back off the instance',
  setVariant.data.values.find((value) => value.key === 'Size')?.value === 'Large')

// The affordance that makes the id suffix survivable: the name alone is enough.
const shortKey = await command('set_instance_properties', { nodeId: '1:2', properties: { Label: 'Buy now' } })
check('a key given without its id suffix is matched anyway',
  shortKey.ok === true && button.componentProperties['Label#8:2'].value === 'Buy now',
  shortKey.error ?? String(button.componentProperties['Label#8:2'].value))

const booleanToo = await command('set_instance_properties', { nodeId: '1:2', properties: { 'Has icon#8:3': false } })
check('a boolean stays a boolean rather than becoming the string "false"',
  booleanToo.ok === true && button.componentProperties['Has icon#8:3'].value === false,
  JSON.stringify(button.componentProperties['Has icon#8:3'].value))

const wrongKey = await command('set_instance_properties', { nodeId: '1:2', properties: { Colour: 'Red' } })
check('an unknown property is refused with the list of real ones',
  wrongKey.ok === false && wrongKey.error.includes('Size'), String(wrongKey.error).slice(0, 90))

const wrongValue = await command('set_instance_properties', { nodeId: '1:2', properties: { Size: 'Enormous' } })
check('a variant option that does not exist is refused rather than silently kept',
  wrongValue.ok === false, String(wrongValue.error).slice(0, 80))
check('and the instance is left as it was',
  button.componentProperties['Size'].value === 'Large')

const notInstance = await command('set_instance_properties', { nodeId: '1:5', properties: { Size: 'Large' } })
check('only an instance has properties to set',
  notInstance.ok === false && notInstance.error.includes('TEXT'), String(notInstance.error).slice(0, 70))

check('every property change is in undo history', figma.undos.length === 3, `${figma.undos.length} commits`)

plugin.stop()

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
