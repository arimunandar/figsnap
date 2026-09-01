#!/usr/bin/env node
// The MCP server the harness spawns, and this project's only reason the agent
// can touch Figma at all.
//
// ACP gives a chat. MCP gives hands. All three harnesses speak both, so the
// daemon hands each new session one stdio MCP server — this file — and every
// tool on it proxies back to the daemon over loopback HTTP, which forwards it
// down the panel's WebSocket into `figma.*`.
//
// stdio rather than HTTP on purpose: an ACP agent must be told it can take an
// HTTP MCP server (`mcpCapabilities.http`), and stdio is the variant every
// agent has to support. One extra process per session is the price of not
// asking three harnesses the same capability question.
//
// Nothing is configured here. The daemon passes its address and token in the
// environment when it spawns this, and refuses anything that arrives without them.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { toolManifest } from './lib/tools.mjs'

const BASE = process.env.FIGSNAP_AGENT_URL ?? ''
const TOKEN = process.env.FIGSNAP_AGENT_TOKEN ?? ''

if (BASE === '') {
  console.error('FIGSNAP_AGENT_URL is not set. This is spawned by figsnap-agent, not run directly.')
  process.exit(1)
}

const server = new Server(
  { name: 'figsnap', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolManifest() }))

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
    return {
      isError: true,
      content: [{ type: 'text', text: `The Figsnap daemon is not answering: ${error instanceof Error ? error.message : String(error)}` }],
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
