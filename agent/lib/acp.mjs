// The ACP client: this daemon's conversation with a coding agent.
//
// ACP's only blessed transport is stdio, and the client is the side that
// launches the agent as a subprocess. A browser can do neither, which is the
// whole reason this process exists. It is also why the client, not the panel,
// answers `fs/*` and `terminal/*`: an agent asks those of whoever it is talking
// to, and a plugin iframe has no filesystem and no shell.
//
// So the split is: the harness reasons, this file gives it a machine, the MCP
// server gives it hands in Figma, and the panel is the face the designer sees.

import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import * as acp from '@agentclientprotocol/sdk'

const PERMISSION_TIMEOUT_MS = 5 * 60_000
const TERMINAL_OUTPUT_LIMIT = 1_000_000

/**
 * Keeps a path inside the directory the session was opened on. The agent picks
 * the paths, and the designer picked the directory; without this the first is
 * free to leave the second.
 */
function within(root, path) {
  const full = isAbsolute(path) ? resolve(path) : resolve(root, path)
  const step = relative(root, full)
  if (step === '' || (!step.startsWith('..') && !isAbsolute(step))) return full
  throw new Error(`Outside the session directory: ${path}`)
}

export function createRunner({ plugin, log, emit, mcpServers, sessions, allowEdits = false }) {
  let child = null
  let connection = null
  let sessionId = null
  let harness = null
  let cwd = process.cwd()
  let turn = null
  // What the harness said it could do at initialize, and where the session
  // currently stands. Both are ACP's own answers rather than guesses: prompt
  // capabilities decide whether a picture of the design is worth attaching, and
  // modes are the harness's own idea of how much it may do unattended.
  let capabilities = {}
  let modes = null
  let commands = []
  // What the Figma side of a session was about, so the history can say which
  // file a conversation belonged to rather than only which folder.
  let file = null
  // Writes are a switch the designer holds, not a prompt the agent can talk
  // past: a harness told to skip permissions would otherwise reach the canvas
  // unannounced. See `mutates` in lib/tools.mjs.
  //
  // `figsnap-agent --allow-edits` seeds it on. That is not a loophole: it is the
  // same deliberate human act, performed at the terminal by the person who is
  // working there, rather than requiring a trip into Figma to tick a box before
  // an MCP client can write. The daemon owns this value either way — the panel
  // adopts what the `state` frame tells it rather than pushing its own back.
  let writes = allowEdits === true
  // Answering every permission by hand turns a five-step change into five
  // interruptions, so the asking can be delegated. It is not the same as
  // removing the gate: `writes` still decides whether the canvas is reachable
  // at all, every approval is still announced in the transcript, and every edit
  // is still one Cmd-Z.
  let auto = false

  const permissions = new Map()
  const terminals = new Map()

  function notice(level, text) {
    log(`${level}: ${text}`)
    emit({ kind: 'notice', level, text })
  }

  function state() {
    return {
      harness: harness === null ? null : { id: harness.id, name: harness.name },
      sessionId,
      cwd,
      running: turn !== null,
      writes,
      auto,
      // A harness that cannot take an image should not be sent one, and the
      // panel is the side that would have to render it.
      acceptsImages: capabilities.promptCapabilities?.image === true,
      // Anything that is not an image rides as an embedded resource, which is
      // its own capability: a harness that cannot take one should be told to
      // its face rather than handed a block it will drop.
      acceptsFiles: capabilities.promptCapabilities?.embeddedContext === true,
      modes,
      commands,
      connected: connection !== null,
    }
  }

  function announce() {
    emit({ kind: 'state', ...state() })
  }

  // ----------------------------------------------------------- permissions

  /**
   * The designer decides. A harness asks before a tool it considers sensitive,
   * and that question is the one the panel renders — unanswered for five
   * minutes it is treated as a refusal, because a prompt nobody is looking at
   * should not hold the agent open forever.
   */
  function requestPermission(params) {
    const id = randomUUID()
    const cancelled = { outcome: { outcome: 'cancelled' } }

    if (auto) {
      // The narrowest yes on offer. `allow_always` would hand the harness a
      // standing permission this daemon can no longer see or revoke; answering
      // once, every time, keeps the decision here.
      const yes =
        (params.options ?? []).find((option) => option.kind === 'allow_once') ??
        (params.options ?? []).find((option) => option.kind === 'allow_always')
      if (yes === undefined) return Promise.resolve(cancelled)
      notice('auto', `Allowed automatically: ${params.toolCall?.title ?? 'an action'}`)
      return Promise.resolve({ outcome: { outcome: 'selected', optionId: yes.optionId } })
    }

    return new Promise((settle) => {
      if (!plugin.connected()) {
        settle(cancelled)
        return
      }
      const timer = setTimeout(() => {
        permissions.delete(id)
        notice('warn', 'A permission request went unanswered for five minutes and was refused.')
        settle(cancelled)
      }, PERMISSION_TIMEOUT_MS)

      permissions.set(id, (optionId) => {
        clearTimeout(timer)
        permissions.delete(id)
        settle(
          optionId === null || optionId === undefined
            ? cancelled
            : { outcome: { outcome: 'selected', optionId } },
        )
      })

      emit({
        kind: 'permission',
        id,
        sessionId: params.sessionId,
        toolCall: params.toolCall,
        options: params.options,
      })
    })
  }

  function answerPermission(id, optionId) {
    const waiting = permissions.get(id)
    if (waiting === undefined) return false
    waiting(optionId ?? null)
    return true
  }

  function refuseAllPermissions(why) {
    for (const [id, waiting] of Array.from(permissions.entries())) {
      permissions.delete(id)
      log(`permission ${id} refused: ${why}`)
      waiting(null)
    }
  }

  // ------------------------------------------------------------- terminals

  async function createTerminal(params) {
    const id = randomUUID()
    const limit = params.outputByteLimit ?? TERMINAL_OUTPUT_LIMIT
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ? within(cwd, params.cwd) : cwd,
      env: { ...process.env, ...Object.fromEntries((params.env ?? []).map((v) => [v.name, v.value])) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const entry = { proc, output: '', truncated: false, exitStatus: null, waiters: [] }
    terminals.set(id, entry)

    const absorb = (chunk) => {
      entry.output += chunk.toString()
      if (entry.output.length > limit) {
        // Keeping the tail rather than the head: the end of a build log is
        // where the error is.
        entry.output = entry.output.slice(entry.output.length - limit)
        entry.truncated = true
      }
    }
    proc.stdout.on('data', absorb)
    proc.stderr.on('data', absorb)

    const finish = (exitCode, signal) => {
      if (entry.exitStatus !== null) return
      entry.exitStatus = { exitCode: exitCode ?? null, signal: signal ?? null }
      for (const waiter of entry.waiters) waiter(entry.exitStatus)
      entry.waiters = []
    }
    proc.on('exit', finish)
    proc.on('error', (error) => {
      absorb(Buffer.from(`${error.message}\n`))
      finish(null, null)
    })

    return { terminalId: id }
  }

  function terminal(params) {
    const entry = terminals.get(params.terminalId)
    if (entry === undefined) throw new Error(`No such terminal: ${params.terminalId}`)
    return entry
  }

  /**
   * What a terminal has printed so far.
   *
   * A tool call can carry `{type: 'terminal', terminalId}`, which is a pointer
   * rather than content: only the client can resolve it, because the client is
   * the side that owns the terminal. So the pointer is resolved here, on the
   * way past, and the panel gets something it can actually render.
   */
  function terminalSnapshot(terminalId) {
    const entry = terminals.get(terminalId)
    if (entry === undefined) return null
    const tail = entry.output.length > 4000 ? entry.output.slice(entry.output.length - 4000) : entry.output
    return { output: tail, truncated: entry.truncated || tail !== entry.output, exitStatus: entry.exitStatus }
  }

  function resolveTerminals(update) {
    const content = update?.content
    if (!Array.isArray(content)) return update
    return {
      ...update,
      content: content.map((block) =>
        block?.type === 'terminal'
          ? { ...block, _figsnap: terminalSnapshot(block.terminalId) }
          : block,
      ),
    }
  }

  function killEveryTerminal() {
    for (const entry of terminals.values()) entry.proc.kill('SIGTERM')
    terminals.clear()
  }

  // --------------------------------------------------------------- session

  function handlers() {
    return acp
      .client({ name: 'figsnap' })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const update = ctx.params.update
        // Modes and commands are session state, not transcript: they change what
        // the panel offers, so they are tracked here rather than only drawn once.
        if (update?.sessionUpdate === 'current_mode_update' && modes !== null) {
          modes = { ...modes, currentModeId: update.currentModeId }
          announce()
        }
        if (update?.sessionUpdate === 'available_commands_update') {
          commands = update.availableCommands ?? []
          announce()
        }
        emit({ kind: 'update', sessionId: ctx.params.sessionId, update: resolveTerminals(update) })
      })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => requestPermission(ctx.params))
      .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
        const content = await readFile(within(cwd, ctx.params.path), 'utf8')
        // `line` is 1-based and `limit` counts lines, not bytes.
        if (ctx.params.line === undefined || ctx.params.line === null) return { content }
        const lines = content.split('\n')
        const from = Math.max(0, ctx.params.line - 1)
        const to = ctx.params.limit ? from + ctx.params.limit : lines.length
        return { content: lines.slice(from, to).join('\n') }
      })
      .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
        const path = within(cwd, ctx.params.path)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, ctx.params.content, 'utf8')
        return {}
      })
      .onRequest(acp.methods.client.terminal.create, (ctx) => createTerminal(ctx.params))
      .onRequest(acp.methods.client.terminal.output, (ctx) => {
        const entry = terminal(ctx.params)
        return { output: entry.output, truncated: entry.truncated, exitStatus: entry.exitStatus }
      })
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) => {
        const entry = terminal(ctx.params)
        if (entry.exitStatus !== null) return entry.exitStatus
        return new Promise((settle) => entry.waiters.push(settle))
      })
      .onRequest(acp.methods.client.terminal.kill, (ctx) => {
        terminal(ctx.params).proc.kill('SIGTERM')
        return {}
      })
      .onRequest(acp.methods.client.terminal.release, (ctx) => {
        const entry = terminal(ctx.params)
        entry.proc.kill('SIGTERM')
        terminals.delete(ctx.params.terminalId)
        return {}
      })
  }

  async function stop(reason = 'stopped') {
    refuseAllPermissions(reason)
    killEveryTerminal()
    turn = null
    sessionId = null
    if (connection !== null) {
      try {
        connection.close()
      } catch {
        // Already closed, which is the state we wanted.
      }
      connection = null
    }
    if (child !== null) {
      child.kill('SIGTERM')
      child = null
    }
    harness = null
    announce()
    // Ending a session changes the history — the one that was running is no
    // longer the current one — and the panel has no other way to learn that.
    void publishSessions()
  }

  /**
   * Launches a harness and opens a session on it. A `resume` id is tried first
   * and only when the agent says it can load sessions; if that fails the
   * conversation is started fresh rather than reported as broken, because the
   * panel's stored id outlives the agent that issued it.
   */
  /**
   * The history the panel shows: what this daemon has opened, plus whatever the
   * harness itself remembers where it supports being asked.
   */
  async function publishSessions() {
    let list = await sessions.all()
    if (connection !== null && capabilities.sessionCapabilities?.list) {
      try {
        const answer = await connection.agent.request(acp.methods.agent.session.list, {})
        list = await sessions.merge(harness?.id ?? '', answer?.sessions ?? [])
      } catch (error) {
        log(`the harness would not list its sessions: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    emit({ kind: 'sessions', sessions: list })
  }

  async function forgetSession(id) {
    // Dropped from the harness too where it will take the instruction; a list
    // that keeps offering a conversation the harness has thrown away is worse
    // than no list.
    if (connection !== null && capabilities.sessionCapabilities?.delete) {
      try {
        await connection.agent.request(acp.methods.agent.session.delete, { sessionId: id })
      } catch (error) {
        log(`the harness would not delete ${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    emit({ kind: 'sessions', sessions: await sessions.forget(id) })
  }

  async function start({ harness: next, cwd: directory, resume, file: openFile }) {
    await stop('replaced by a new session')
    harness = next
    cwd = resolve(directory)
    if (openFile !== undefined && openFile !== null) file = openFile

    const command = process.platform === 'win32' && next.command === 'npx' ? 'npx.cmd' : next.command
    log(`launching ${next.name}: ${command} ${next.args.join(' ')}`)
    // A registry row may carry its own environment — an alternative endpoint and
    // its key — read now rather than at import, so a variable exported after the
    // daemon started still counts.
    const spawned = spawn(command, next.args, {
      cwd,
      env: { ...process.env, ...(next.env?.() ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child = spawned

    // Compared by identity, not against null: a harness being replaced exits
    // after its successor has already been spawned, and a stale exit event must
    // not tear down the session that took its place.
    spawned.on('error', (error) => {
      if (child !== spawned) return
      notice('error', `${next.name} would not start: ${error.message}`)
      void stop('failed to start')
    })
    spawned.stderr.on('data', (chunk) => {
      if (child !== spawned) return
      const text = chunk.toString().trim()
      if (text !== '') emit({ kind: 'notice', level: 'harness', text })
    })
    spawned.on('exit', (code, signal) => {
      if (child !== spawned) return
      notice('error', `${next.name} exited (${signal ?? `code ${code}`}).`)
      void stop('the harness exited')
    })

    const stream = acp.ndJsonStream(Writable.toWeb(spawned.stdin), Readable.toWeb(spawned.stdout))
    connection = handlers().connect(stream)

    // The first launch of a harness is an npm download of a few hundred
    // megabytes and can run for minutes. Silence that long reads as a hang, so
    // it is named rather than waited out.
    const slow = setTimeout(() => {
      notice('info', `${next.name} is still starting. A first run downloads the adapter, which can take a few minutes.`)
    }, 15_000)

    let initialised
    try {
      initialised = await connection.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
        clientInfo: { name: 'figsnap', version: '0.1.0' },
      })
    } finally {
      clearTimeout(slow)
    }

    capabilities = initialised.agentCapabilities ?? {}
    modes = null
    commands = []

    const canLoad = capabilities.loadSession === true
    if (resume && canLoad) {
      try {
        const reloaded = await connection.agent.request(acp.methods.agent.session.load, {
          sessionId: resume,
          cwd,
          mcpServers,
        })
        modes = reloaded?.modes ?? null
        sessionId = resume
        await sessions.remember({ id: resume, harness: next.id, harnessName: next.name, cwd, file })
        log(`resumed session ${resume}`)
        announce()
        return state()
      } catch (error) {
        // An id from a previous run of a different harness, most likely.
        log(`could not resume ${resume}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    let opened
    try {
      opened = await connection.agent.request(acp.methods.agent.session.new, { cwd, mcpServers })
    } catch (error) {
      // ACP has one named failure here worth translating: the harness has no
      // login. Nothing this daemon can do about it — the fix is in a terminal —
      // so say which harness and what to run rather than showing a raw code.
      const methods = initialised.authMethods ?? []
      if (String(error?.message ?? '').includes('auth') || error?.code === -32000) {
        const names = methods.map((method) => method.name ?? method.id).join(', ')
        throw new Error(
          `${next.name} is not signed in. Run \`${next.cli}\` once in a terminal and complete its login` +
            `${names === '' ? '' : ` (${names})`}, then start the session again.`,
        )
      }
      throw error
    }
    modes = opened.modes ?? null
    sessionId = opened.sessionId
    await sessions.remember({ id: sessionId, harness: next.id, harnessName: next.name, cwd, file })
    log(`session ${sessionId} on ${next.name}`)
    announce()
    void publishSessions()
    return state()
  }

  /**
   * What the designer is pointing at, as a block the agent can act on.
   *
   * A designer saying "make this match our button" is pointing at the canvas,
   * and an agent that has to guess either guesses wrong or spends a turn asking.
   * Only the identity travels — names, types, sizes, node ids — because the
   * design itself is a tool call away and a short question should not carry a
   * hundred kilobytes of CSS with it.
   */
  function selectionBlock(context) {
    const rows = Array.isArray(context?.rows) ? context.rows : []
    if (rows.length === 0) return null
    const listed = rows
      .map((row) => `- "${row.name}" — ${row.type}, ${Math.round(row.width)}x${Math.round(row.height)}, node id ${row.id}`)
      .join('\n')
    const where = context.page ? ` on page "${context.page}"` : ''
    const what = rows.length === 1 ? 'has this layer selected' : `has these ${rows.length} layers selected`
    return {
      type: 'text',
      text:
        `[Figma selection] The designer ${what}${where} right now:\n${listed}\n\n` +
        'When they say "this", "the selection", or name nothing at all, that is what they mean. ' +
        'Read it with figma_extract, or look at it with figma_export_png, before answering about its appearance.',
    }
  }

  async function prompt(text, context, attachments) {
    if (connection === null || sessionId === null) throw new Error('No session. Pick a harness first.')
    if (turn !== null) throw new Error('The agent is still answering. Cancel it or wait.')

    // A separate block rather than a suffix on the question: it is context, not
    // something the designer said, and it should not read as part of the ask.
    const selection = selectionBlock(context)
    const blocks = [{ type: 'text', text }]
    if (selection !== null) blocks.push(selection)

    // And, where the harness can take one, the design itself. This is a design
    // tool: a model that can look at the frame answers questions about spacing
    // and colour that no amount of CSS in a text block would settle. Sent only
    // when `promptCapabilities.image` says it will be read rather than dropped.
    if (capabilities.promptCapabilities?.image === true) {
      for (const image of Array.isArray(context?.images) ? context.images.slice(0, 1) : []) {
        if (typeof image?.data !== 'string' || image.data === '') continue
        blocks.push({ type: 'image', data: image.data, mimeType: image.mimeType ?? 'image/png' })
      }
    }

    // Files the designer attached by hand. A picture goes as an image where the
    // harness reads images; everything else — a PDF, a spec, a font — goes as an
    // embedded resource, and is dropped with a word rather than silently when
    // the harness takes neither.
    const refused = []
    for (const file of Array.isArray(attachments) ? attachments : []) {
      if (typeof file?.data !== 'string' || file.data === '') continue
      const isImage = String(file.mimeType ?? '').startsWith('image/')
      if (isImage && capabilities.promptCapabilities?.image === true) {
        blocks.push({ type: 'image', data: file.data, mimeType: file.mimeType })
      } else if (capabilities.promptCapabilities?.embeddedContext === true) {
        blocks.push({
          type: 'resource',
          resource: { uri: `file://${file.name}`, mimeType: file.mimeType, blob: file.data },
        })
      } else {
        refused.push(file.name)
      }
    }
    if (refused.length > 0) {
      notice('warn', `${harness?.name ?? 'This harness'} cannot take attachments, so ${refused.join(', ')} was left out.`)
    }

    void sessions.touch(sessionId, text).then((list) => emit({ kind: 'sessions', sessions: list }))

    turn = { at: Date.now() }
    emit({ kind: 'turn', status: 'started' })
    // Announced rather than only signalled: the panel decides from this whether
    // the next message is sent or queued, and a `turn` frame is a transcript
    // event that a reconnecting panel would never see.
    announce()
    try {
      const answer = await connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: blocks,
      })
      emit({ kind: 'turn', status: 'ended', stopReason: answer.stopReason })
      return answer
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      emit({ kind: 'turn', status: 'ended', stopReason: 'error', error: message })
      throw error
    } finally {
      turn = null
      announce()
    }
  }

  async function cancel() {
    if (connection === null || sessionId === null) return
    // Cancelling is a notification: the prompt still settles, with
    // stopReason "cancelled", which is what ends the turn.
    try {
      await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId })
    } catch (error) {
      notice('warn', `Could not cancel: ${error instanceof Error ? error.message : String(error)}`)
    }
    refuseAllPermissions('the turn was cancelled')
  }

  return {
    start,
    stop,
    prompt,
    cancel,
    answerPermission,
    state,
    announce,
    publishSessions,
    forgetSession,
    setWrites(on) {
      writes = on === true
      announce()
    },
    setAuto(on) {
      auto = on === true
      announce()
    },
    /**
     * Switching the harness's own mode — plan, accept edits, and whatever else
     * it offers. This is ACP's answer to "how much may it do unattended", and it
     * is a better one than any switch invented here, because the harness is the
     * side that knows what its modes mean.
     */
    async setMode(modeId) {
      if (connection === null || sessionId === null) throw new Error('No session.')
      await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId })
      if (modes !== null) modes = { ...modes, currentModeId: modeId }
      announce()
    },
    writesAllowed() {
      return writes
    },
  }
}
