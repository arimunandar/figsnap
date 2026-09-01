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

/**
 * The agent daemon, which is a different thing on a different port: `npm run
 * agent` on the designer's own machine, holding an ACP client for whichever
 * coding harness they already have installed. 3055 is left to the relay.
 *
 * A fixed port rather than a range because `ws://localhost:*` is undocumented
 * and user reports say it does not work, so the manifest has to name one.
 */
export const AGENT_URL = 'ws://localhost:3056/panel'
