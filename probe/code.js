// Main thread of the throwaway probe.
//
// Two runtimes can be torn down independently: this one and the UI iframe that
// holds the socket. So this thread stamps its own boot and beats a heartbeat at
// the UI, which forwards both over the socket. A main thread that restarts
// shows up as a new mainBoot; a UI thread that restarts shows up as a new
// socket. Neither is inferred from the other.

var MAIN_BOOT = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
var startedAt = Date.now()

figma.showUI(__html__, { width: 380, height: 260, title: 'Runtime probe' })

function beat() {
  figma.ui.postMessage({
    type: 'main-beat',
    mainBoot: MAIN_BOOT,
    mainUptimeMs: Date.now() - startedAt,
    at: Date.now(),
  })
}

beat()
setInterval(beat, 5000)

figma.ui.onmessage = function (message) {
  // The UI cannot see the main thread's console, and the main thread cannot see
  // the network. Anything the UI wants recorded about this side comes through here.
  if (message && message.type === 'want-beat') beat()
  if (message && message.type === 'stop') figma.closePlugin()
}
