// The relay addresses this build knows about.
//
// Both sandboxes need them — the main thread to decide what a fresh install
// points at, the UI to label and switch between them — so they live here rather
// than being written out twice and drifting.

/** A relay on this machine: no accounts, and the only kind with a filesystem. */
export const LOCAL_RELAY_URL = 'ws://localhost:3055/plugin'

/**
 * The hosted relay this copy of the plugin was set up against. Change it after
 * deploying your own — `npm run worker:deploy` prints the address — and add the
 * new host to networkAccess.devAllowedDomains in manifest.json, which Figma
 * caches, so the plugin has to be re-imported afterwards.
 */
export const HOSTED_RELAY_URL = 'wss://figsnap-relay.arimunandar-dev.workers.dev/plugin'

/**
 * A fresh install points at the hosted relay, so opening the plugin asks for an
 * account instead of failing against a local relay nobody has started yet.
 */
export const DEFAULT_RELAY_URL = HOSTED_RELAY_URL

/**
 * Only a hosted relay has accounts. A local one binds to `127.0.0.1`, where
 * anything already on the machine could reach it anyway, so it asks for nothing.
 */
export function needsAccount(url: string): boolean {
  return /^wss:/i.test(url)
}
