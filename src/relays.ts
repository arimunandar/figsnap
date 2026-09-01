// The relay this build talks to.
//
// Both sandboxes need it — the main thread for a fresh install's default, the
// UI to label it — so it lives here rather than being written out twice.

/**
 * Change this after deploying your own: `npm run worker:deploy` prints the
 * address. It also has to be added to networkAccess.devAllowedDomains in
 * manifest.json, which Figma caches, so re-import the plugin afterwards.
 */
export const HOSTED_RELAY_URL = 'wss://figsnap-relay.arimunandar-dev.workers.dev/plugin'

export const DEFAULT_RELAY_URL = HOSTED_RELAY_URL
