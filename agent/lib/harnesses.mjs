// Which coding agents this machine can launch.
//
// ACP has no discovery mechanism — the registry it publishes is a package index,
// not a running service — so there is nothing to ask. What there is, is a short
// list of adapters that exist and a cheap question about each: is the CLI it
// wraps on this PATH? That is a good proxy for "installed and signed in",
// because all of them own their own auth and billing and none of them work
// without their own CLI present.
//
// A row can need a second thing as well. DeepSeek runs through the same Claude
// Code adapter as the `claude` row, pointed at an Anthropic-compatible endpoint,
// so the CLI being present is only half of it: the key has to be in this
// daemon's environment too. `requires` names that half, and `reason` says which
// half is missing rather than guessing "not installed" at both.
//
// A harness that is not detected is still launchable: `npx` will fetch the
// adapter. It is listed as unavailable so the panel can say why rather than
// hang on a spawn that will fail three minutes later.

import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

/** Environment without the holes, so an unset knob is absent, not `"undefined"`. */
function defined(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined))
}

/**
 * How an adapter is launched. `npx` so a harness nobody has installed is still
 * launchable — that is the whole reason an undetected row is listed rather than
 * hidden.
 *
 * `--prefer-offline` because the plain form re-checks the npm registry on every
 * single session start, and that check is most of what a designer waits through:
 * measured here, `initialize` took 1.0–4.1s with `-y` alone against 0.5–0.6s
 * with this flag, which is the difference between Start feeling slow and Start
 * feeling immediate. The cost is that a cached adapter stops being replaced by a
 * newer published one; `npm cache clean` or a version bump is the way to move.
 */
const adapter = (...args) => ({ command: 'npx', args: ['--prefer-offline', '-y', ...args] })

const CLAUDE_ACP = adapter('@agentclientprotocol/claude-agent-acp')

export const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    ...CLAUDE_ACP,
    note: 'Uses your Claude Code login. Run `claude` once in a terminal first if you have not.',
  },
  {
    id: 'codex',
    name: 'Codex',
    cli: 'codex',
    ...adapter('@agentclientprotocol/codex-acp'),
    note: 'Uses your Codex login. Run `codex` once in a terminal first if you have not.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cli: 'gemini',
    ...adapter('@google/gemini-cli', '--acp'),
    note: 'Uses your Gemini CLI login. Run `gemini` once in a terminal first if you have not.',
  },
  {
    // DeepSeek's endpoint is Anthropic-compatible, so this is the `claude` row
    // with a different base URL and a different key — same adapter, same CLI,
    // no code of its own. Everything that varies is environment, which is read
    // at spawn rather than at import so a key exported after the daemon started
    // still counts.
    id: 'deepseek',
    name: 'DeepSeek',
    cli: 'claude',
    ...CLAUDE_ACP,
    requires: 'DEEPSEEK_API_KEY',
    env: () => {
      // DeepSeek's own naming, not Anthropic's, and it will drift — hence the
      // overrides rather than only the defaults.
      //
      // The vision variant is the default because this is a design tool: the
      // panel attaches a PNG of the canvas, and a model that cannot look at one
      // answers questions about a picture it never saw.
      const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash-vision-exp[1m]'
      const fast = process.env.DEEPSEEK_FAST_MODEL ?? 'deepseek-v4-flash'
      return defined({
        ANTHROPIC_BASE_URL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: process.env.DEEPSEEK_API_KEY,
        ANTHROPIC_MODEL: model,
        ANTHROPIC_DEFAULT_OPUS_MODEL: model,
        ANTHROPIC_DEFAULT_SONNET_MODEL: model,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
        CLAUDE_CODE_SUBAGENT_MODEL: fast,
        // A slow model that times out mid-turn reads as a broken harness, so
        // this is deliberately generous.
        API_TIMEOUT_MS: process.env.DEEPSEEK_TIMEOUT_MS ?? '3000000',
      })
    },
    note: 'Runs the Claude Code CLI against DeepSeek’s API with DEEPSEEK_API_KEY — not your Claude login.',
  },
]

/** Node has no `which`, and shelling out to one costs a process per harness. */
async function onPath(binary) {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry !== '')
  for (const dir of dirs) {
    try {
      await access(join(dir, binary), constants.X_OK)
      return true
    } catch {
      // Not here; the next directory on PATH may have it.
    }
  }
  return false
}

/**
 * A harness the user configured themselves, for anything not on the list above.
 * ACP is the whole contract, so an adapter this daemon has never heard of works
 * as well as one it ships a row for.
 */
function custom() {
  const command = process.env.FIGSNAP_AGENT_COMMAND
  if (command === undefined || command.trim() === '') return null
  const [head, ...rest] = command.trim().split(/\s+/)
  return {
    id: 'custom',
    name: process.env.FIGSNAP_AGENT_NAME ?? head,
    cli: head,
    command: head,
    args: rest,
    note: 'From FIGSNAP_AGENT_COMMAND.',
  }
}

export function allHarnesses() {
  const extra = custom()
  return extra === null ? HARNESSES : [...HARNESSES, extra]
}

/**
 * The list as the panel shows it: everything, each marked available or not.
 *
 * This crosses the WebSocket into the plugin iframe, so it carries the five
 * fields the panel draws and nothing else — in particular not `env`, which
 * holds a key.
 */
export async function surveyHarnesses() {
  const harnesses = allHarnesses()
  const found = await Promise.all(harnesses.map((harness) => onPath(harness.cli)))
  return harnesses.map((harness, index) => {
    const missingKey =
      harness.requires !== undefined && (process.env[harness.requires] ?? '') === ''
    return {
      id: harness.id,
      name: harness.name,
      command: [harness.command, ...harness.args].join(' '),
      available: found[index] && !missingKey,
      note: harness.note,
      reason: !found[index] ? 'not installed' : missingKey ? `${harness.requires} is not set` : undefined,
    }
  })
}

export function findHarness(id) {
  return allHarnesses().find((harness) => harness.id === id) ?? null
}
