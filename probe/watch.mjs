#!/usr/bin/env node
// Records how long Figma lets a plugin runtime live.
//
// One claim needs settling before the agent bridge is designed around it: that
// the plugin iframe is destroyed every 1-3 minutes regardless of activity. This
// listens on a fixed port, holds whatever the probe plugin dials in with, and
// writes one line per event. Nothing here is part of the plugin; delete the
// directory once the question is answered.
//
//   node probe/watch.mjs        then import probe/manifest.json in Figma
//
// What the log distinguishes:
//   ui-boot     a new UI boot id  -> the iframe runtime was rebuilt
//   main-boot   a new main boot id -> the main thread was rebuilt
//   close       the socket dropped without the runtime necessarily dying
//   stall       timers froze for far longer than the 2s beat

import { createServer } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PROBE_PORT ?? 3057)
const HOST = '127.0.0.1'
const LOG = join(dirname(fileURLToPath(import.meta.url)), 'probe.log')
const STALL_MS = 6_000

const startedAt = Date.now()
let sockets = 0
let closes = 0
let uiBoots = new Set()
let mainBoots = new Set()
let longestLifeMs = 0
let longestStallMs = 0

async function record(kind, detail) {
  const line = `${new Date().toISOString()}  ${kind.padEnd(11)} ${detail}`
  console.log(line)
  await appendFile(LOG, line + '\n').catch(() => {})
}

const server = createServer((_req, res) => {
  const summary = {
    watchingForMs: Date.now() - startedAt,
    socketsOpened: sockets,
    socketsClosed: closes,
    distinctUiBoots: uiBoots.size,
    distinctMainBoots: mainBoots.size,
    longestSocketLifeMs: longestLifeMs,
    longestStallMs,
  }
  const body = JSON.stringify(summary, null, 2)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(body)
})

const wss = new WebSocketServer({ server })

wss.on('connection', (socket) => {
  sockets += 1
  const openedAt = Date.now()
  let boot = '?'

  socket.on('message', (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (typeof message.uiBoot === 'string') {
      boot = message.uiBoot
      if (!uiBoots.has(message.uiBoot)) {
        uiBoots.add(message.uiBoot)
        // The number that answers the question: a second boot id means the
        // document was reloaded, and its arrival time says how long the first lived.
        void record('ui-boot', `${message.uiBoot}  (boot #${uiBoots.size} after ${Math.round((Date.now() - startedAt) / 1000)}s)`)
      }
    }
    if (typeof message.mainBoot === 'string' && !mainBoots.has(message.mainBoot)) {
      mainBoots.add(message.mainBoot)
      void record('main-boot', `${message.mainBoot}  (boot #${mainBoots.size})`)
    }
    if (message.type === 'main-restart') {
      void record('main-restart', `${message.from} -> ${message.to}`)
    }
    if (message.type === 'tick' && typeof message.gapMs === 'number' && message.gapMs > STALL_MS) {
      if (message.gapMs > longestStallMs) longestStallMs = message.gapMs
      void record('stall', `${message.gapMs}ms between beats  ui=${boot}`)
    }
  })

  socket.on('close', (code) => {
    closes += 1
    const lifeMs = Date.now() - openedAt
    if (lifeMs > longestLifeMs) longestLifeMs = lifeMs
    void record('close', `code=${code} lived=${Math.round(lifeMs / 1000)}s  ui=${boot}`)
  })

  void record('open', `socket #${sockets}`)
})

server.listen(PORT, HOST, () => {
  console.log(`probe watching on ws://${HOST}:${PORT}  (summary: http://${HOST}:${PORT}/)`)
  console.log(`appending to ${LOG}`)
  console.log('import probe/manifest.json in Figma, open the plugin, leave it for an hour\n')
})

// A run that ends without a summary makes the log harder to read than it needs
// to be, so the totals are printed on the way out.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    const minutes = (Date.now() - startedAt) / 60_000
    console.log('\n' + '='.repeat(52))
    console.log(`watched for            ${minutes.toFixed(1)} min`)
    console.log(`sockets opened/closed  ${sockets}/${closes}`)
    console.log(`distinct UI boots      ${uiBoots.size}`)
    console.log(`distinct main boots    ${mainBoots.size}`)
    console.log(`longest socket life    ${Math.round(longestLifeMs / 1000)}s`)
    console.log(`longest timer stall    ${longestStallMs}ms`)
    console.log(
      uiBoots.size <= 1
        ? '\nOne UI boot: the runtime was never rebuilt. Resumption is a nicety.'
        : `\n${uiBoots.size} UI boots in ${minutes.toFixed(1)} min: the runtime is rebuilt under you. Resumption is the spine.`,
    )
    process.exit(0)
  })
}
