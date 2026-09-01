// The relay this build talks to.
//
// Both sandboxes need it — the main thread for a fresh install's default, the
// UI to label it — so it lives here rather than being written out twice. The
// host itself comes from shared/relay.mjs, which the agent daemon reads too:
// one address, three sandboxes, nothing to keep in step by hand.

import { HOSTED_RELAY_HTTP } from '../shared/relay.mjs'

export const HOSTED_RELAY_URL = `${HOSTED_RELAY_HTTP.replace(/^http/, 'ws')}/plugin`

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
