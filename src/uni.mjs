/**
 * uni CLI wrapper and build-completion detection.
 *
 * Why we cannot rely on the stdout signal alone:
 *   the output() function in uni-cli-shared/dist/logs/index.js **swallows two
 *   consecutive identical messages** (same type + same msg returns early).
 *   During an incremental build, "DONE  Build complete." is very likely to be
 *   byte-identical to the previous round, so the signal is de-duplicated and
 *   never appears on stdout.
 *
 * This module therefore uses a dual-signal strategy:
 *   1. First full build: use the stdout "DONE  Build complete." as the gate
 *      (it is guaranteed to appear at least once).
 *   2. Later incremental builds: poll an artifact fingerprint (mtime + size of
 *      the top-level key files, plus the directory mtime). A changed fingerprint
 *      means the rebuild finished, which sidesteps the stdout de-duplication.
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** Build completion marker emitted by the uni CLI (see uni-cli-shared/dist/messages/zh_CN.js). */
export const BUILD_DONE = /DONE\s+Build complete\./
export const BUILD_FAILED = /DONE\s+Build failed\./

/**
 * Compute the artifact fingerprint.
 * Only the top-level key files and the top-level directory mtime are used, which
 * covers the three relevant scenarios:
 *   - a page change rewrites app-service.js
 *   - a static asset change updates the directory mtime
 *   - a file is added or removed, updating the directory mtime
 * The cost is one readdir plus a few stat calls (< 10ms), far cheaper than a
 * full md5 pass.
 */
export function artifactFingerprint(dir) {
  if (!existsSync(dir)) return 'missing'
  const parts = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 'unreadable'
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      const st = statSync(p)
      if (e.isDirectory()) {
        parts.push(`${e.name}/:${st.mtimeMs.toFixed(0)}`)
      } else {
        parts.push(`${e.name}:${st.mtimeMs.toFixed(0)}:${st.size}`)
      }
    } catch {
      // The file is being rewritten right now, skip it
    }
  }
  parts.sort()
  return parts.join('|')
}

/**
 * Start `uni dev` in watch mode.
 *
 * @param {object} opts
 * @param {string} opts.bin     path to the uni CLI
 * @param {string} opts.cwd     project directory
 * @param {string[]} opts.args  arguments forwarded to uni
 * @param {boolean} opts.passthrough forward the uni stdout to the terminal
 * @param {(line:string)=>void} [opts.onLine]
 */
export function startUni(opts) {
  const { bin, cwd, args, passthrough = true, env = process.env } = opts

  const child = spawn(process.execPath, [bin, ...args], {
    cwd,
    stdio: ['inherit', 'pipe', 'pipe'],
    env: {
      ...env,
      // The first full build is memory hungry, 4G and up is safer
      NODE_OPTIONS: env.NODE_OPTIONS || '--max-old-space-size=6144',
    },
  })

  let buffer = ''
  let sawDone = false
  let sawFailed = false
  /** Additional line listeners (registered by waitFirstBuild) */
  const listeners = new Set()

  const handle = (chunk) => {
    const text = chunk.toString()
    buffer += text
    let idx
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (passthrough) process.stdout.write(line + '\n')
      opts.onLine?.(line)
      if (BUILD_FAILED.test(line)) sawFailed = true
      if (BUILD_DONE.test(line)) sawDone = true
      for (const fn of listeners) fn(line)
    }
  }

  child.stdout.on('data', handle)
  child.stderr.on('data', handle)

  return {
    child,
    /** Whether the build completion signal has been seen (stdout based, only reliable the first time). */
    get sawDone() {
      return sawDone
    },
    get sawFailed() {
      return sawFailed
    },
    /** Wait for the first build completion signal; reject on failure or process exit. */
    waitFirstBuild(timeoutMs = 15 * 60 * 1000) {
      return new Promise((resolve, reject) => {
        if (sawDone) return resolve()
        if (sawFailed) return reject(new Error('The uni CLI reported a build failure'))
        const timer = setTimeout(() => {
          cleanup()
          reject(new Error(`Timed out waiting for the first build to complete (${Math.round(timeoutMs / 1000)}s)`))
        }, timeoutMs)
        const onLine = (line) => {
          if (BUILD_FAILED.test(line)) {
            cleanup()
            reject(new Error('The uni CLI reported a build failure'))
          } else if (BUILD_DONE.test(line)) {
            cleanup()
            resolve()
          }
        }
        const onExit = (code) => {
          cleanup()
          reject(new Error(`The uni CLI process exited (exit code ${code})`))
        }
        function cleanup() {
          clearTimeout(timer)
          listeners.delete(onLine)
          child.off('exit', onExit)
        }
        listeners.add(onLine)
        child.once('exit', onExit)
      })
    },
    stop() {
      try {
        child.kill('SIGTERM')
      } catch {}
    },
  }
}

/**
 * Wait for the artifacts to change and then **settle** (debounce).
 *
 * Why debouncing is needed: a single build writes to disk in several rounds
 *   (app-service.js lands first, then app-config.js and the static assets
 *   follow), so the fingerprint changes multiple times. Syncing and refreshing
 *   on every change would cause several pointless syncs and page reloads for a
 *   single edit.
 *
 * Why a time window rather than "unchanged for N polls":
 *   the poll interval is fixed, so if two write rounds are further apart than
 *   the interval, a counter-based approach would wrongly declare the build
 *   stable halfway through. Requiring the fingerprint to stay unchanged for
 *   `stableMs` matches the real build duration much better.
 *
 * Strategy: first wait until the fingerprint differs from the baseline (there
 *   is an update), then wait until it stays unchanged for `stableMs` (writing
 *   has finished), and only then consider the build complete.
 *
 * @param {string} dir artifact directory
 * @param {string} baseline initial fingerprint
 * @param {object} opts
 * @param {number} opts.intervalMs  poll interval
 * @param {number} opts.stableMs     how long the fingerprint must stay unchanged
 * @param {number} opts.maxSettleMs  upper bound on the settle wait (prevents a hang)
 * @param {number} opts.timeoutMs    overall timeout
 * @returns {Promise<string>} the settled fingerprint
 */
export function waitForStableChange(dir, baseline, opts = {}) {
  const {
    intervalMs = 400,
    stableMs = 1000,
    maxSettleMs = 15_000,
    timeoutMs = 10 * 60 * 1000,
    onPoll,
  } = opts

  return new Promise((resolve, reject) => {
    const started = Date.now()
    let changed = false
    let lastFp = baseline
    let stableSince = 0

    const timer = setInterval(() => {
      const now = Date.now()
      const fp = artifactFingerprint(dir)
      onPoll?.(fp)

      if (fp === 'missing') {
        // The artifact directory is temporarily unreadable (while writing), skip
        return
      }

      if (fp !== lastFp) {
        // The fingerprint changed again -> writing is still ongoing, reset the timer
        lastFp = fp
        changed = true
        stableSince = 0
      } else if (changed) {
        if (stableSince === 0) stableSince = now
        // The fingerprint has been unchanged for stableMs -> the build is really done
        if (now - stableSince >= stableMs) {
          clearInterval(timer)
          resolve(fp)
          return
        }
      }

      // It keeps changing (extreme case): after maxSettleMs accept the current
      // fingerprint so that we never hang forever
      if (changed && now - started > maxSettleMs) {
        clearInterval(timer)
        resolve(fp)
        return
      }

      if (now - started > timeoutMs) {
        clearInterval(timer)
        reject(new Error('Timed out waiting for the artifacts to update'))
      }
    }, intervalMs)
  })
}
