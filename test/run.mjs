// Runs every suite in this directory and reports one summary.
//
// There is one relay — a Cloudflare Worker — so one `wrangler dev` is started
// here and its address handed to every suite through FIGSNAP_TEST_BASE. Suites
// isolate themselves by registering their own account, which puts each in its
// own room, so they still need no Figma, no network beyond localhost, and can
// run in any order. A suite that finds no relay skips rather than fails.

import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const files = (await readdir(here))
  .filter((name) => name.endsWith('.mjs') && name !== 'run.mjs')
  .sort()

const PORT = 8790
const BASE = `http://localhost:${PORT}`

const worker = spawn(
  'npx',
  ['wrangler', 'dev', '--config', 'worker/wrangler.jsonc', '--port', String(PORT),
   '--persist-to', '.wrangler/test-shared'],
  { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
)
worker.stdout.on('data', () => {})
worker.stderr.on('data', () => {})

let up = false
for (let attempt = 0; attempt < 120; attempt++) {
  try {
    if ((await fetch(`${BASE}/health`)).ok) { up = true; break }
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 500))
}
if (!up) console.log('\n\x1b[33mwrangler dev did not start; relay-backed suites will skip\x1b[0m')

const env = { ...process.env, ...(up ? { FIGSNAP_TEST_BASE: BASE } : {}) }
const results = []

for (const file of files) {
  process.stdout.write(`\n\x1b[1m${file}\x1b[0m\n`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, file)], { cwd: root, stdio: 'inherit', env })
    child.on('exit', (status) => resolve(status ?? 1))
  })
  results.push({ file, ok: code === 0 })
}

worker.kill()

const failed = results.filter((result) => !result.ok)
console.log('\n' + '='.repeat(52))
for (const result of results) console.log(`${result.ok ? 'ok  ' : 'FAIL'}  ${result.file}`)
console.log(`\n${results.length - failed.length}/${results.length} suites passed`)
process.exit(failed.length === 0 ? 0 : 1)
