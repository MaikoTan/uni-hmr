/**
 * Project and device-side discovery.
 *
 * Design goal: zero configuration. The package name can be resolved from the
 * device by appid, and the artifact directory is derived following the uni CLI
 * convention (dist/dev/<platform>).
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { assertAppid, assertPackageName, shellQuote } from './validate.mjs'

/** Entry point of the uni CLI inside the @dcloudio/vite-plugin-uni package. */
const UNI_ENTRY = '@dcloudio/vite-plugin-uni/bin/uni.js'

/**
 * Locate the **real JS entry point** of the uni CLI.
 *
 * Why we cannot use `node_modules/.bin/uni` directly:
 *   - Linux/macOS: `.bin/uni` is a symlink -> `node <symlink>` resolves to the
 *     real JS file correctly. OK
 *   - Windows: Yarn/npm write a **shell shim script** into `.bin/`
 *     (`@SET PATHEXT=...` or `#!/bin/sh`); `node <shim>` parses it as JS and
 *     crashes with a syntax error. BROKEN
 *   So we prefer `require.resolve` to get the actual .js file inside the package.
 *
 * @dcloudio/vite-plugin-uni declares no `exports` field and is CommonJS, so
 * resolving the sub-path '@dcloudio/vite-plugin-uni/bin/uni.js' is legal.
 */
export function findUniEntry(cwd) {
  let dir = path.resolve(cwd)
  for (;;) {
    // require.resolve must be based on a file inside the current directory,
    // otherwise the normal node_modules lookup does not happen
    try {
      const req = createRequire(path.join(dir, 'package.json'))
      return req.resolve(UNI_ENTRY)
    } catch {
      // Not found at this level, keep walking up
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Resolve the uni CLI entry point.
 * Prefers the real JS entry (cross-platform safe) and falls back to the
 * `.bin/uni` shim (a symlink on Linux/macOS).
 */
export function findUniBin(cwd) {
  return findUniEntry(cwd) || findUniBinShim(cwd)
}

/** Look only inside `.bin/` (kept for tests and diagnostics). */
export function findUniBinShim(cwd) {
  let dir = path.resolve(cwd)
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'uni')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Platform -> artifact directory name (matches uni-cli-shared getPlatformDir). */
export function platformDir(platform) {
  if (platform === 'app-plus' || platform === 'app') return 'app'
  if (platform === 'app-android') return 'app-android'
  if (platform === 'app-ios') return 'app-ios'
  return platform
}

/**
 * Extract the appid from manifest.json.
 * `src/manifest.json` contains block and line comments, so it cannot be parsed
 * with JSON.parse directly. The `manifest.json` inside the dist output is strict
 * JSON, but uses the key `id` instead of `appid`.
 */
export function extractAppid(manifestPath) {
  const raw = readFileSync(manifestPath, 'utf8')
  try {
    const j = JSON.parse(raw)
    if (j.appid) return j.appid
    if (j.id) return j.id
  } catch {
    // Fall through to the regex
  }
  const m = /"appid"\s*:\s*"([^"]+)"/.exec(raw) || /"id"\s*:\s*"(__UNI__[^"]+)"/.exec(raw)
  return m ? m[1] : null
}

/** Find the project manifest: `src/manifest.json` is preferred. */
export function findManifest(cwd) {
  for (const rel of ['src/manifest.json', 'manifest.json']) {
    const p = path.join(cwd, rel)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Reverse-lookup the package name for an appid from the device.
 * An installed app leaves a directory behind at
 * /storage/emulated/0/Android/data/<pkg>/apps/<appid>.
 */
export function lookupPackageByAppid(adb, appid) {
  assertAppid(appid)
  const out = adb.shell(
    `ls -d /storage/emulated/0/Android/data/*/apps/${shellQuote(appid)} 2>/dev/null || true`
  )
  const hits = []
  for (const raw of out.split('\n')) {
    const p = raw.trim()
    if (!p) continue
    // /storage/emulated/0/Android/data/<pkg>/apps/<appid> -> take the segment after "data"
    const segs = p.split('/')
    const dataIdx = segs.indexOf('data')
    const pkg = dataIdx !== -1 ? segs[dataIdx + 1] : segs[segs.length - 3]
    if (pkg) hits.push(pkg)
  }
  return [...new Set(hits)]
}

/** Device-side www resource directory. */
export function deviceWwwDir(pkg, appid) {
  assertPackageName(pkg)
  assertAppid(appid)
  return `/storage/emulated/0/Android/data/${pkg}/apps/${appid}/www`
}

/**
 * Parse the platform argument and normalise it into arguments for the uni CLI.
 *
 * `uni-hmr app-plus`  ->  uni -p app-plus
 * `uni-hmr -p app`    ->  uni -p app
 * `uni-hmr`           ->  uni -p app-plus
 */
export function parsePlatformArg(args) {
  const out = [...args]

  // 1) Explicit -p / --platform
  const idx = out.findIndex((a) => a === '-p' || a === '--platform')
  if (idx !== -1) {
    const value = out[idx + 1]
    if (value && !value.startsWith('-')) {
      return { platform: value, args: out }
    }
  }

  // 2) Bare platform name
  const bareIdx = out.findIndex(
    (a) => !a.startsWith('-') && /^(app|app-plus|app-android|app-ios)$/.test(a)
  )
  if (bareIdx !== -1) {
    const platform = out[bareIdx]
    out.splice(bareIdx, 1)
    out.push('-p', platform)
    return { platform, args: out }
  }

  // 3) Default
  out.push('-p', 'app-plus')
  return { platform: 'app-plus', args: out }
}
