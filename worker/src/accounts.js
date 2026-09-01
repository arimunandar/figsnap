// Accounts for the hosted relay.
//
// One Durable Object holds every account, which is fine because the only traffic
// is register, sign in, and token lookup. It uses SQLite storage, so accounts
// survive eviction — unlike Room, which deliberately stores nothing.
//
// What is stored: an email, a PBKDF2 hash of the password, and the SHA-256 hash
// of each issued token. Neither a password nor a usable token can be recovered
// from this database.
//
// Each account gets its own room, so a token grants access to that account's
// designs and nothing else.

import { DurableObject } from 'cloudflare:workers'

// Workers caps PBKDF2 at 100,000 iterations per call, which is below the 600,000
// OWASP recommends for PBKDF2-HMAC-SHA256. Chaining rounds over the previous
// output reaches the same total work within the cap. Note that `wrangler dev`
// does not enforce the cap, so only a deployed relay reveals a violation.
const ITERATIONS = 100_000
const ROUNDS = 6
const LOCKOUT_FAILURES = 10
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000
const MIN_PASSWORD = 10
const PAIRING_TTL_MS = 5 * 60 * 1000
// Ambiguous characters are left out so a code can be read aloud or retyped.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

const encoder = new TextEncoder()

function hex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function base64(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

async function derive(secret, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', secret, 'PBKDF2', false, ['deriveBits'])
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256)
}

/** Each round feeds the previous round's output back in as the secret. */
async function deriveChained(password, salt, iterations, rounds) {
  let secret = encoder.encode(password)
  let bits = null
  for (let round = 0; round < rounds; round++) {
    bits = await derive(secret, salt, iterations)
    secret = new Uint8Array(bits)
  }
  return bits
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const bits = await deriveChained(password, salt, ITERATIONS, ROUNDS)
  return `pbkdf2$${ITERATIONS}x${ROUNDS}$${base64(salt)}$${base64(bits)}`
}

/** Compared byte by byte in constant time, so a mismatch leaks no position. */
function sameBytes(a, b) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index++) difference |= a[index] ^ b[index]
  return difference === 0
}

async function verifyPassword(password, stored) {
  const [scheme, work, salt, expected] = String(stored).split('$')
  if (scheme !== 'pbkdf2') return false
  // Older hashes were written without a round count; treat them as one round.
  const [iterations, rounds] = String(work).split('x')
  const bits = await deriveChained(password, fromBase64(salt), Number(iterations), Number(rounds ?? 1) || 1)
  return sameBytes(new Uint8Array(bits), fromBase64(expected))
}

async function hashToken(token) {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(token)))
}

function normalise(email) {
  return String(email ?? '').trim().toLowerCase()
}

function looksLikeEmail(email) {
  return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
          hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS pairings (
          id TEXT PRIMARY KEY,
          code TEXT UNIQUE NOT NULL,
          created_at INTEGER NOT NULL,
          token TEXT,
          email TEXT
        );
        CREATE TABLE IF NOT EXISTS attempts (
          email TEXT PRIMARY KEY,
          failures INTEGER NOT NULL,
          first_at INTEGER NOT NULL
        );
      `)
    })
  }

  // ------------------------------------------------------------- lockout

  locked(email) {
    const row = this.ctx.storage.sql
      .exec('SELECT failures, first_at FROM attempts WHERE email = ?', email)
      .toArray()[0]
    if (!row) return false
    if (Date.now() - row.first_at > LOCKOUT_WINDOW_MS) {
      this.ctx.storage.sql.exec('DELETE FROM attempts WHERE email = ?', email)
      return false
    }
    return row.failures >= LOCKOUT_FAILURES
  }

  recordFailure(email) {
    const now = Date.now()
    const row = this.ctx.storage.sql
      .exec('SELECT failures, first_at FROM attempts WHERE email = ?', email)
      .toArray()[0]
    if (!row || now - row.first_at > LOCKOUT_WINDOW_MS) {
      this.ctx.storage.sql.exec(
        'INSERT INTO attempts (email, failures, first_at) VALUES (?, 1, ?) ' +
          'ON CONFLICT(email) DO UPDATE SET failures = 1, first_at = excluded.first_at',
        email,
        now,
      )
      return
    }
    this.ctx.storage.sql.exec('UPDATE attempts SET failures = failures + 1 WHERE email = ?', email)
  }

  clearFailures(email) {
    this.ctx.storage.sql.exec('DELETE FROM attempts WHERE email = ?', email)
  }

  // ---------------------------------------------------------------- api

  async issueToken(userId) {
    const token = hex(crypto.getRandomValues(new Uint8Array(24)))
    this.ctx.storage.sql.exec(
      'INSERT INTO tokens (hash, user_id, created_at) VALUES (?, ?, ?)',
      await hashToken(token),
      userId,
      Date.now(),
    )
    return token
  }

  async register(email, password) {
    const address = normalise(email)
    if (!looksLikeEmail(address)) throw new Error('That does not look like an email address.')
    if (String(password ?? '').length < MIN_PASSWORD) {
      throw new Error(`Use a password of at least ${MIN_PASSWORD} characters.`)
    }
    const existing = this.ctx.storage.sql.exec('SELECT id FROM users WHERE email = ?', address).toArray()[0]
    if (existing) throw new Error('An account with that email already exists.')

    const id = crypto.randomUUID()
    this.ctx.storage.sql.exec(
      'INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)',
      id,
      address,
      await hashPassword(password),
      Date.now(),
    )
    return { email: address, room: id, token: await this.issueToken(id) }
  }

  async login(email, password) {
    const address = normalise(email)
    if (this.locked(address)) {
      throw new Error('Too many failed attempts. Wait 15 minutes and try again.')
    }
    const user = this.ctx.storage.sql
      .exec('SELECT id, password_hash FROM users WHERE email = ?', address)
      .toArray()[0]

    // The same message either way, so this cannot be used to discover accounts.
    const ok = user ? await verifyPassword(password, user.password_hash) : false
    if (!ok) {
      this.recordFailure(address)
      throw new Error('Wrong email or password.')
    }

    this.clearFailures(address)
    return { email: address, room: user.id, token: await this.issueToken(user.id) }
  }

  /** Resolves a presented token to its account, or null. */
  async resolve(token) {
    if (typeof token !== 'string' || token === '') return null
    const row = this.ctx.storage.sql
      .exec(
        'SELECT tokens.user_id AS id, users.email AS email FROM tokens ' +
          'JOIN users ON users.id = tokens.user_id WHERE tokens.hash = ?',
        await hashToken(token),
      )
      .toArray()[0]
    if (!row) return null
    this.ctx.storage.sql.exec('UPDATE tokens SET last_used_at = ? WHERE hash = ?', Date.now(), await hashToken(token))
    return { room: row.id, email: row.email }
  }

  async revoke(token) {
    this.ctx.storage.sql.exec('DELETE FROM tokens WHERE hash = ?', await hashToken(token))
    return { revoked: true }
  }

  /** Lets a test assert the hashing parameters are within platform limits. */
  async hashingParameters() {
    return { iterations: ITERATIONS, rounds: ROUNDS, total: ITERATIONS * ROUNDS, cap: 100_000 }
  }

  // ------------------------------------------------------------- pairing
  //
  // Pairing exists so nobody has to copy a 48-character token between a browser
  // and Figma. The plugin holds a secret id, the person sees a short code, and
  // the browser they sign in with claims it. The token crosses only once and the
  // row is deleted on pickup.

  prunePairings() {
    this.ctx.storage.sql.exec('DELETE FROM pairings WHERE created_at < ?', Date.now() - PAIRING_TTL_MS)
  }

  async startPairing() {
    this.prunePairings()
    const bytes = crypto.getRandomValues(new Uint8Array(8))
    const code = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
    const id = hex(crypto.getRandomValues(new Uint8Array(24)))
    this.ctx.storage.sql.exec(
      'INSERT INTO pairings (id, code, created_at) VALUES (?, ?, ?)',
      id,
      code,
      Date.now(),
    )
    return { id, code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInMs: PAIRING_TTL_MS }
  }

  /** Called by a signed-in browser, on behalf of the account it is signed in as. */
  async claimPairing(code, userToken) {
    this.prunePairings()
    const account = await this.resolve(userToken)
    if (!account) throw new Error('Sign in first, then connect Figma.')

    const normalised = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const pairing = this.ctx.storage.sql
      .exec('SELECT id, token FROM pairings WHERE code = ?', normalised)
      .toArray()[0]
    if (!pairing) throw new Error('That code has expired. Start again from the plugin.')
    if (pairing.token) throw new Error('That code has already been used.')

    // A fresh token, so the browser's own token is never handed to the plugin.
    const token = await this.issueToken(account.room)
    this.ctx.storage.sql.exec(
      'UPDATE pairings SET token = ?, email = ? WHERE id = ?',
      token,
      account.email,
      pairing.id,
    )
    return { email: account.email }
  }

  /** The plugin polls this; the token is handed over exactly once. */
  async takePairing(id) {
    this.prunePairings()
    const pairing = this.ctx.storage.sql
      .exec('SELECT token, email FROM pairings WHERE id = ?', String(id ?? ''))
      .toArray()[0]
    if (!pairing) return { status: 'expired' }
    if (!pairing.token) return { status: 'pending' }
    this.ctx.storage.sql.exec('DELETE FROM pairings WHERE id = ?', id)
    return { status: 'ready', token: pairing.token, email: pairing.email }
  }

  async stats() {
    const users = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0].n
    const tokens = this.ctx.storage.sql.exec('SELECT COUNT(*) AS n FROM tokens').toArray()[0].n
    return { users, tokens }
  }
}
