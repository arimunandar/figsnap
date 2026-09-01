// Which conversation a resume id belongs to.
//
// No relay and no Figma: this drives `createRunner` directly against
// `test/support/fake-acp.mjs`, because the whole question is what the daemon
// decides *before* it asks the harness anything.
//
// The reason it needs asserting at all is the DeepSeek row. Two registry rows
// now spawn the same `claude` CLI, whose own session store is keyed by id and
// directory alone — it has no idea which base URL or key was in the environment
// when an id was minted, so it will load a Claude Code conversation under
// DeepSeek without complaint and carry on talking to whichever endpoint is
// configured now. The old fallback — try `session/load` and start fresh if the
// harness refuses — cannot catch that, because nothing refuses.
//
// The fake harness has the same manners on purpose: its `session/load` accepts
// any id at all. So a daemon that offers a foreign id gets it accepted, and the
// only thing standing between a designer and somebody else's conversation is
// the daemon's own record of who minted what.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE = join(root, 'test/support/fake-acp.mjs')

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// The store reads $HOME at import, so the throwaway one has to be in place
// first: this suite must not touch the machine's real session history.
const HOME = await mkdtemp(join(tmpdir(), 'figsnap-resume-'))
process.env.HOME = HOME
process.env.USERPROFILE = HOME

const { createRunner } = await import('../agent/lib/acp.mjs')
const { createSessionStore } = await import('../agent/lib/sessions.mjs')

// Two rows, one binary — the shape the DeepSeek row introduced, and the shape
// the guard has to hold for.
const A = { id: 'harness-a', name: 'Harness A', cli: 'node', command: process.execPath, args: [FAKE] }
const B = { id: 'harness-b', name: 'Harness B', cli: 'node', command: process.execPath, args: [FAKE] }

const logs = []
let frames = []
const sessions = createSessionStore({ log: (line) => logs.push(line) })
const runner = createRunner({
  plugin: { connected: () => true },
  log: (line) => logs.push(line),
  emit: (frame) => frames.push(frame),
  mcpServers: [],
  sessions,
})

/**
 * A resume replays the conversation; a fresh session publishes its commands.
 * Those are the fake's two tells, and they are how this tells the paths apart
 * without trusting the log line it is also asserting.
 */
function spoken() {
  return frames
    .filter((frame) => frame.kind === 'update' && frame.update?.sessionUpdate === 'agent_message_chunk')
    .map((frame) => frame.update.content?.text ?? '')
    .join('')
}

const settled = () => new Promise((done) => setTimeout(done, 250))

// --------------------------------------------------------------- a session to own

frames = []
const first = await runner.start({ harness: A, cwd: root, resume: null, file: null })
check('a harness opens a session', first.sessionId === 'fake-session-1', String(first.sessionId))
check('and it is recorded against the harness that opened it',
  (await sessions.find('fake-session-1'))?.harness === 'harness-a',
  JSON.stringify(await sessions.find('fake-session-1')))

// ------------------------------------------------------- the same harness may resume

frames = []
const again = await runner.start({ harness: A, cwd: root, resume: 'fake-session-1', file: null })
await settled()
check('the harness that owns an id resumes it', again.sessionId === 'fake-session-1')
check('and the conversation is replayed', spoken() === 'replayed', spoken())

// ------------------------------------------------------ another harness may not

frames = []
logs.length = 0
const crossed = await runner.start({ harness: B, cwd: root, resume: 'fake-session-1', file: null })
await settled()

// The fake would have accepted the id — that is the point — so a replay here
// would mean the daemon handed one harness's conversation to another.
check('a foreign id is not replayed into a different harness', spoken() === '', spoken())
check('it says which harness the id belonged to',
  logs.some((line) => line.includes('not resuming') && line.includes('Harness A')),
  logs.filter((line) => line.includes('resum')).join(' | '))
check('and a session is still opened rather than the start failing',
  crossed.sessionId !== null && crossed.harness?.id === 'harness-b',
  JSON.stringify({ id: crossed.sessionId, harness: crossed.harness?.id }))
check('the record now belongs to the harness that reopened it',
  (await sessions.find('fake-session-1'))?.harness === 'harness-b')

// ------------------------------------------------- an id nobody has a record of

// A panel's stored id outlives the daemon's history, and the harness is the
// only one who can say whether it is loadable. That guess is left to it.
frames = []
logs.length = 0
const unknown = await runner.start({ harness: A, cwd: root, resume: 'never-recorded', file: null })
await settled()
check('an unrecorded id is still offered to the harness',
  spoken() === 'replayed' && unknown.sessionId === 'never-recorded',
  JSON.stringify({ spoken: spoken(), id: unknown.sessionId }))

await runner.stop('the suite is done')
await rm(HOME, { recursive: true, force: true })

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
