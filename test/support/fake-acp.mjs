#!/usr/bin/env node
// A coding agent that does exactly what it is told and nothing else.
//
// The real harnesses are three hundred megabytes of npm, a login and a model
// behind them, which makes them the wrong thing to test a bridge against: the
// question here is whether the daemon is a correct ACP client and whether a
// tool call reaches Figma, not whether Claude can reason. So this speaks the
// protocol over stdio and answers on a script keyed off the prompt text.
//
// It is a real client of the MCP server the daemon hands it, though. That part
// is not faked, because it is the part being proved: `figma_get_selection` here
// goes out over stdio, into the daemon's HTTP, down the panel's WebSocket and
// back, which is the whole chain the feature rests on.
//
// Spawned by the daemon through FIGSNAP_AGENT_COMMAND.

import { createInterface } from 'node:readline'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let mcpServers = []
let mcp = null
let cancelled = false

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function notify(method, params) {
  write({ jsonrpc: '2.0', method, params })
}

let nextId = 1000
const waiting = new Map()

/** A request from this side back to the client, which is the daemon. */
function ask(method, params) {
  const id = nextId++
  return new Promise((settle, fail) => {
    waiting.set(id, { settle, fail })
    write({ jsonrpc: '2.0', id, method, params })
  })
}

function update(sessionId, body) {
  notify('session/update', { sessionId, update: body })
}

function text(sessionId, kind, value) {
  update(sessionId, { sessionUpdate: kind, content: { type: 'text', text: value } })
}

/** Connects to whichever MCP server the daemon named at session/new. */
async function mcpClient() {
  if (mcp !== null) return mcp
  const server = mcpServers.find((entry) => entry.name === 'figsnap')
  if (server === undefined) throw new Error('the daemon named no figsnap MCP server')
  const client = new Client({ name: 'fake-acp', version: '1.0.0' }, { capabilities: {} })
  await client.connect(
    new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: {
        ...process.env,
        ...Object.fromEntries((server.env ?? []).map((variable) => [variable.name, variable.value])),
      },
    }),
  )
  mcp = client
  return client
}

async function callTool(sessionId, name, args) {
  const client = await mcpClient()
  const toolCallId = `call-${name}`
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: name, status: 'in_progress' })
  const result = await client.callTool({ name, arguments: args })
  update(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId,
    status: result.isError ? 'failed' : 'completed',
  })
  const first = result.content?.[0]
  return first?.type === 'text' ? first.text : `[${first?.type ?? 'nothing'}]`
}

async function runPrompt(sessionId, prompt) {
  cancelled = false
  // Only the first block is what the designer typed; anything after it is
  // context the client attached, and matching keywords against that would have
  // this agent answering its own prompt.
  const said = prompt[0]?.text ?? ''
  const attached = prompt.slice(1).map((block) => block.text ?? '').join('\n')

  if (said.includes('context')) {
    text(sessionId, 'agent_message_chunk', attached === '' ? 'nothing attached' : attached)
  }

  text(sessionId, 'agent_thought_chunk', 'thinking about ')
  text(sessionId, 'agent_thought_chunk', 'the request')

  if (said.includes('tools')) {
    const client = await mcpClient()
    const listed = await client.listTools()
    text(sessionId, 'agent_message_chunk', listed.tools.map((tool) => tool.name).join(','))
  }

  if (said.includes('select')) {
    text(sessionId, 'agent_message_chunk', await callTool(sessionId, 'figma_get_selection', {}))
  }

  if (said.includes('edit')) {
    // Permission is asked of the client, which is the panel's prompt. A
    // refusal must leave the canvas alone, so the tool only runs on "selected".
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId: 'call-figma_set_fill', title: 'set the fill to #1e88e5' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    })
    if (answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'yes') {
      text(sessionId, 'agent_message_chunk', await callTool(sessionId, 'figma_set_fill', { nodeId: '1:2', color: '#1e88e5' }))
    } else {
      text(sessionId, 'agent_message_chunk', 'refused')
    }
  }

  if (said.includes('read')) {
    const file = await ask('fs/read_text_file', { sessionId, path: 'package.json' })
    text(sessionId, 'agent_message_chunk', `read ${file.content.length} bytes`)
  }

  if (said.includes('escape')) {
    // The daemon must refuse a path outside the session directory.
    try {
      await ask('fs/read_text_file', { sessionId, path: '../../../../etc/hosts' })
      text(sessionId, 'agent_message_chunk', 'escaped')
    } catch {
      text(sessionId, 'agent_message_chunk', 'refused the path')
    }
  }

  if (said.includes('run')) {
    const created = await ask('terminal/create', { sessionId, command: 'echo', args: ['from the terminal'] })
    await ask('terminal/wait_for_exit', { sessionId, terminalId: created.terminalId })
    const out = await ask('terminal/output', { sessionId, terminalId: created.terminalId })
    await ask('terminal/release', { sessionId, terminalId: created.terminalId })
    text(sessionId, 'agent_message_chunk', out.output.trim())
  }

  if (said.includes('wait')) {
    // Long enough for the suite to cancel it, and no longer.
    for (let tick = 0; tick < 100 && !cancelled; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return { stopReason: cancelled ? 'cancelled' : 'end_turn' }
  }

  return { stopReason: 'end_turn' }
}

const rl = createInterface({ input: process.stdin })

rl.on('line', async (line) => {
  if (line.trim() === '') return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  // An answer to something this side asked the daemon.
  if (message.id !== undefined && message.method === undefined) {
    const entry = waiting.get(message.id)
    if (entry === undefined) return
    waiting.delete(message.id)
    if (message.error !== undefined) entry.fail(new Error(message.error.message ?? 'failed'))
    else entry.settle(message.result)
    return
  }

  if (message.method === 'session/cancel') {
    cancelled = true
    return
  }

  const reply = (result) => write({ jsonrpc: '2.0', id: message.id, result })

  try {
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: message.params.protocolVersion,
          agentCapabilities: { loadSession: true, promptCapabilities: {} },
          agentInfo: { name: 'fake-acp', version: '1.0.0' },
        })
        break

      case 'session/new':
        mcpServers = message.params.mcpServers ?? []
        reply({ sessionId: 'fake-session-1' })
        break

      case 'session/load':
        mcpServers = message.params.mcpServers ?? []
        reply({})
        // Loading replays the conversation, which is what makes a torn-down
        // panel look like it never went away.
        text(message.params.sessionId, 'user_message_chunk', 'what is selected')
        text(message.params.sessionId, 'agent_message_chunk', 'replayed')
        break

      case 'session/prompt':
        reply(await runPrompt(message.params.sessionId, message.params.prompt ?? []))
        break

      default:
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no ${message.method}` } })
    }
  } catch (error) {
    if (message.id !== undefined) {
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error?.message ?? error) } })
    }
  }
})
