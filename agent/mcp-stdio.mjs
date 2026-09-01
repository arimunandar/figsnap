#!/usr/bin/env node
// figsnap-mcp — the Figma file the designer has open, as MCP tools.
//
// ACP gives a chat. MCP gives hands. Every tool here proxies to the daemon over
// loopback HTTP, which forwards it down the panel's WebSocket into `figma.*`.
//
// Two callers, one binary. The daemon spawns this for the harness it launched,
// passing the address and token in the environment. And anything else that
// speaks MCP can spawn it too — Claude Code in a terminal, an editor, a script —
// which is the point: the designs are wherever the designer is, not only inside
// the plugin's own chat.
//
//   claude mcp add figsnap -- npx figsnap-mcp
//
// Nothing needs configuring for that, because both defaults are knowable: the
// daemon listens on a fixed port and writes its token to a fixed file. Set
// FIGSNAP_AGENT_URL or FIGSNAP_AGENT_TOKEN to override either.
//
// stdio rather than HTTP on purpose: an ACP agent must be told it can take an
// HTTP MCP server (`mcpCapabilities.http`), and stdio is the variant every
// client has to support.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { toolManifest } from './lib/tools.mjs'

export const DEFAULT_AGENT_URL = 'http://127.0.0.1:3056'
export const TOKEN_FILE = join(homedir(), '.figsnap', 'agent-token')

const BASE = process.env.FIGSNAP_AGENT_URL ?? DEFAULT_AGENT_URL

/** The daemon's own token file, so a client on this machine needs no setup. */
async function resolveToken() {
  const fromEnv = process.env.FIGSNAP_AGENT_TOKEN
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
  const stored = await readFile(TOKEN_FILE, 'utf8').catch(() => null)
  return stored === null ? '' : stored.trim()
}

const TOKEN = await resolveToken()

const server = new Server(
  { name: 'figsnap', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolManifest() }))

/** Why a call could not even be attempted, in words the caller can act on. */
function unreachable(error) {
  const why = error instanceof Error ? error.message : String(error)
  const refused = why.includes('ECONNREFUSED') || why.includes('fetch failed')
  return refused
    ? `No Figsnap daemon at ${BASE}. Start it with \`npx figsnap-agent\` on the machine running Figma, ` +
        'then open the plugin so it has a file to reach.'
    : `The Figsnap daemon is not answering: ${why}`
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  let answer
  try {
    const response = await fetch(`${BASE}/tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-figsnap-token': TOKEN },
      body: JSON.stringify({ name: request.params.name, arguments: request.params.arguments ?? {} }),
    })
    answer = await response.json()
  } catch (error) {
    // The daemon going away mid-run is the common case: the designer quit it,
    // or the machine slept. Say so rather than returning a protocol error, so
    // the agent can tell the user instead of retrying into the void.
    return { isError: true, content: [{ type: 'text', text: unreachable(error) }] }
  }

  if (answer.error === 'Bad or missing agent token') {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text:
            'The Figsnap daemon rejected the token. It writes one to ~/.figsnap/agent-token; ' +
            'set FIGSNAP_AGENT_TOKEN to that value, or run `npx figsnap-agent` to create it.',
        },
      ],
    }
  }

  if (answer.error !== undefined) {
    return { isError: true, content: [{ type: 'text', text: String(answer.error) }] }
  }
  if (!Array.isArray(answer.content)) {
    return { isError: true, content: [{ type: 'text', text: 'The Figsnap daemon answered with no content.' }] }
  }
  return { content: answer.content }
})

await server.connect(new StdioServerTransport())
