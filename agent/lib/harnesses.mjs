// Which coding agents this machine can launch.
//
// ACP has no discovery mechanism — the registry it publishes is a package index,
// not a running service — so there is nothing to ask. What there is, is a short
// list of adapters that exist and a cheap question about each: is the CLI it
// wraps on this PATH? That is a good proxy for "installed and signed in",
// because all three own their own auth and billing and none of them work
// without their own CLI present.
//
// A harness that is not detected is still launchable: `npx` will fetch the
// adapter. It is listed as unavailable so the panel can say why rather than
// hang on a spawn that will fail three minutes later.

import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'

export const HARNESSES = [
  {
    id: 'claude',
    name: 'Claude Code',
    cli: 'claude',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
    note: 'Uses your Claude Code login. Run `claude` once in a terminal first if you have not.',
  },
  {
    id: 'codex',
    name: 'Codex',
    cli: 'codex',
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
    note: 'Uses your Codex login. Run `codex` once in a terminal first if you have not.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cli: 'gemini',
    command: 'npx',
    args: ['-y', '@google/gemini-cli', '--acp'],
    note: 'Uses your Gemini CLI login. Run `gemini` once in a terminal first if you have not.',
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

/** The list as the panel shows it: everything, each marked available or not. */
export async function surveyHarnesses() {
  const harnesses = allHarnesses()
  const found = await Promise.all(harnesses.map((harness) => onPath(harness.cli)))
  return harnesses.map((harness, index) => ({
    id: harness.id,
    name: harness.name,
    command: [harness.command, ...harness.args].join(' '),
    available: found[index],
    note: harness.note,
  }))
}

export function findHarness(id) {
  return allHarnesses().find((harness) => harness.id === id) ?? null
}
