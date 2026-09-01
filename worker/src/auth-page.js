// The sign-in page, served by the Worker.
//
// Auth deliberately lives in a browser rather than inside the Figma plugin: a
// real origin means password managers work, and the password never enters the
// plugin's iframe. The page hands back a token, which is the only thing the
// plugin ever stores.

export function authPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Figsnap — Account</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #19191a; --muted: #6e7781; --line: #e6e6e6;
    --code: #f6f7f9; --brand: #624cf7; --danger: #d1242f; --ok: #1a7f37; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #1e1e1e; --fg: #e6e6e6; --muted: #9a9a9f; --line: #333; --code: #262626;
      --brand: #8b7bff; --danger: #ff7b72; --ok: #3fb950; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 48px 20px; background: var(--bg); color: var(--fg);
    font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; }
  main { max-width: 30rem; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p.lead { color: var(--muted); margin: 0 0 24px; }
  .tabs { display: flex; gap: 4px; padding: 3px; margin-bottom: 16px;
    background: var(--code); border-radius: 8px; }
  .tabs button { flex: 1; padding: 8px; border: none; border-radius: 6px; background: transparent;
    color: var(--muted); font: inherit; cursor: pointer; }
  .tabs button[aria-selected="true"] { background: var(--bg); color: var(--fg); font-weight: 600; }
  label { display: block; margin: 14px 0 4px; font-size: 13px; color: var(--muted); }
  input { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px;
    background: var(--bg); color: inherit; font: inherit; }
  input:focus { outline: 2px solid var(--brand); border-color: transparent; }
  button.primary { width: 100%; margin-top: 20px; padding: 11px; border: none; border-radius: 8px;
    background: var(--brand); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.primary:disabled { opacity: 0.6; cursor: default; }
  .hint { margin-top: 10px; font-size: 13px; color: var(--muted); }
  .message { margin-top: 16px; padding: 10px 12px; border-radius: 8px; font-size: 14px; }
  .message.bad { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
  .token { margin-top: 20px; padding: 16px; border: 1px solid var(--line); border-radius: 10px;
    background: var(--code); }
  .token h2 { margin: 0 0 6px; font-size: 15px; color: var(--ok); }
  .token code { display: block; margin: 10px 0; padding: 10px; overflow-x: auto;
    background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
    font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .token ol { margin: 10px 0 0; padding-left: 20px; font-size: 14px; }
  .token li { margin: 4px 0; }
  .copy { padding: 7px 12px; border: 1px solid var(--line); border-radius: 6px;
    background: var(--bg); color: inherit; font: inherit; cursor: pointer; }
  footer { max-width: 30rem; margin: 40px auto 0; padding-top: 16px; border-top: 1px solid var(--line);
    color: var(--muted); font-size: 13px; }
  a { color: var(--brand); }
</style>
</head>
<body>
<main>
  <h1>Figsnap</h1>
  <p class="lead" id="lead">Sign in to get a token for the plugin. Each account reads only its own designs.</p>

  <div class="tabs" role="tablist">
    <button id="tab-login" role="tab" aria-selected="true">Sign in</button>
    <button id="tab-register" role="tab" aria-selected="false">Create account</button>
  </div>

  <form id="form" autocomplete="on">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required />

    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required minlength="10" />

    <button class="primary" id="submit" type="submit">Sign in</button>
    <p class="hint" id="hint">Passwords are at least 10 characters. They are never stored, only a hash.</p>
  </form>

  <div id="message" class="message" hidden></div>
  <div id="result" class="token" hidden></div>
</main>

<footer>
  This page issues tokens. It never sees a Figma file, and the relay stores no images.
  <a href="/docs">Read the docs</a>.
</footer>

<script>
  const pairCode = new URLSearchParams(location.search).get('pair')
  const state = { mode: pairCode ? 'login' : 'login' }
  const form = document.getElementById('form')
  const submit = document.getElementById('submit')
  const message = document.getElementById('message')
  const result = document.getElementById('result')
  const password = document.getElementById('password')
  const hint = document.getElementById('hint')

  function setMode(mode) {
    state.mode = mode
    document.getElementById('tab-login').setAttribute('aria-selected', String(mode === 'login'))
    document.getElementById('tab-register').setAttribute('aria-selected', String(mode === 'register'))
    submit.textContent = mode === 'login' ? 'Sign in' : 'Create account'
    password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password')
    hint.textContent = mode === 'login'
      ? 'Signing in issues a fresh token. Older tokens keep working until revoked.'
      : 'Passwords are at least 10 characters. They are never stored, only a hash.'
    message.hidden = true
    result.hidden = true
  }

  if (pairCode) {
    document.getElementById('lead').textContent =
      'Sign in or create an account to connect Figma. The plugin is waiting; you will not need to copy anything.'
  }

  document.getElementById('tab-login').addEventListener('click', () => setMode('login'))
  document.getElementById('tab-register').addEventListener('click', () => setMode('register'))

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    submit.disabled = true
    message.hidden = true
    try {
      const response = await fetch('/auth/' + state.mode, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: document.getElementById('email').value,
          password: password.value,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || ('Failed (' + response.status + ')'))
      password.value = ''
      if (pairCode) {
        const paired = await completePairing(data.token)
        showConnected(paired.email)
      } else {
        showToken(data)
      }
    } catch (error) {
      message.textContent = error.message
      message.className = 'message bad'
      message.hidden = false
    } finally {
      submit.disabled = false
    }
  })

  async function completePairing(token) {
    const response = await fetch('/auth/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-relay-token': token },
      body: JSON.stringify({ code: pairCode }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not connect Figma.')
    return data
  }

  function showConnected(email) {
    result.innerHTML = ''
    const heading = document.createElement('h2')
    heading.textContent = 'Figma connected'
    const note = document.createElement('p')
    note.style.margin = '0'
    note.style.fontSize = '14px'
    note.textContent = 'Signed in as ' + email + '. The plugin has the token already \u2014 nothing to copy. You can close this tab.'
    result.append(heading, note)
    result.hidden = false
  }

  function showToken(data) {
    const socket = location.origin.replace(/^http/, 'ws') + '/plugin'
    result.innerHTML = ''
    const heading = document.createElement('h2')
    heading.textContent = 'Signed in as ' + data.email
    const note = document.createElement('p')
    note.style.margin = '0'
    note.style.fontSize = '14px'
    note.textContent = 'This token is shown once. Copy it now.'
    const code = document.createElement('code')
    code.textContent = data.token
    const copy = document.createElement('button')
    copy.className = 'copy'
    copy.textContent = 'Copy token'
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(data.token)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Select it and press Cmd+C'
      }
    })
    const steps = document.createElement('ol')
    for (const step of [
      'Open the plugin in Figma and go to the Relay page.',
      'Address: ' + socket,
      'Token: paste what you copied.',
      'Press Save and reconnect.',
    ]) {
      const item = document.createElement('li')
      item.textContent = step
      steps.appendChild(item)
    }
    result.append(heading, note, code, copy, steps)
    result.hidden = false
  }
</script>
</body>
</html>
`
}
