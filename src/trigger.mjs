/**
 * Runtime trigger and verification.
 *
 * snc command semantics (confirmed on a real device):
 *   - `snc:script debugRefresh`        -> restarts the whole weex instance,
 *                                      rebuilding service and view together.
 *                                      The ONLY path that refreshes the view DOM.
 *   - `snc:update _www/app-service.js` -> hot-swaps only the service bundle.
 *                                      The process is not restarted and the
 *                                      uni-app v3 view webview does not
 *                                      re-render, so the DOM stays stale.
 *   - `snc:update all`                 -> reloads only the view webview while
 *                                      the service was not restarted, which
 *                                      yields a blank view.
 *   - `snc:update current`             -> reloads only the first webview,
 *                                      which is likewise unusable.
 *
 * Key constraint: the command must be a **bare string with no trailing
 * newline** - the device matches it exactly with PdrUtil.isEquals, so a
 * trailing \r\n makes the branch fail to match.
 */
import http from 'node:http'
import net from 'node:net'
import { assertPackageName, shellQuote } from './validate.mjs'

/** A CDP target title of a real uni-app page WebView, e.g. `pages/index/index[2]`. */
const PAGE_TARGET_RE = /^pages\//

export const MINISERVER_PORT = 13131
export const DEFAULT_CMD = 'snc:script debugRefresh'

/** adb options that silence the output of a best-effort `forward --remove`. */
const QUIET = { stdio: ['ignore', 'ignore', 'ignore'] }

/**
 * Establish the mini server port forward. The app pid changes after a
 * restart, so this has to be re-run.
 */
export function forwardMiniServer(adb, port = MINISERVER_PORT) {
  try {
    adb.forward(['--remove', `tcp:${port}`], QUIET)
  } catch {
    // The port does not exist on the first run, ignore
  }
  adb.forward([`tcp:${port}`, `tcp:${port}`])
}

/**
 * Remove port forwards.
 *
 * Safety constraint: `adb forward` creates a **local listener**. Once
 *   `tcp:19222 -> localabstract:webview_devtools_remote_<pid>` is established,
 *   any process on the machine can connect to 127.0.0.1:19222 and execute
 *   arbitrary JS inside the app's WebView via CDP (reading the login state and
 *   cookies), and port 13131 allows sending snc commands directly. If the tool
 *   exits without removing them, the tunnels stay around until the adb server
 *   restarts.
 */
export function removeForwards(adb, ports = [MINISERVER_PORT, 19222]) {
  for (const port of ports) {
    try {
      adb.forward(['--remove', `tcp:${port}`], QUIET)
    } catch {
      // The port was not established, or adb is unavailable, ignore
    }
  }
}

/**
 * Send an snc command (bare string, no trailing newline).
 */
export function trigger(cmd, port = MINISERVER_PORT, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(port, '127.0.0.1', () => {
      sock.write(cmd)
    })
    let done = false
    const finish = (err) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {}
      err ? reject(err) : resolve()
    }
    sock.on('close', () => finish())
    sock.on('error', (e) => finish(new Error(`Cannot connect to the device mini server (127.0.0.1:${port}): ${e.message}`)))
    setTimeout(() => finish(), timeoutMs)
  })
}

/**
 * Get the pid of the app process, or null when it is not running.
 *
 * `pidof` exits non-zero when nothing matches, so the failure has to be
 * swallowed here: right after a cold start the process simply does not exist
 * yet and that is not an error.
 */
export function appPid(adb, pkg) {
  assertPackageName(pkg)
  let p
  try {
    p = adb.shell(`pidof ${shellQuote(pkg)}`)
  } catch {
    return null
  }
  return p ? p.split(/\s+/)[0] : null
}

/**
 * Wait until the app process is up after a cold start.
 *
 * `am start` returns before the process is created, so a `pidof` right after
 * it is normally empty. The CDP forward needs the pid, hence the wait.
 *
 * @param {object} adb
 * @param {string} pkg
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.intervalMs]
 * @returns {Promise<string>} the pid
 */
export async function waitForAppPid(adb, pkg, opts = {}) {
  const { timeoutMs = 20_000, intervalMs = 250 } = opts
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pid = appPid(adb, pkg)
    if (pid) return pid
    if (Date.now() >= deadline) {
      throw new Error(
        `The app process ${pkg} did not come up within ${timeoutMs}ms.\n` +
          `  Check that the application starts normally on the device.`
      )
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Establish the CDP forward. This needs the webview devtools socket of the
 * currently running app.
 *
 * The socket appears a little after the process itself, so the lookup is
 * retried a few times: right after a cold start the first attempt normally
 * finds nothing yet.
 *
 * @param {object} adb
 * @param {string} pkg
 * @param {number} cdpPort
 * @param {object} [opts]
 * @param {number} [opts.retries] how many times to look for the socket
 * @param {number} [opts.intervalMs] delay between two lookups
 * @returns {string} the devtools socket name
 */
export function forwardCdp(adb, pkg, cdpPort, opts = {}) {
  const { retries = 20, intervalMs = 250 } = opts
  const pid = appPid(adb, pkg)
  if (!pid) throw new Error(`The app is not running: ${pkg}`)
  let name = null
  for (let i = 0; i <= retries && !name; i++) {
    if (i > 0) sleepSync(intervalMs)
    const sockets = adb.shell('cat /proc/net/unix | grep webview_devtools_remote || true')
    name =
      sockets
        .split('\n')
        .map((l) => l.trim().split(/\s+/).pop())
        .find((s) => s && s.includes(`webview_devtools_remote_${pid}`)) || null
  }
  if (!name) throw new Error(`No webview devtools socket found for the app (${pid})`)
  try {
    adb.forward(['--remove', `tcp:${cdpPort}`], QUIET)
  } catch {}
  // Socket names in /proc/net/unix have a leading '@', adb forward needs it gone
  adb.forward([`tcp:${cdpPort}`, `localabstract:${name.replace(/^@/, '')}`])
  return name
}

/**
 * Block the current thread for a while.
 *
 * Used only by the synchronous `forwardCdp` retry loop, which cannot await.
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Cold start the app through its launcher activity.
 *
 * `am force-stop` runs first, so that the run really starts from a clean
 * process: a warm start would keep the previous page stack and the app would
 * land on whatever page it happened to be on.
 *
 * The activity is resolved on the device instead of being hardcoded, because
 * the launcher activity differs per app (`io.dcloud.PandoraEntry` for the
 * DCloud runtime, but a plain `MainActivity` for others).
 *
 * @param {object} adb an adb wrapper bound to a specific serial
 * @param {string} pkg application package name
 * @returns {string} the resolved `pkg/activity` component
 */
export function launchApp(adb, pkg) {
  assertPackageName(pkg)
  adb.shell(`am force-stop ${shellQuote(pkg)}`)
  const resolved = adb.shell(`cmd package resolve-activity --brief ${shellQuote(pkg)} | tail -n 1`).trim()
  if (!resolved.includes('/')) {
    throw new Error(
      `Could not resolve the launcher activity of ${pkg} on the device.\n` +
        `  Make sure the application is installed.`
    )
  }
  adb.shell(`am start -n ${shellQuote(resolved)}`)
  return resolved
}

/**
 * Wait until the app rendered its entry page and its DOM settled.
 *
 * Why this is needed: an app usually runs its own launch redirects after the
 * first render (a login gate, a token refresh, a splash screen). Navigating to
 * the target page before those finished would be overridden by them, so the
 * DOM signature of the entry page has to be stable first.
 *
 * @param {number} cdpPort
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] how long to keep waiting for the entry page
 * @param {number} [opts.intervalMs] delay between two polls
 * @param {number} [opts.stableRounds] how many identical signatures count as settled
 * @returns {Promise<{title: string, key: string}|null>} the entry page target, or null on timeout
 */
export async function waitForAppReady(cdpPort, opts = {}) {
  const { timeoutMs = 25_000, intervalMs = 400, stableRounds = 2 } = opts
  const deadline = Date.now() + timeoutMs
  let lastSig = null
  let stable = 0
  let lastError = null

  for (;;) {
    try {
      const targets = await listCdpTargets(cdpPort)
      const page = targets.find((t) => PAGE_TARGET_RE.test(t.title))
      if (page) {
        const r = await cdpEvaluate(page.webSocketDebuggerUrl, DOM_SIGNATURE_EXPR)
        const sig = r?.result?.value
        // An empty body means the page WebView exists but nothing was rendered
        // yet, which does not count as ready
        if (sig && sig !== '0:5381') {
          stable = sig === lastSig ? stable + 1 : 1
          lastSig = sig
          if (stable >= stableRounds) {
            return { title: page.title, key: normalizeTargetTitle(page.title) }
          }
        }
      }
      lastError = null
    } catch (e) {
      // The CDP endpoint is briefly unavailable while the app starts
      lastError = e
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  if (lastError) throw lastError
  return null
}

/**
 * Navigate the running app to a page through CDP.
 *
 * `uni.reLaunch` is used rather than `uni.navigateTo`, because "run to a page"
 * means landing on that page with a clean stack, exactly like a cold start
 * would. `navigateTo` would push the page on top of the current one and the
 * back button would return to where the app was.
 *
 * The call is fire-and-forget: the success callback of `uni.reLaunch` cannot
 * be awaited over CDP (the built-in WebSocket client does not set
 * `awaitPromise`), so the outcome is verified by watching the CDP target
 * titles instead, which also proves that the view really changed.
 *
 * @param {number} cdpPort
 * @param {string} url the target url, e.g. `/pages/index/index?a=1`
 * @param {object} [opts]
 * @param {string} [opts.expectRoute] the route the app has to end up on
 * @param {number} [opts.timeoutMs] how long to keep verifying
 * @param {number} [opts.intervalMs] delay between two polls
 * @returns {Promise<{ok: boolean, title?: string, message?: string}>}
 */
export async function navigateToPage(cdpPort, url, opts = {}) {
  const { expectRoute, timeoutMs = 15_000, intervalMs = 400 } = opts
  // The runtime reports routes without a leading slash, so `/pages/a/b` and
  // `pages/a/b` have to compare equal here
  const expected = expectRoute
    ? normalizeTargetTitle(String(expectRoute).replace(/^\/+/, ''))
    : null
  const deadline = Date.now() + timeoutMs
  let lastError = null

  for (;;) {
    try {
      const targets = await listCdpTargets(cdpPort)
      // Prefer a real page WebView: it is the one that owns the page stack.
      // The empty `View` container also exposes `uni`, but navigating from it
      // is not guaranteed to reach the page instance.
      const page = targets.find((t) => PAGE_TARGET_RE.test(t.title)) || targets[0]
      if (page) {
        const expr = `(function(){
          try {
            uni.reLaunch({ url: ${JSON.stringify(url)} })
            return 'sent'
          } catch (e) { return 'ERR: ' + e.message }
        })()`
        const r = await cdpEvaluate(page.webSocketDebuggerUrl, expr)
        const v = r?.result?.value
        if (v === 'sent') {
          // Verify that the view really moved to the expected route
          const verifyDeadline = Date.now() + timeoutMs
          for (;;) {
            try {
              const now = await listCdpTargets(cdpPort)
              const hit = now.find(
                (t) => PAGE_TARGET_RE.test(t.title) && normalizeTargetTitle(t.title) === expected
              )
              if (hit) return { ok: true, title: hit.title }
            } catch (e) {
              lastError = e
            }
            if (Date.now() >= verifyDeadline) break
            await new Promise((r2) => setTimeout(r2, intervalMs))
          }
          return {
            ok: false,
            message:
              `The navigation command was sent but the app did not land on ${expected}.\n` +
              `  Check that the page exists in pages.json and that the app did not redirect away from it.`,
          }
        }
        lastError = new Error(`The view rejected the navigation: ${v}`)
      }
    } catch (e) {
      lastError = e
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw lastError || new Error('No CDP target was reachable for the navigation')
}

/** List the CDP targets. */
export function listCdpTargets(cdpPort) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${cdpPort}/json/list`, (res) => {
        let s = ''
        res.on('data', (d) => (s += d))
        res.on('end', () => {
          try {
            resolve(JSON.parse(s))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

/** Evaluate an expression over CDP and return its value. */
export function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    // Node 22+ ships a built-in WebSocket, so no extra dependency is needed
    const WS = globalThis.WebSocket
    if (!WS) return reject(new Error('Node 22+ (built-in WebSocket) is required for the CDP probe'))
    const ws = new WS(wsUrl)
    ws.addEventListener('open', () =>
      ws.send(
        JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })
      )
    )
    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()
      const m = JSON.parse(raw)
      if (m.id === 1) {
        ws.close()
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    })
    ws.addEventListener('error', (e) => reject(new Error(e.message || 'WebSocket error')))
    ws.addEventListener('close', () => reject(new Error('The WebSocket was closed before a result arrived')))
  })
}

/**
 * The DOM signature expression, evaluated inside the WebView.
 *
 * It has to be **content based**, not only size based: the page can change
 * without its size changing (a text is replaced by a text of the same
 * length), and a size based signature would then wrongly report the DOM as
 * unchanged. A small hash over the innerHTML is cheap (a few hundred KB at
 * most) and detects any content change.
 */
const DOM_SIGNATURE_EXPR = `(function(){
  var b = document.body;
  var h = 5381, s = (b && b.innerHTML) || '';
  for (var i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return s.length + ':' + (h >>> 0);
})()`

/**
 * Normalize a CDP target title into a stable key.
 *
 * uni-app names its page WebViews `pages/index/index[1]`, where the number
 * is a counter that is incremented on every reload. The counter has to be
 * stripped, otherwise the DOM signatures of the same page could not be
 * compared before and after a refresh.
 *
 * @param {string} title
 * @returns {string}
 */
export function normalizeTargetTitle(title) {
  return String(title || '').replace(/\[\d+\]$/, '')
}

/**
 * Read the real DOM of every view WebView and check the markers.
 * The marker must be a unique string - use something like 'HMRMARK' and
 * avoid a substring that is contained in another marker (e.g. 'Laptop' is
 * contained in 'LaptopHMR2'), otherwise you get false positives.
 */
export async function probe(cdpPort, markers = [], opts = {}) {
  const { quiet = false } = opts
  const targets = await listCdpTargets(cdpPort)
  if (!targets.length) throw new Error('CDP did not report any target')
  const results = []
  for (const t of targets) {
    try {
      const expr = `JSON.stringify({
        len: (document.body && document.body.innerText || '').length,
        htmlLen: (document.body && document.body.innerHTML || '').length,
        kids: document.body ? document.body.children.length : 0,
        sig: ${DOM_SIGNATURE_EXPR},
        hit: ${JSON.stringify(markers)}.map(m => [m, ((document.body && document.body.innerText) || '').includes(m)])
      })`
      const r = await cdpEvaluate(t.webSocketDebuggerUrl, expr)
      const o = JSON.parse(r.result.value)
      results.push({ title: t.title, key: normalizeTargetTitle(t.title), ...o })
    } catch (e) {
      results.push({ title: t.title, key: normalizeTargetTitle(t.title), error: e.message })
    }
  }
  if (!quiet) {
    for (const line of formatProbeResults(results)) console.log(line)
  }
  return results
}

/** Format the probe results as human readable lines. */
export function formatProbeResults(results = []) {
  const lines = []
  for (const r of results) {
    if (r.error) {
      lines.push(`=== ${r.title} === ERR ${r.error}`)
      continue
    }
    lines.push(`=== ${r.title} === innerTextLen=${r.len} innerHTMLLen=${r.htmlLen} bodyKids=${r.kids}`)
    for (const [m, hit] of r.hit ?? []) lines.push(`   ${hit ? 'HIT ' : '--- '} ${m}`)
  }
  return lines
}

/**
 * Poll the CDP targets until one of them contains a marker.
 *
 * Why a retry is needed: `snc:script debugRefresh` restarts the weex
 *   instance, which destroys and recreates the page WebView. Right after the
 *   trigger the CDP endpoint usually only exposes the empty container target
 *   (`View`), because the page WebView does not exist yet. A single probe
 *   would therefore report a false negative even though the refresh worked.
 *
 * Why the DOM signature is compared: during the restart the **old** page
 *   WebView can still be alive for a moment and still carries the previous
 *   marker. Accepting that would report a stale hit as a successful update.
 *   A hit is therefore only accepted when the target it comes from was
 *   really rebuilt after the refresh.
 *
 * A target counts as rebuilt when
 *   - it did not exist before the refresh (a brand new page), or
 *   - its raw title changed (the reload counter of the page WebView was
 *     incremented, so the view was reloaded), or
 *   - its DOM signature changed (the content is different).
 *
 * A changed signature only counts once it is **stable**, meaning that the
 * same signature was seen in two consecutive polls. Otherwise a half loaded
 * page would be mistaken for the updated one.
 *
 * The port forward has to be re-established on every attempt: the weex
 *   restart also changes the app pid and therefore the devtools socket.
 *
 * @param {number} cdpPort
 * @param {string[]} markers
 * @param {object} opts
 * @param {number} opts.timeoutMs  how long to keep polling
 * @param {number} opts.intervalMs delay between two attempts
 * @param {number} opts.settleMs   delay before the first attempt
 * @param {Record<string,{sig: string, title: string, marked: boolean}>|null} [opts.baseline] the DOM signatures captured before the refresh
 * @param {() => void} [opts.onAttempt] called before every attempt
 * @param {Function} [opts.probeFn] the probe implementation (injectable for the tests)
 * @returns {Promise<{hit: boolean, results: object[], fresh: boolean}>}
 */
export async function waitForMarker(cdpPort, markers = [], opts = {}) {
  const {
    timeoutMs = 10_000,
    intervalMs = 500,
    settleMs = 600,
    baseline = null,
    onAttempt,
    probeFn = probe,
  } = opts

  const deadline = Date.now() + timeoutMs
  let results = []
  let lastError = null
  let prevSigs = new Map()
  let fresh = false

  for (;;) {
    try {
      onAttempt?.()
      results = await probeFn(cdpPort, markers, { quiet: true })
      lastError = null

      const curSigs = new Map()
      for (const r of results) {
        if (r.error || !r.sig) continue
        curSigs.set(r.key ?? normalizeTargetTitle(r.title), r.sig)
      }

      // A hit is only accepted when it comes from a target that was really
      // rebuilt after the refresh. The check is per target, because the empty
      // `View` container and the real page WebView are separate targets and
      // only the page one carries the marker.
      for (const r of results) {
        if (!r.hit?.some(([, h]) => h)) continue
        if (!baseline) return { hit: true, results, fresh: true }
        const key = r.key ?? normalizeTargetTitle(r.title)
        const before = baseline[key]
        // A target that did not exist before the refresh is a new page
        if (!before) return { hit: true, results, fresh: true }
        // The reload counter of the page WebView was incremented
        if (before.title !== r.title) return { hit: true, results, fresh: true }
        // The content changed and the change is stable
        if (r.sig && before.sig && before.sig !== r.sig && prevSigs.get(key) === r.sig) {
          return { hit: true, results, fresh: true }
        }
      }

      // No usable hit yet. Remember whether the view was rebuilt anyway, so
      // that a missing marker can be told apart from a failed update.
      if (baseline && !fresh) {
        for (const r of results) {
          if (r.error || !r.sig) continue
          const key = r.key ?? normalizeTargetTitle(r.title)
          const before = baseline[key]
          if (!before) continue
          if (before.title !== r.title) {
            fresh = true
            break
          }
          if (before.sig && before.sig !== r.sig && prevSigs.get(key) === r.sig) {
            fresh = true
            break
          }
        }
      }
      prevSigs = curSigs
    } catch (e) {
      // The CDP endpoint is briefly unavailable while the app restarts
      lastError = e
    }
    if (Date.now() >= deadline) break
    await new Promise((r) => setTimeout(r, results.length ? intervalMs : settleMs))
  }

  if (!results.length && lastError) throw lastError
  return { hit: false, results, fresh }
}

/**
 * Check whether the DOM of at least one target changed compared to the
 * baseline.
 *
 * @param {object[]} results the probe results
 * @param {Record<string,{sig: string, title: string}>|null} baseline
 * @returns {boolean}
 */
export function isFresh(results = [], baseline = null) {
  if (!baseline) return false
  for (const r of results) {
    if (r.error) continue
    const key = r.key ?? normalizeTargetTitle(r.title)
    const before = baseline[key]
    if (!before) continue
    if (r.sig && before.sig && before.sig !== r.sig) return true
    if (before.title !== r.title) return true
  }
  return false
}

/**
 * Capture the DOM signature of the current view WebViews.
 * Used as the baseline of waitForMarker, so that a stale DOM is not mistaken
 * for a fresh one.
 *
 * The result maps the normalized target title to `{ sig, title, marked }`, so
 * that the comparison with the probe results is done per target. The raw
 * title is kept as well, because the reload counter of a page WebView proves
 * that the view was reloaded even when the content did not change. `marked`
 * records whether the target carried one of the markers before the refresh.
 *
 * @param {number} cdpPort
 * @param {string[]} [markers] the probe markers
 * @returns {Promise<Record<string,{sig: string, title: string, marked: boolean}>|null>} the signatures, or null when no target could be read
 */
export async function captureDomSignature(cdpPort, markers = []) {
  try {
    const targets = await listCdpTargets(cdpPort)
    const sigs = {}
    for (const t of targets) {
      try {
        const expr = `JSON.stringify({
          sig: ${DOM_SIGNATURE_EXPR},
          marked: ${JSON.stringify(markers)}.some(m => ((document.body && document.body.innerText) || '').includes(m))
        })`
        const r = await cdpEvaluate(t.webSocketDebuggerUrl, expr)
        if (r?.result?.value) {
          const o = JSON.parse(r.result.value)
          sigs[normalizeTargetTitle(t.title)] = { sig: o.sig, title: t.title, marked: !!o.marked }
        }
      } catch {
        // A target that cannot be read is simply skipped
      }
    }
    return Object.keys(sigs).length ? sigs : null
  } catch {
    return null
  }
}
