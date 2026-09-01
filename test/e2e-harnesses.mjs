// The harness registry, on its own.
//
// No relay, no Figma, no daemon: this imports the module and asks it questions,
// because everything worth asserting here is a pure function of `process.env`.
//
// The one that matters most is the last group. `surveyHarnesses()` is sent over
// the WebSocket into the plugin iframe, and the DeepSeek row is the first one to
// hold a secret, so the shape of that output is a security boundary rather than
// a formatting detail.

import { HARNESSES, allHarnesses, findHarness, surveyHarnesses } from '../agent/lib/harnesses.mjs'

const out = []
const check = (name, ok, detail = '') => {
  out.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const KNOBS = [
  'DEEPSEEK_API_KEY',
  'DEEPSEEK_MODEL',
  'DEEPSEEK_FAST_MODEL',
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_TIMEOUT_MS',
  'FIGSNAP_AGENT_COMMAND',
  'FIGSNAP_AGENT_NAME',
]

/**
 * The suite decides the environment; whatever the developer has exported does
 * not. Awaits the body, because `surveyHarnesses()` reads `process.env` after
 * its first await and would otherwise see the restored values.
 */
async function withEnv(values, body) {
  const before = Object.fromEntries(KNOBS.map((key) => [key, process.env[key]]))
  for (const key of KNOBS) delete process.env[key]
  Object.assign(process.env, values)
  try {
    return await body()
  } finally {
    for (const key of KNOBS) delete process.env[key]
    for (const [key, value] of Object.entries(before)) if (value !== undefined) process.env[key] = value
  }
}

const claude = HARNESSES.find((harness) => harness.id === 'claude')
const deepseek = HARNESSES.find((harness) => harness.id === 'deepseek')

// -------------------------------------------------------------- the same adapter

check('there is a DeepSeek row', deepseek !== undefined)
check('it drives the same adapter as Claude Code',
  deepseek.command === claude.command && deepseek.args.join(' ') === claude.args.join(' '),
  deepseek.args.join(' '))
check('so it is detected by the same CLI', deepseek.cli === 'claude')
check('it does not skip the permission prompt',
  !deepseek.args.includes('--dangerously-skip-permissions'))
check('its note does not read as a second Claude login',
  deepseek.note.includes('DEEPSEEK_API_KEY') && !/your Claude Code login/.test(deepseek.note))

// -------------------------------------------------------------------- the environment

await withEnv({ DEEPSEEK_API_KEY: 'sk-test-key' }, () => {
  const env = deepseek.env()
  check('it points at DeepSeek', env.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic')
  check('the key becomes the Anthropic auth token', env.ANTHROPIC_AUTH_TOKEN === 'sk-test-key')
  check('every model name is set',
    env.ANTHROPIC_MODEL === 'deepseek-v4-flash-vision-exp[1m]' &&
    env.ANTHROPIC_DEFAULT_OPUS_MODEL === 'deepseek-v4-flash-vision-exp[1m]' &&
    env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'deepseek-v4-flash-vision-exp[1m]' &&
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'deepseek-v4-flash' &&
    env.CLAUDE_CODE_SUBAGENT_MODEL === 'deepseek-v4-flash')
  // A design tool sends pictures, so the model that answers has to take one.
  check('the default main model is the vision variant',
    env.ANTHROPIC_MODEL.includes('vision'), env.ANTHROPIC_MODEL)
  check('the timeout is generous', Number(env.API_TIMEOUT_MS) >= 600000, env.API_TIMEOUT_MS)
})

// An unset knob must be absent, not the string "undefined" — spawn would pass
// that through as a real value and the harness would authenticate with it.
await withEnv({}, () => {
  const env = deepseek.env()
  check('with no key there is no auth token at all',
    !('ANTHROPIC_AUTH_TOKEN' in env),
    JSON.stringify(env.ANTHROPIC_AUTH_TOKEN))
  check('and nothing else holds the string "undefined"',
    Object.values(env).every((value) => value !== undefined && value !== 'undefined'))
})

await withEnv(
  {
    DEEPSEEK_API_KEY: 'sk-test-key',
    DEEPSEEK_MODEL: 'deepseek-next',
    DEEPSEEK_FAST_MODEL: 'deepseek-quick',
    DEEPSEEK_BASE_URL: 'https://example.test/anthropic',
  },
  () => {
    const env = deepseek.env()
    check('DEEPSEEK_MODEL overrides the big models',
      env.ANTHROPIC_MODEL === 'deepseek-next' && env.ANTHROPIC_DEFAULT_SONNET_MODEL === 'deepseek-next')
    check('DEEPSEEK_FAST_MODEL overrides the small ones',
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL === 'deepseek-quick' &&
      env.CLAUDE_CODE_SUBAGENT_MODEL === 'deepseek-quick')
    check('DEEPSEEK_BASE_URL overrides the endpoint',
      env.ANTHROPIC_BASE_URL === 'https://example.test/anthropic')
  },
)

// ---------------------------------------------------------------- availability

const row = (list, id) => list.find((entry) => entry.id === id)

const withoutKey = await withEnv({}, () => surveyHarnesses())
const claudeRow = row(withoutKey, 'claude')
const deepseekRow = row(withoutKey, 'deepseek')
const installed = claudeRow.available

check('a missing key is not a missing install',
  installed ? deepseekRow.reason === 'DEEPSEEK_API_KEY is not set' : deepseekRow.reason === 'not installed',
  `claude ${installed ? 'on' : 'off'} PATH`)
check('and it is unavailable either way', deepseekRow.available === false)
check('a CLI that is absent says so',
  withoutKey.filter((entry) => !entry.available).every((entry) => typeof entry.reason === 'string'))
check('an available row gives no reason',
  withoutKey.filter((entry) => entry.available).every((entry) => entry.reason === undefined))

const withKey = await withEnv({ DEEPSEEK_API_KEY: 'sk-test-key' }, () => surveyHarnesses())
check('both halves present makes it available',
  row(withKey, 'deepseek').available === installed &&
  row(withKey, 'deepseek').reason === (installed ? undefined : 'not installed'))
check('an empty key does not count',
  (await withEnv({ DEEPSEEK_API_KEY: '' }, () => surveyHarnesses())).find((e) => e.id === 'deepseek')
    .available === false)

// ------------------------------------------------------- nothing secret crosses

const FIELDS = ['id', 'name', 'command', 'available', 'note', 'reason']
const serialised = JSON.stringify(withKey)

check('the survey carries no key', !serialised.includes('sk-test-key'))
check('and no environment at all',
  withKey.every((entry) => Object.keys(entry).every((key) => FIELDS.includes(key))),
  [...new Set(withKey.flatMap((entry) => Object.keys(entry)))].join(' '))
check('no ANTHROPIC_ variable leaks either',
  !serialised.includes('ANTHROPIC_') && !serialised.includes('AUTH_TOKEN'))
check('the shape the panel draws is intact',
  withKey.every((entry) =>
    typeof entry.id === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.command === 'string' &&
    typeof entry.available === 'boolean' &&
    typeof entry.note === 'string'))

// -------------------------------------------------------------------- lookup

check('findHarness resolves DeepSeek', findHarness('deepseek')?.name === 'DeepSeek')
check('an unknown id resolves to null', findHarness('nope') === null)

await withEnv({ FIGSNAP_AGENT_COMMAND: 'my-adapter --acp', FIGSNAP_AGENT_NAME: 'Mine' }, () => {
  const all = allHarnesses()
  const custom = all.find((harness) => harness.id === 'custom')
  check('FIGSNAP_AGENT_COMMAND still gets its own row',
    custom?.name === 'Mine' && custom.command === 'my-adapter' && custom.args.join(' ') === '--acp')
  check('and it does not displace DeepSeek',
    all.filter((harness) => harness.id === 'deepseek').length === 1 && all.length === HARNESSES.length + 1)
})

const failed = out.filter((ok) => !ok).length
console.log(`\n${out.length - failed}/${out.length} passed`)
process.exit(failed === 0 ? 0 : 1)
