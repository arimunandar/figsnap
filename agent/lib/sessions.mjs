// What was said before, so it can be picked up again.
//
// ACP already has `session/list`, and where a harness supports it that answer
// is the better one — it knows its own titles and when each was last touched.
// But it only knows its own: a list from Claude Code says nothing about the
// Codex session from yesterday, and neither says which directory the panel
// should relaunch in. So this file keeps the part that spans harnesses, and the
// two are merged when the panel asks.
//
// A flat JSON file rather than anything cleverer. It holds ids and titles, not
// conversations — the transcript lives with the harness, and replaying it is
// what `session/load` is for.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const FILE = join(homedir(), '.figsnap', 'sessions.json')

// Enough to find last week's conversation, few enough that the file stays a
// file. A session that falls off the end is forgotten here, not deleted from
// the harness that owns it.
const KEEP = 50

/** A title is the first thing that was asked, which is what people remember. */
function titleFrom(text) {
  const line = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (line === '') return 'Untitled'
  return line.length > 72 ? `${line.slice(0, 71)}…` : line
}

export function createSessionStore({ log }) {
  /** @type {Array<Record<string, unknown>>} */
  let records = []
  let loaded = false

  async function load() {
    if (loaded) return records
    loaded = true
    const raw = await readFile(FILE, 'utf8').catch(() => null)
    if (raw === null) return records
    try {
      const parsed = JSON.parse(raw)
      records = Array.isArray(parsed?.sessions) ? parsed.sessions.filter((entry) => entry && entry.id) : []
      // Titles written before they were trimmed, or by a harness that hands
      // back the whole first message, are cut down on the way in.
      for (const entry of records) {
        if (typeof entry.title === 'string') entry.title = titleFrom(entry.title)
      }
    } catch {
      // A file this process wrote and cannot read is not worth failing over.
      log('sessions.json is unreadable; starting a fresh list')
    }
    return records
  }

  async function save() {
    records = records.slice(0, KEEP)
    await mkdir(dirname(FILE), { recursive: true }).catch(() => {})
    await writeFile(FILE, JSON.stringify({ sessions: records }, null, 2)).catch((error) => {
      log(`could not write sessions.json: ${error.message}`)
    })
  }

  /** Newest first, which is the order anyone looks for a conversation in. */
  function order() {
    return [...records].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  return {
    async all() {
      await load()
      return order()
    },

    async find(id) {
      await load()
      return records.find((entry) => entry.id === id) ?? null
    },

    /** Called when a session opens, whether it is new or resumed. */
    async remember({ id, harness, harnessName, cwd, file }) {
      await load()
      const now = Date.now()
      const existing = records.find((entry) => entry.id === id)
      if (existing !== undefined) {
        existing.harness = harness
        existing.harnessName = harnessName
        existing.cwd = cwd
        existing.updatedAt = now
        if (file) existing.file = file
      } else {
        records.unshift({
          id,
          harness,
          harnessName,
          cwd,
          file: file ?? null,
          title: null,
          createdAt: now,
          updatedAt: now,
        })
      }
      await save()
      return order()
    },

    /**
     * The first question becomes the title. Later ones only move it up the
     * list: renaming a conversation every time somebody says "and now this"
     * would make it unfindable.
     */
    async touch(id, prompt) {
      await load()
      const entry = records.find((record) => record.id === id)
      if (entry === undefined) return order()
      entry.updatedAt = Date.now()
      if (entry.title === null || entry.title === undefined) entry.title = titleFrom(prompt)
      await save()
      return order()
    },

    async forget(id) {
      await load()
      records = records.filter((entry) => entry.id !== id)
      await save()
      return order()
    },

    /**
     * Folds in what the harness itself knows. It is authoritative on title and
     * on when a session was last touched — the panel is not the only way to
     * reach it — but it has no idea a session belongs to one harness rather
     * than another, so the local record stays the spine.
     */
    async merge(harnessId, listed) {
      await load()
      let changed = false
      for (const info of listed) {
        const entry = records.find((record) => record.id === info.sessionId)
        if (entry === undefined) continue
        // Trimmed the same way a local one is. Codex hands back the whole first
        // message as the title, context block and all, which is not a title.
        const title = info.title === undefined || info.title === null ? '' : titleFrom(info.title)
        if (title !== '' && title !== 'Untitled' && title !== entry.title) {
          entry.title = title
          changed = true
        }
        const when = info.updatedAt === undefined || info.updatedAt === null ? null : Date.parse(info.updatedAt)
        if (when !== null && Number.isFinite(when) && when > (entry.updatedAt ?? 0)) {
          entry.updatedAt = when
          changed = true
        }
        if (entry.harness !== harnessId) continue
      }
      if (changed) await save()
      return order()
    },
  }
}
