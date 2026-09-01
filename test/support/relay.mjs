// One relay for the whole test run.
//
// There is only one relay now — a Cloudflare Worker — so every suite that needs
// one would otherwise pay a `wrangler dev` cold start. run.mjs starts a single
// instance and passes its address down; suites isolate themselves by registering
// their own account, which puts each in its own room.

const BASE = process.env.FIGSNAP_TEST_BASE ?? ''

/** The shared relay, or null when run.mjs could not start one. */
export function relayBase() {
  return BASE === '' ? null : BASE
}

/** Skips a suite cleanly when there is no relay to talk to. */
export function requireRelay(what) {
  if (BASE === '') {
    console.log(`SKIP  no relay available; ${what} not exercised`)
    process.exit(0)
  }
  return BASE
}

let counter = 0

/**
 * A throwaway account, so a suite gets a room nothing else writes to. The email
 * carries the suite name to make a stray row in the dev database explicable.
 */
export async function account(base, label = 'suite') {
  const email = `${label}-${Date.now()}-${++counter}@example.test`
  const password = 'a password long enough'
  const response = await fetch(`${base}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!response.ok) throw new Error(`could not register a test account: ${response.status}`)
  const { token } = await response.json()
  return { email, token, headers: { 'x-relay-token': token } }
}

/** Waits for a relay to answer, however it was started. */
export async function waitForRelay(base, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if ((await fetch(`${base}/health`)).ok) return true
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/**
 * Sends the token on every request to this relay, for suites whose subject is
 * not authentication. They read as they did when the relay had no accounts,
 * while still going through the real gate.
 */
export function authenticateFetch(base, headers) {
  const plain = globalThis.fetch
  globalThis.fetch = (input, init = {}) => {
    if (!String(input).startsWith(base)) return plain(input, init)
    return plain(input, { ...init, headers: { ...(init.headers ?? {}), ...headers } })
  }
}
