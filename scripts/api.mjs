#!/usr/bin/env node
// A thin curl for the relay, so a token never has to appear in a command line.
//
//   npm run api -- /selection
//   npm run api -- /extract '{"nodeId":"21:10314"}'
//
// The token comes from RELAY_TOKEN, or ./.figsnap-token (gitignored). The relay
// address comes from RELAY_HTTP, or the hosted default below.

import { readFileSync, existsSync } from 'node:fs'

const DEFAULT_BASE = 'https://figsnap-relay.arimunandar-dev.workers.dev'
const base = process.env.RELAY_HTTP ?? DEFAULT_BASE

const tokenFile = ['.figsnap-token', '.relay-token'].find((name) => existsSync(name))
const token = process.env.RELAY_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : '')
if (token === '') {
  console.error(`No token. Sign in at ${base}/login, copy the token, then:\n  pbpaste > .figsnap-token`)
  process.exit(2)
}

const [path = '/health', body] = process.argv.slice(2)
const response = await fetch(`${base}${path}`, {
  method: body ? 'POST' : 'GET',
  headers: { 'x-relay-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
  body,
})

const text = await response.text()
console.error(`${response.status} ${response.headers.get('content-type') ?? ''}`)
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2))
} catch {
  console.log(text)
}
process.exit(response.ok ? 0 : 1)
