// Where the hosted relay lives.
//
// Three sandboxes need it and none can import another's: the plugin's main
// thread for a fresh install's default, the panel to label it, and the agent
// daemon to run an account login against. So it is written once here rather
// than three times, because a host that drifted between them would fail in a
// way that looks like a network problem.

/**
 * Change this after deploying your own: `npm run worker:deploy` prints the
 * address. The host also has to be added to networkAccess.devAllowedDomains in
 * manifest.json, which Figma caches, so re-import the plugin afterwards.
 */
export const HOSTED_RELAY_HTTP = 'https://figsnap-relay.arimunandar-dev.workers.dev'
