// Walking the tree, and choosing what /extract returns.
//
// Both run against the real dist/code.js behind a real relay, so the depth
// limits, the shape of a nested row and which outputs come back are the shipped
// behaviour rather than a description of it.

import { startPlugin, makeNode } from './support/plugin.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// Four levels, so depth 1, 2, 3 and "all" are all distinguishable.
const leaf = makeNode('4:1', 'Label', 'TEXT', [], {
  // What Dev Mode gives a text layer: one font name, no fallback.
  'font-family': 'Inter',
  'font-weight': '500',
  'font-size': '14px',
})
const inner = makeNode('3:1', 'Row', 'FRAME', [leaf])
const middle = makeNode('2:1', 'Card', 'FRAME', [inner])
const hidden = makeNode('2:2', 'Hidden card', 'FRAME', [makeNode('3:2', 'Never seen', 'TEXT')])
hidden.visible = false
const top = makeNode('1:1', 'Group 1', 'GROUP', [middle, hidden])

// A stroked layer with no height, and a layer with an absolutely placed child:
// the two shapes the html renderer has to correct for.
const pinned = makeNode('5:1', 'Badge', 'FRAME', [], { border: '1px solid #624CF7', display: 'flex' })
const floating = makeNode('6:2', 'Overlay', 'FRAME', [], { position: 'absolute', left: '0px' })
// What Dev Mode writes for an image fill, and for spacing CSS cannot express.
const photo = makeNode('5:2', 'Avatar', 'FRAME', [], {
  background: 'url(<path-to-image>) lightgray 50% / cover no-repeat',
})
const squashed = makeNode('5:3', 'Underline', 'FRAME', [], { height: '4px', padding: '10px' })
// The node really is 4px tall; Figma simply lets the padding overrun and clips.
squashed.height = 4
const tightened = makeNode('5:4', 'Stack', 'FRAME', [], { display: 'flex', 'flex-direction': 'column', gap: '-4px' })
const holder = makeNode('6:1', 'Holder', 'FRAME', [floating], { display: 'block' })
const fixtures = makeNode('5:0', 'Fixtures', 'FRAME', [pinned, holder, photo, squashed, tightened])

const plugin = await startPlugin({ label: 'tree', pageChildren: [top], offPage: [fixtures] })
const { get, body } = plugin

// ------------------------------------------------------------------ depth

const flat = await get('/tree')
check('no depth is still one level', flat.rows.length === 1 && flat.rows[0].children === undefined)
check('and says so', flat.depth === 1 && flat.nodeCount === 1)
check('childCount still points the way down', flat.rows[0].childCount === 2)

const two = await get('/tree?depth=2')
check('depth=2 brings one level of children', two.rows[0].children?.length === 1)
check('and stops there', two.rows[0].children[0].children === undefined)
check('a hidden layer is left out of the walk',
  two.rows[0].children.every((row) => row.name !== 'Hidden card'))

const three = await get('/tree?depth=3')
check('depth=3 goes deeper again', three.rows[0].children[0].children?.[0]?.id === '3:1')
check('the count follows the walk', three.nodeCount === 3, `nodeCount ${three.nodeCount}`)

const everything = await get('/tree?depth=all')
check('depth=all reaches the bottom',
  everything.rows[0].children[0].children[0].children?.[0]?.id === '4:1')
// Infinity does not survive JSON, so an unlimited walk has to echo something else.
check('depth=all echoes as "all", not null', everything.depth === 'all', JSON.stringify(everything.depth))
check('the deepest row has no children key',
  everything.rows[0].children[0].children[0].children[0].children === undefined)
check('nothing is truncated at this size', everything.truncated === false)

const fromNode = await get('/children/2%3A1?depth=all')
check('/children takes the same depth', fromNode.rows[0].children?.[0]?.id === '4:1')
check('and reports the node it walked from',
  fromNode.parentId === '2:1' && fromNode.nodeCount === 2 && fromNode.depth === 'all')

const shallow = await get('/children/2%3A1')
check('/children still defaults to one level', shallow.rows[0].children === undefined)

const nonsense = await fetch(`${plugin.base}/tree?depth=nope`, { headers: plugin.headers })
const nonsenseBody = await nonsense.json()
check('a bad depth is refused, not guessed',
  nonsense.status === 400 && nonsenseBody.error.includes('depth must be'), nonsenseBody.error)
const zero = await (await fetch(`${plugin.base}/tree?depth=0`, { headers: plugin.headers })).json()
check('depth=0 is refused too', typeof zero.error === 'string')

// ----------------------------------------------------------------- format
//
// figmaCss is the expensive one — tens of kilobytes on a real node — so the
// point of asking for less is that it is genuinely not produced.

plugin.figma.currentPage.selection = [inner]

const reactOnly = await body('POST', '/extract', { nodeId: '3:1', format: 'tsx' })
check('one format returns one output',
  typeof reactOnly.data.tsx === 'string' &&
  reactOnly.data.css === undefined &&
  reactOnly.data.moduleCss === undefined &&
  reactOnly.data.figmaCss === undefined,
  Object.keys(reactOnly.data).join(','))
check('and no image is rendered', reactOnly.data.png === undefined)
check('the answer says what was produced',
  JSON.stringify(reactOnly.data.outputs) === JSON.stringify(['tsx']))
check('the metadata is unaffected',
  reactOnly.data.layerCount === 2 && reactOnly.data.name === 'Row' && reactOnly.data.truncated === false)

const pair = await body('POST', '/extract', { nodeId: '3:1', format: ['tsx', 'moduleCss'] })
check('a list returns exactly that list',
  typeof pair.data.tsx === 'string' && typeof pair.data.moduleCss === 'string' && pair.data.css === undefined)
check('order of the keys does not depend on how it was asked',
  JSON.stringify(pair.data.outputs) === JSON.stringify(['tsx', 'moduleCss']))

const commas = await body('POST', '/extract', { nodeId: '3:1', format: 'moduleCss,tsx' })
check('a comma-separated string works too',
  JSON.stringify(commas.data.outputs) === JSON.stringify(['tsx', 'moduleCss']))

const withImage = await body('POST', '/extract', { nodeId: '3:1', format: ['png', 'tsx'] })
check('png is an output like any other',
  typeof withImage.data.png?.url === 'string' && withImage.data.png.bytes === 4)

// topLayerOnly has to reach the Figma-CSS renderer too. Its root is handed a
// real parent so the root's own auto-layout block can be worked out, which is
// what made an earlier "is this the root" test on the parent silently fail.
const deepCss = await body('POST', '/extract', { nodeId: '3:1', format: 'figmaCss' })
check('figmaCss walks the whole subtree by default', deepCss.data.figmaCss.includes('/* Label */'))
const topCss = await body('POST', '/extract', { nodeId: '3:1', format: 'figmaCss', topLayerOnly: true })
check('topLayerOnly stops it at the selected node',
  topCss.data.figmaCss.includes('/* Row */') && !topCss.data.figmaCss.includes('/* Label */'))
check('and that is a smaller answer', topCss.data.figmaCss.length < deepCss.data.figmaCss.length,
  `${topCss.data.figmaCss.length} vs ${deepCss.data.figmaCss.length}`)

const unknown = await body('POST', '/extract', { nodeId: '3:1', format: 'vue' })
check('an unknown format is refused rather than ignored',
  unknown.status === 400 && unknown.data.error.includes('Unknown format vue'), unknown.data.error)

// A caller written before any of this existed must still get everything.
const legacy = await body('POST', '/extract', { nodeId: '3:1' })
check('asking for nothing still means everything',
  JSON.stringify(legacy.data.outputs) === JSON.stringify(['png', 'html', 'tsx', 'moduleCss', 'css', 'figmaCss']),
  JSON.stringify(legacy.data.outputs))
// pngData is deliberately outside the default: it is ~40 KB of body per node.
check('but not the inline image', legacy.data.pngData === undefined)

// ------------------------------------------------------------------- html

const page = await body('POST', '/extract', { nodeId: '3:1', format: 'html' })
const doc = page.data.html
check('html is a whole document, openable as-is',
  doc.startsWith('<!DOCTYPE html>') && doc.includes('</html>'))
check('it carries its own styles', doc.includes('<style>') && doc.includes('.row {'))
check('class names, not React ones', doc.includes('class="row"') && !doc.includes('className'))
check('and the real text', doc.includes('>Label<'))
check('the root gets a size, which Dev Mode CSS leaves to the parent',
  /\.row \{[^}]*width: 100px/.test(doc), doc.slice(doc.indexOf('.row {'), doc.indexOf('.row {') + 90))

// The three things the CSS never says, without which the page is simply wrong.
const fixed = await body('POST', '/extract', { nodeId: '5:0', format: 'html' })
const fixedHtml = fixed.data.html
check('a stroked layer gets the size Figma drew it at',
  /\.badge \{[^}]*height: 100px/.test(fixedHtml),
  fixedHtml.slice(fixedHtml.indexOf('.badge {'), fixedHtml.indexOf('.badge {') + 110).replace(/\n/g, ' '))
check('a layer with an absolute child is made a containing block',
  /\.holder \{[^}]*position: relative/.test(fixedHtml))
check('but an absolute layer is not itself made relative',
  !/\.overlay \{[^}]*position: relative/.test(fixedHtml))

// An image fill points inside Figma; outside it the box would be a hole.
check('an image fill becomes a placeholder colour',
  /\.avatar \{[^}]*background: #dfe3e8/.test(fixedHtml) && !fixedHtml.includes('url(<path-to-image>)'),
  fixedHtml.slice(fixedHtml.indexOf('.avatar {'), fixedHtml.indexOf('.avatar {') + 70).replace(/\n/g, ' '))
check('and says so, rather than looking like a design choice',
  fixedHtml.includes('image fill shown as a placeholder'))

// Figma lets padding exceed its frame and lets spacing go negative; CSS does
// neither, and silently disagrees rather than erroring.
check('padding larger than the frame gives way to the frame',
  /\.underline \{[^}]*padding-top: 0;[^}]*padding-bottom: 0;[^}]*overflow: hidden/.test(fixedHtml))
check('a negative gap becomes a margin',
  /\.stack > \* \+ \* \{\s*margin-top: -4px/.test(fixedHtml) &&
  /\.stack \{[^}]*gap: 0/.test(fixedHtml))

const typo = await body('POST', '/extract', { nodeId: '3:1', format: 'html' })
check('a lone font name gets a generic fallback',
  typo.data.html.includes('font-family: Inter, sans-serif'),
  (typo.data.html.match(/font-family:[^;]+;/) || ['none'])[0])
check('and the face itself is requested',
  typo.data.html.includes('fonts.googleapis.com/css2?family=Inter:wght@500'))

// ---------------------------------------------------------------- pngData

const inline = await body('POST', '/extract', { nodeId: '3:1', format: ['png', 'pngData'] })
check('pngData inlines the image', inline.data.pngData?.dataUri?.startsWith('data:image/png;base64,'))
check('and reports its size and scale',
  inline.data.pngData.bytes === 4 && inline.data.pngData.scale === 2)
check('while png stays a URL alongside it', inline.data.png?.url?.includes('/assets/'))
const onlyData = await body('POST', '/extract', { nodeId: '3:1', format: 'pngData' })
check('asking only for the data URI drops the URL',
  onlyData.data.pngData !== undefined && onlyData.data.png === undefined)

const batch = await body('POST', '/extract', { nodeIds: ['3:1'], format: 'tsx' })
check('a batch honours the format too',
  batch.data.results?.[0]?.extraction?.figmaCss === undefined &&
  typeof batch.data.results?.[0]?.extraction?.tsx === 'string')

plugin.stop()
const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
