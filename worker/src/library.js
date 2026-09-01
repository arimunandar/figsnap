// The saved set, kept for an account so it follows them between devices.
//
// One Durable Object per account — `getByName(account.room)` — so a set is
// reachable only through a token for that account, the same boundary the rooms
// use. Inside, one row per Figma file.
//
// This is the one thing the relay does keep. It is deliberately narrow: node
// ids, layer names, types and folder names. No image, no CSS, no geometry, and
// nothing that would let this database reconstruct any part of a design.

import { DurableObject } from 'cloudflare:workers'

// A curated set, not a database: the caps mirror the plugin's own.
const MAX_ENTRIES = 100
const MAX_FOLDERS = 30
const MAX_FILES = 200

function clean(entries) {
  if (!Array.isArray(entries)) return []
  return entries
    .filter((entry) => entry && typeof entry.id === 'string')
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 200) : entry.id,
      type: typeof entry.type === 'string' ? entry.type.slice(0, 40) : 'FRAME',
      addedAt: Number.isFinite(entry.addedAt) ? entry.addedAt : Date.now(),
      folder: typeof entry.folder === 'string' ? entry.folder.slice(0, 40) : '',
    }))
}

function cleanFolders(folders) {
  if (!Array.isArray(folders)) return []
  return folders
    .filter((name) => typeof name === 'string' && name !== '')
    .map((name) => name.slice(0, 40))
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, MAX_FOLDERS)
}

export class Library extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS sets (
          file_id TEXT PRIMARY KEY,
          folders TEXT NOT NULL,
          entries TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
    })
  }

  /** What this account has for one file, or an empty set it has never seen. */
  async read(fileId) {
    const row = this.ctx.storage.sql
      .exec('SELECT folders, entries, updated_at FROM sets WHERE file_id = ?', String(fileId))
      .toArray()[0]
    if (!row) return { folders: [], entries: [], updatedAt: 0, known: false }
    return {
      folders: JSON.parse(row.folders),
      entries: JSON.parse(row.entries),
      updatedAt: row.updated_at,
      known: true,
    }
  }

  /**
   * Last write wins, and the caller's own clock decides it: two devices editing
   * the same set is rare enough that merging entry by entry would cost more in
   * surprise than it saves. A write older than what is stored is refused rather
   * than silently dropped, so the caller knows to pull first.
   */
  async write(fileId, folders, entries, updatedAt) {
    const stamp = Number.isFinite(updatedAt) ? updatedAt : Date.now()
    const current = await this.read(fileId)
    if (current.known && current.updatedAt > stamp) {
      return { stored: false, ...current }
    }

    const count = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM sets').toArray()[0].n
    if (!current.known && count >= MAX_FILES) {
      throw new Error(`This account already has saved sets for ${MAX_FILES} files.`)
    }

    const kept = { folders: cleanFolders(folders), entries: clean(entries) }
    this.ctx.storage.sql.exec(
      'INSERT INTO sets (file_id, folders, entries, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(file_id) DO UPDATE SET folders = excluded.folders, ' +
        'entries = excluded.entries, updated_at = excluded.updated_at',
      String(fileId),
      JSON.stringify(kept.folders),
      JSON.stringify(kept.entries),
      stamp,
    )
    return { stored: true, ...kept, updatedAt: stamp, known: true }
  }

  async forget(fileId) {
    this.ctx.storage.sql.exec('DELETE FROM sets WHERE file_id = ?', String(fileId))
    return { forgotten: true }
  }

  /** Every file this account has a set for, for a person auditing what is held. */
  async files() {
    return this.ctx.storage.sql
      .exec('SELECT file_id, updated_at, json_array_length(entries) AS entries FROM sets ORDER BY updated_at DESC')
      .toArray()
      .map((row) => ({ fileId: row.file_id, entries: row.entries, updatedAt: row.updated_at }))
  }
}
