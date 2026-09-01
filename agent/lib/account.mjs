// The daemon's idea of who is using it.
//
// Two credentials live in this project and they answer different questions. The
// token in ~/.figsnap/agent-token answers "is this process allowed to talk to
// the daemon" — a machine-local secret, which is the right shape for a service
// bound to 127.0.0.1. It says nothing about *who*. An account answers that, and
// it is the only one of the two that anybody can revoke from somewhere else.
//
// So this is opt-in rather than mandatory. The daemon is loopback-only and
// otherwise needs no network at all; requiring a hosted round trip before a
// local tool would work would break using it on a plane, and would break the
// promise that `claude mcp add figsnap -- npx -y figsnap-mcp` needs no setup.
// `--require-login` turns it into a requirement for people who want one.
//
// What is not opt-in: once an account is attached it is enforced. It is checked
// at startup and re-checked as the daemon runs, so revoking a token on the relay
// actually stops the tools rather than stopping them at the next restart.
//
// The password never comes near this file. The relay already has a device
// pairing flow, built so nobody copies a 48-character token between a browser
// and Figma, and it fits a terminal exactly: we ask for a short code, the person
// signs in on the relay's own page, and we are handed a fresh token scoped to
// their room. Reading a password on a TTY would be strictly worse.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { HOSTED_RELAY_HTTP } from '../../shared/relay.mjs'

export const ACCOUNT_FILE = join(homedir(), '.figsnap', 'account.json')

/**
 * How long a verified account is trusted before the relay is asked again, and
 * therefore how long a revoked token keeps working. One request a minute per
 * running daemon is nothing; ten minutes of grace after a revocation is not.
 * FIGSNAP_ACCOUNT_RECHECK_MS lowers it where revocation has to bite sooner.
 */
const RECHECK_MS = 60_000
/** The pairing code the relay issues lasts five minutes; give up with it. */
const PAIRING_TIMEOUT_MS = 5 * 60_000
const POLL_MS = 2_000

/** Where to sign in, when nothing was named. */
export function defaultRelay() {
  const fromEnv = process.env.FIGSNAP_RELAY_URL
  return typeof fromEnv === 'string' && fromEnv !== '' ? fromEnv.replace(/\/+$/, '') : HOSTED_RELAY_HTTP
}

export async function readAccount() {
  const raw = await readFile(ACCOUNT_FILE, 'utf8').catch(() => null)
  if (raw === null) return null
  try {
    const stored = JSON.parse(raw)
    if (typeof stored?.token !== 'string' || stored.token === '') return null
    return { url: String(stored.url ?? defaultRelay()), token: stored.token, email: String(stored.email ?? ''), room: String(stored.room ?? '') }
  } catch {
    // A truncated file is not a reason to refuse to start; it is a reason to
    // behave as though nobody had signed in yet.
    return null
  }
}

export async function writeAccount(account) {
  await mkdir(dirname(ACCOUNT_FILE), { recursive: true })
  // 0600 for the same reason as the agent token: it is a bearer credential, and
  // the other accounts on this machine are not the user.
  await writeFile(ACCOUNT_FILE, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 })
}

export async function clearAccount() {
  await rm(ACCOUNT_FILE, { force: true })
}

/** Which account a token belongs to, or null once it has been revoked. */
export async function whoIs(url, token) {
  const response = await fetch(`${url}/auth/me`, { headers: { 'x-relay-token': token } })
  if (response.status === 401) return null
  if (!response.ok) throw new Error(`The relay answered ${response.status}`)
  return response.json()
}

/**
 * The device flow, from this side.
 *
 * `onCode` is called once with the code and the page to open, because a login
 * that printed nothing until it finished would look like a hang. The token
 * crosses exactly once: the relay deletes the pairing row when we collect it.
 */
export async function signIn(url, { onCode, timeoutMs = PAIRING_TIMEOUT_MS } = {}) {
  const started = await fetch(`${url}/auth/pair/start`, { method: 'POST' })
  if (!started.ok) throw new Error(`Could not start a login at ${url}: ${started.status}`)
  const pairing = await started.json()
  onCode?.(pairing)

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((settle) => setTimeout(settle, POLL_MS))
    const polled = await fetch(`${url}/auth/pair/status?id=${encodeURIComponent(pairing.id)}`)
    const status = await polled.json().catch(() => ({ status: 'pending' }))
    if (status.status === 'ready') return { url, token: status.token, email: String(status.email ?? ''), room: '' }
    if (status.status === 'expired') break
  }
  throw new Error('That login expired before it was completed. Run it again.')
}

/**
 * Holds what the daemon knows about who is using it, and answers the one
 * question the tool route needs: may this call go through?
 */
export function createAccountGate({ log = () => {}, requireLogin = false, recheckMs = RECHECK_MS } = {}) {
  let stored = null
  // 'none' — nobody signed in. 'ok' — verified against the relay. 'revoked' —
  // the relay says this token is no longer an account. 'unreachable' — we could
  // not ask, which is not the same as a refusal; see `refuse` below.
  let status = 'none'
  let checkedAt = 0
  let detail = ''
  // Who the plugin panel is signed into the relay as, when it is signed in at
  // all. The panel volunteers this on `hello`; it is not a credential and is not
  // trusted as one — it is only ever used to refuse a mismatch.
  let panelEmail = ''

  async function refresh(force = false) {
    stored = await readAccount()
    if (stored === null) {
      status = 'none'
      detail = ''
      return state()
    }
    if (!force && status === 'ok' && Date.now() - checkedAt < recheckMs) return state()

    try {
      const account = await whoIs(stored.url, stored.token)
      checkedAt = Date.now()
      if (account === null) {
        status = 'revoked'
        detail = 'the relay no longer recognises this token'
        log(`account: ${stored.email || 'signed in'} — revoked`)
        return state()
      }
      stored = { ...stored, email: account.email ?? stored.email, room: account.room ?? stored.room }
      await writeAccount(stored)
      status = 'ok'
      detail = ''
      return state()
    } catch (error) {
      // Deliberately not a refusal. A daemon that stopped answering local tool
      // calls because a hosted service was unreachable would be a worse product
      // than one that says so and carries on; the machine-local token is still
      // in front of everything. Being unable to ask is reported, not enforced.
      status = 'unreachable'
      detail = error instanceof Error ? error.message : String(error)
      log(`account: could not reach ${stored.url} — ${detail}`)
      return state()
    }
  }

  /** Why this call must not go through, or null. */
  function refuse() {
    if (stored === null) {
      return requireLogin
        ? 'Nobody is signed in. Run `figsnap-agent login` on the machine running Figma, sign in with your ' +
            'account in the browser it opens, and try again.'
        : null
    }
    if (status === 'revoked') {
      return (
        `The Figsnap account this daemon was signed in as (${stored.email || 'unknown'}) has been revoked. ` +
        'Run `figsnap-agent login` again.'
      )
    }
    // Both sides signed in as different people is the case worth stopping. It
    // is what makes signing in mean something at all: without it, anyone on
    // this machine could sign in as themselves and still drive the file that
    // somebody else has open.
    if (panelEmail !== '' && stored.email !== '' && panelEmail !== stored.email) {
      return (
        `This daemon is signed in as ${stored.email}, but the Figma plugin is signed in as ${panelEmail}. ` +
        'They have to be the same account. Sign out of one of them.'
      )
    }
    return null
  }

  function state() {
    return {
      signedIn: stored !== null,
      email: stored?.email ?? '',
      relay: stored?.url ?? '',
      status,
      required: requireLogin,
      ...(detail === '' ? {} : { detail }),
      ...(panelEmail === '' ? {} : { panel: panelEmail }),
    }
  }

  return {
    refresh,
    refuse,
    state,
    /** What the panel says it is signed into the relay as. '' means it is not. */
    setPanelIdentity(email) {
      panelEmail = typeof email === 'string' ? email : ''
    },
    account() {
      return stored
    },
  }
}
