// Folders in the Saved set, against the real plugin code.
//
// dist/code.js is the shipped main thread, run here behind a real relay — see
// test/support/plugin.mjs. So the store, the migration and the HTTP routes are
// all the real ones; only Figma itself is faked.

import { startPlugin, makeNode } from './support/plugin.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const alpha = makeNode('1:1', 'Alpha')
const beta = makeNode('1:2', 'Beta')
const gamma = makeNode('1:3', 'Gamma')

const plugin = await startPlugin({ label: 'folders', pageChildren: [alpha, beta, gamma] })
const { figma, storage, get, body, toMain } = plugin

const countIn = (folders, name) => folders.find((folder) => folder.name === name)?.count

// ---------------------------------------------------------------- folders

const empty = await get('/folders')
check('a fresh set has only the root', empty.folders.length === 1 && empty.folders[0].name === '')

const created = await body('POST', '/folders', { name: 'Checkout' })
check('creates a folder', created.data.folders.some((folder) => folder.name === 'Checkout'))
check('a new folder starts empty', countIn(created.data.folders, 'Checkout') === 0)

const again = await body('POST', '/folders', { name: 'checkout' })
check('creating one that exists is not an error, and does not double up',
  again.status === 200 && again.data.folders.filter((f) => f.name.toLowerCase() === 'checkout').length === 1)

const slashed = await body('POST', '/folders', { name: 'a/b' })
check('a slash is refused, since folders do not nest', slashed.status === 400, slashed.data.error)

// ------------------------------------------------------------- saving in

figma.currentPage.selection = [alpha, beta]
const saved = await body('POST', '/saved', { selection: true, folder: 'Checkout' })
check('saves straight into a folder', saved.data.added === 2 && countIn(saved.data.folders, 'Checkout') === 2)
check('entries carry their folder', saved.data.entries.every((entry) => entry.folder === 'Checkout'))

figma.currentPage.selection = [gamma]
await body('POST', '/saved', { selection: true })
const all = await get('/saved')
check('the root holds what was saved without a folder', countIn(all.folders, '') === 1)
check('the listing carries both', all.entries.length === 3)

const scoped = await get('/saved?folder=Checkout')
check('a folder can be listed on its own', scoped.entries.length === 2, `${scoped.entries.length} entries`)
check('and the listing still names every folder', scoped.folders.length === 2)

const rootOnly = await get('/saved?folder=')
check('the root can be listed on its own', rootOnly.entries.length === 1 && rootOnly.entries[0].id === '1:3')

// -------------------------------------------------------------- moving

const moved = await body('POST', '/saved/move', { nodeIds: ['1:1'], folder: '' })
check('moves an entry back to the root', moved.data.moved === 1 && countIn(moved.data.folders, '') === 2)
const movedBack = await body('POST', '/saved/move', { nodeIds: ['1:1'], folder: 'Checkout' })
check('and into a folder again', movedBack.data.moved === 1 && countIn(movedBack.data.folders, 'Checkout') === 2)
const nowhere = await body('POST', '/saved/move', { nodeIds: ['1:1'], folder: 'Nope' })
check('moving into a folder that does not exist is refused', nowhere.status === 400, nowhere.data.error)

// Re-saving something already saved moves it rather than duplicating it.
figma.currentPage.selection = [alpha]
const resaved = await body('POST', '/saved', { selection: true, folder: '' })
check('re-saving moves rather than duplicates',
  resaved.data.added === 0 && resaved.data.entries.filter((e) => e.id === '1:1').length === 1 &&
  resaved.data.entries.find((e) => e.id === '1:1').folder === '')
await body('POST', '/saved/move', { nodeIds: ['1:1'], folder: 'Checkout' })

// -------------------------------------------------------------- renaming

const renamed = await body('POST', '/folders', { from: 'Checkout', to: 'Checkout v2' })
check('renames a folder', renamed.data.name === 'Checkout v2')
const afterRename = await get('/saved')
check('its entries follow the new name',
  afterRename.entries.filter((entry) => entry.folder === 'Checkout v2').length === 2)

// ------------------------------------------------------- extracting a folder

const emptyFolder = await body('POST', '/folders', { name: 'Empty' })
check('an empty folder can exist', countIn(emptyFolder.data.folders, 'Empty') === 0)
const nothingThere = await body('POST', '/extract', { saved: true, folder: 'Empty' })
check('extracting an empty folder says which one', nothingThere.data.error === 'Nothing saved in Empty.', nothingThere.data.error)

// ------------------------------------------------------------- emptying

const emptied = await body('DELETE', '/saved', { folder: 'Checkout v2' })
check('emptying a folder removes its entries', emptied.data.removed === 2)
check('but keeps the folder', emptied.data.folders.some((folder) => folder.name === 'Checkout v2'))

// -------------------------------------------------------------- deleting

figma.currentPage.selection = [alpha, beta]
await body('POST', '/saved', { selection: true, folder: 'Checkout v2' })
const deleted = await body('DELETE', '/folders', { name: 'Checkout v2' })
check('deleting a folder reports what was in it', deleted.data.affected === 2)
check('and the folder is gone', !deleted.data.folders.some((folder) => folder.name === 'Checkout v2'))
check('while its entries survive at the root', countIn(deleted.data.folders, '') === 3)

await body('POST', '/folders', { name: 'Doomed' })
await body('POST', '/saved/move', { nodeIds: ['1:1'], folder: 'Doomed' })
const purged = await body('DELETE', '/folders', { name: 'Doomed', deleteEntries: true })
check('deleteEntries takes them with it',
  purged.data.entries.every((entry) => entry.id !== '1:1'), `${purged.data.entries.length} left`)

// -------------------------------------------------------------- migration

// What an older version wrote: a bare array with no folder on any entry.
storage.set('saved:doc-1', [
  { id: '1:1', name: 'Alpha', type: 'FRAME', addedAt: 1 },
  { id: '1:2', name: 'Beta', type: 'FRAME', addedAt: 2 },
])
toMain({ type: 'ready' })
await new Promise((resolve) => setTimeout(resolve, 400))
const migrated = await get('/saved')
check('an old flat set still loads', migrated.entries.length === 2)
check('and lands at the root', migrated.entries.every((entry) => entry.folder === ''))
check('with no folders invented', migrated.folders.length === 1)

// Writing once puts it in the new shape.
figma.currentPage.selection = [gamma]
await body('POST', '/saved', { selection: true })
const written = storage.get('saved:doc-1')
check('the next write is in the new shape',
  !Array.isArray(written) && Array.isArray(written.entries) && Array.isArray(written.folders))

plugin.stop()
const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
