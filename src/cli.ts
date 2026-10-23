/**
 * uni-hmr main flow.
 *
 * A single command does the whole loop: start `uni dev` watch -> detect the
 * rebuild -> sync the artifacts to the device -> trigger the runtime refresh
 * -> verify through CDP.
 *
 * Sub-commands:
 *   watch (default)  the complete HMR loop
 *   doctor           environment pre-flight check
 *   sync             sync once (does not start uni)
 *   forward          only establish the port forwards
 *   probe            CDP probe, checks whether the marker is present
 *   trigger          only send one refresh command
 *   launch           cold start the app, optionally landing on --page
 */
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import {
  createAdb,
  findAdb,
  formatDeviceList,
  listDevices,
  resolveDevice,
  adbConnect,
  adbPair,
  deviceScope,
  isWirelessSerial,
} from './adb'
import type { Adb, DeviceInfo } from './adb'
import {
  diffManifest,
  localManifest,
  pushFullTar,
  pushIncremental,
  readManagedManifest,
  remoteManifest,
  removeRemote,
  stateKey,
  statePath,
  writeManagedManifest,
} from './sync'
import {
  findManifest,
  findUniBin,
  extractAppid,
  lookupPackageByAppid,
  deviceWwwDir,
  platformDir,
  parsePlatformArg,
} from './project'
import { artifactFingerprint, startUni, waitForStableChange } from './uni'
import {
  DEFAULT_CMD,
  captureDomSignature,
  forwardCdp,
  forwardMiniServer,
  formatProbeResults,
  launchApp,
  navigateToPage,
  removeForwards,
  trigger,
  waitForAppPid,
  waitForAppReady,
  waitForMarker,
  MINISERVER_PORT,
} from './trigger'
import type { DomBaseline, ProbeResult } from './trigger'
import { acquireLock } from './lock'
import { assertAppid, assertPackageName, buildPageUrl, shellQuote, splitPageUrl } from './validate'

const CDP_PORT = 19222

function log(...args: unknown[]): void {
  console.log('[uni-hmr]', ...args)
}

export interface CliOptions {
  serial?: string
  connect?: string
  pair?: string
  pairCode?: string
  pkg?: string
  appid?: string
  cmd: string
  cdpPort: number
  markers: string[]
  page?: string
  query?: string
  noTrigger: boolean
  noProbe: boolean
  full: boolean
  help: boolean
  version: boolean
  rest: string[]
}

/**
 * 读取自身 package.json 的版本号。
 *
 * 打包后 dist/uni-hmr.mjs 与源码 src/cli.ts 都位于包根目录下一层，
 * 所以 `../package.json` 在两种形态下都指向同一个文件。
 */
export function packageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  return (JSON.parse(raw) as { version: string }).version
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    serial: process.env.UNI_HMR_SERIAL || undefined,
    connect: process.env.UNI_HMR_CONNECT || undefined,
    pair: process.env.UNI_HMR_PAIR || undefined,
    pairCode: process.env.UNI_HMR_PAIR_CODE || undefined,
    pkg: process.env.PKG || undefined,
    appid: process.env.APPID || undefined,
    cmd: process.env.CMD || DEFAULT_CMD,
    cdpPort: Number(process.env.CDP_PORT || CDP_PORT),
    markers: (process.env.MARK || 'HMRMARK')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    page: process.env.PAGE || undefined,
    query: process.env.QUERY || undefined,
    noTrigger: false,
    noProbe: false,
    full: false,
    help: false,
    version: false,
    rest: [],
  }
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--serial') opts.serial = argv[++i]
    else if (a === '--connect') opts.connect = argv[++i]
    else if (a === '--pair') opts.pair = argv[++i]
    else if (a === '--pair-code') opts.pairCode = argv[++i]
    else if (a === '--pkg') opts.pkg = argv[++i]
    else if (a === '--appid') opts.appid = argv[++i]
    else if (a === '--cmd') opts.cmd = argv[++i]
    else if (a === '--cdp-port') opts.cdpPort = Number(argv[++i])
    else if (a === '--mark')
      opts.markers = argv[++i]!
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (a === '--page') opts.page = argv[++i]
    else if (a === '--query') opts.query = argv[++i]
    else if (a === '--no-trigger') opts.noTrigger = true
    else if (a === '--no-probe') opts.noProbe = true
    else if (a === '--full') opts.full = true
    else if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--version' || a === '-v' || a === '-V') opts.version = true
    else rest.push(a)
  }
  opts.rest = rest
  return opts
}

function usage(): void {
  console.log(`
uni-hmr - hot update tool for uni-app development (auto sync to a device + runtime refresh)

Usage:
  uni-hmr [platform] [options]      the platform defaults to app-plus
  uni-hmr watch [options]
  uni-hmr launch [options]          cold start the app, optionally on --page

Options:
  --serial <SERIAL>   target device (required when several devices are connected)
  --connect <HOST:PORT>  connect a wireless device before running (adb connect)
  --pair <HOST:PORT>     pair with a wireless device (adb pair)
  --pair-code <CODE>     the pairing code shown on the device screen
  --pkg <PACKAGE>     application package name (resolved from the appid on the device by default)
  --appid <APPID>     appid (read from src/manifest.json by default)
  --cmd <CMD>         refresh command (default ${DEFAULT_CMD})
  --cdp-port <PORT>   CDP port (default ${CDP_PORT})
  --mark <A,B>        probe markers, comma separated (default HMRMARK)
  --page <PATH[?Q]>   run to a specific page, e.g. pages/index/index or /pages/a/b?id=42
  --query <A=1&B=2>   extra page parameters, appended to the query of --page
  --no-trigger        do not send the refresh command after a sync
  --no-probe          do not run the CDP verification after a refresh
  --full              force a full tar sync (the default is a full sync first, then md5 diffing)
  -v, --version       print the version
  -h, --help          print this help

Sub-commands:
  doctor    environment pre-flight check
  sync      sync once
  forward   establish the port forwards only
  probe     CDP probe
  trigger   send one refresh command only
  launch    cold start the app, optionally landing on --page

Only one process at a time may work on a device: the second one exits with an
error, because two processes would fight over the same managed manifest and
delete each other's files on the device.

Wireless debugging (ADB over TCP/IP) is supported. The device is then addressed
by its transport serial (host:port), for example --serial 192.0.2.55:5555.
`)
}

/**
 * Register the cleanup hook that removes the port forwards on exit.
 *
 * `adb forward` creates a **local listener**. If the tool exits without
 * removing them, any process on the machine can connect to 127.0.0.1:19222
 * and execute arbitrary JS inside the app's WebView through CDP (which can
 * read the login state and the cookies), and port 13131 allows sending snc
 * commands directly.
 *
 * @param beforeExit extra teardown on a signal (for example stopping uni dev)
 * @returns an idempotent cleanup function
 */
function registerCleanup(adb: Adb, cdpPort: number, beforeExit?: () => void): () => void {
  let done = false
  const cleanup = (): void => {
    if (done) return
    done = true
    removeForwards(adb, [MINISERVER_PORT, cdpPort])
  }
  process.on('exit', cleanup)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      beforeExit?.()
      cleanup()
      process.exit(0)
    })
  }
  return cleanup
}

export interface ProjectContext {
  bin: string | null
  appid: string
  platform: string
  uniArgs: string[]
  outDir: string
  manifestPath: string | null
}

/**
 * Resolve the project context.
 *
 * @param needBin require the uni CLI (only the watch loop builds)
 */
function resolveContext(
  opts: CliOptions,
  cwd: string,
  { needBin = true }: { needBin?: boolean } = {}
): ProjectContext {
  const bin = findUniBin(cwd)
  if (!bin && needBin) {
    throw new Error(
      `The uni CLI was not found. Run this command inside a project that has @dcloudio/vite-plugin-uni installed,\n` +
        `  or install the dependencies of that project first.`
    )
  }

  const manifestPath = findManifest(cwd)
  const appid = opts.appid || (manifestPath ? extractAppid(manifestPath) : null)
  if (!appid) {
    throw new Error(
      `Could not resolve an appid from ${manifestPath || 'src/manifest.json'}. Use --appid to set it manually.`
    )
  }
  assertAppid(appid)

  const { platform, args: uniArgs } = parsePlatformArg(opts.rest)
  const outDir = path.join(cwd, 'dist', 'dev', platformDir(platform))

  return { bin, appid, platform, uniArgs, outDir, manifestPath }
}

export interface DeviceSetup {
  device: DeviceInfo
  adb: Adb
  scope: string
}

/**
 * Resolve the target device, and connect / pair first when asked to.
 *
 * The wireless helpers run before the device resolution, because a wireless
 * device is not in the device list until `adb connect` succeeded.
 *
 * `scope` is the stable identity of the device (the hardware serial), under
 * which the managed manifest and the device lock are stored. It is the same
 * for a device reached over USB and over Wi-Fi.
 */
function setupDevice(opts: CliOptions): DeviceSetup {
  const adbPath = findAdb()

  if (opts.pair) {
    const r = adbPair(adbPath, opts.pair, opts.pairCode)
    if (!r.ok) throw new Error(`The wireless pairing failed.\n  ${r.message}`)
    log(`Paired with ${opts.pair}`)
  }

  if (opts.connect) {
    const r = adbConnect(adbPath, opts.connect)
    if (!r.ok) throw new Error(`The wireless connection failed.\n  ${r.message}`)
    log(`Connected to ${opts.connect}`)
    // The wireless transport serial is the address itself
    if (!opts.serial) opts.serial = opts.connect
  }

  const devices = listDevices(adbPath)
  const device = resolveDevice(adbPath, opts.serial, devices)
  const adb = createAdb(adbPath, device.serial)
  const scope = deviceScope(adbPath, device, devices.online)
  return { device, adb, scope }
}

/** Resolve the target package name: explicit option > reverse lookup on the device > error listing the candidates. */
function resolvePackage(adb: Adb, opts: CliOptions, appid: string): string {
  if (opts.pkg) return assertPackageName(opts.pkg)
  const hits = lookupPackageByAppid(adb, appid)
  if (hits.length === 1) return assertPackageName(hits[0])
  if (hits.length > 1) {
    throw new Error(
      `The appid ${appid} matches several installed applications:\n` +
        hits.map((h) => `  - ${h}`).join('\n') +
        `\n  Use --pkg <PACKAGE> to pick one.`
    )
  }
  throw new Error(
    `No installed application matches the appid ${appid}.\n` +
      `  Make sure the target app is installed and has been started at least once, or set --pkg <PACKAGE> manually.`
  )
}

export type SyncStat =
  | { mode: 'full'; ms: number; files: number }
  | { mode: 'noop'; changed: number; removed: number }
  | { mode: 'incremental'; changed: number; removed: number; ms: number }

/**
 * Sync the artifacts to the device. Returns the sync statistics.
 *
 * ★Deletion policy: besides the dist artifacts, the www directory on the device
 *   also holds the utssdk sources that the UTS compiler writes under
 *   uni_modules (they are not in dist but are required at runtime).
 *   So only the files recorded in the **managed manifest** that no longer exist
 *   locally are deleted, everything else is kept.
 */
async function syncArtifacts(
  adb: Adb,
  ctx: ProjectContext,
  pkg: string,
  { full = false, scope }: { full?: boolean; scope?: string } = {}
): Promise<SyncStat> {
  const localRoot = ctx.outDir
  if (!existsSync(localRoot)) {
    throw new Error(
      `The artifact directory does not exist: ${localRoot}\n  Make sure the first build of uni dev has finished.`
    )
  }
  const remoteDir = deviceWwwDir(pkg, ctx.appid)
  adb.shell(`mkdir -p ${shellQuote(remoteDir)}`)

  const local = localManifest(localRoot)
  const stateFile = statePath(scope || adb.serial, pkg, ctx.appid)
  const managed = readManagedManifest(stateFile)

  if (full) {
    log('Full sync (tar the artifacts -> push -> unpack on the device)…')
    const t0 = Date.now()
    await pushFullTar(adb, localRoot, remoteDir)
    writeManagedManifest(stateFile, [...local.keys()])
    return { mode: 'full', ms: Date.now() - t0, files: local.size }
  }

  log('Computing the local md5 manifest…')
  const remote = await remoteManifest(adb, remoteDir)
  const { changed } = diffManifest(local, remote)

  // Only clean up the files of the managed manifest that no longer exist locally
  const localSet = new Set(local.keys())
  const removed = managed.filter((f) => !localSet.has(f))

  if (!changed.length && !removed.length) {
    // The managed manifest may not exist yet (first incremental run), still
    // write it so that the later cleanups are safe
    if (managed.length === 0) {
      writeManagedManifest(stateFile, [...local.keys()])
    }
    log('The artifacts did not change, skipping the sync')
    return { mode: 'noop', changed: 0, removed: 0 }
  }

  const t0 = Date.now()
  if (changed.length) {
    log(`Pushing ${changed.length} changed files…`)
    pushIncremental(adb, localRoot, remoteDir, changed)
  }
  if (removed.length) {
    log(`Removing ${removed.length} stale files…`)
    removeRemote(adb, remoteDir, removed)
  }
  // Update the managed manifest
  const nextManaged = [...new Set([...managed.filter((f) => localSet.has(f)), ...changed])]
  writeManagedManifest(stateFile, nextManaged)
  return {
    mode: 'incremental',
    changed: changed.length,
    removed: removed.length,
    ms: Date.now() - t0,
  }
}

/**
 * CDP probe: confirm that the DOM really was updated.
 *
 * The forward is re-established on every attempt, because the weex restart
 * changes the app pid and therefore the devtools socket.
 *
 * `baseline` is the DOM signature captured before the refresh. A hit on a
 * DOM that is still identical to the baseline is a stale hit and is rejected.
 */
async function runProbe(
  adb: Adb,
  pkg: string,
  opts: CliOptions,
  baseline: DomBaseline | null = null
): Promise<{ hit: boolean; results: ProbeResult[]; fresh: boolean }> {
  const { hit, results, fresh } = await waitForMarker(opts.cdpPort, opts.markers, {
    baseline,
    onAttempt: () => {
      forwardCdp(adb, pkg, opts.cdpPort)
    },
  })
  for (const line of formatProbeResults(results)) console.log(line)
  return { hit, results, fresh }
}

async function cmdDoctor(opts: CliOptions, cwd: string): Promise<void> {
  const adbPath = findAdb()
  log(`adb: ${adbPath}`)

  // The wireless options have to run first, otherwise a device that is not
  // connected yet would not be in the list
  if (opts.pair) {
    const r = adbPair(adbPath, opts.pair, opts.pairCode)
    if (!r.ok) throw new Error(`The wireless pairing failed.\n  ${r.message}`)
    log(`Paired with ${opts.pair}`)
  }
  if (opts.connect) {
    const r = adbConnect(adbPath, opts.connect)
    if (!r.ok) throw new Error(`The wireless connection failed.\n  ${r.message}`)
    log(`Connected to ${opts.connect}`)
    if (!opts.serial) opts.serial = opts.connect
  }

  const { online, offline } = listDevices(adbPath)
  log(`Online devices (${online.length}):`)
  console.log(formatDeviceList(online) || '  (none)')
  if (offline.length) {
    log(`Unusual devices (${offline.length}):`)
    console.log(formatDeviceList(offline))
  }
  const wireless = online.filter((d) => isWirelessSerial(d.serial)).length
  if (wireless) log(`Wireless devices: ${wireless} of ${online.length}`)

  const ctx = resolveContext(opts, cwd)
  log(`uni CLI: ${ctx.bin}`)
  log(`Platform: ${ctx.platform}  Artifact directory: ${ctx.outDir}`)
  log(`appid: ${ctx.appid}  (${ctx.manifestPath})`)
  log(`Artifacts exist: ${existsSync(ctx.outDir)}`)

  const device = resolveDevice(adbPath, opts.serial, { online, offline })
  const adb = createAdb(adbPath, device.serial)
  const scope = deviceScope(adbPath, device, online)
  log(`Target device: ${device.serial}  identity: ${scope}`)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  log(`Target package: ${pkg}`)
  log(`Device www directory: ${deviceWwwDir(pkg, ctx.appid)}`)
  log(
    `www exists: ${
      adb.shell(
        `ls -d ${shellQuote(deviceWwwDir(pkg, ctx.appid))} 2>/dev/null || echo missing`
      ) !== 'missing'
    }`
  )
  log(`Markers: ${opts.markers.join(', ')}`)
  log(`Refresh command: ${opts.cmd}`)
}

async function cmdSync(opts: CliOptions, cwd: string): Promise<void> {
  const { adb, scope } = setupDevice(opts)
  const ctx = resolveContext(opts, cwd)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  // Only one process at a time may touch the managed manifest of a device
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  try {
    const stat = await syncArtifacts(adb, ctx, pkg, { scope, full: opts.full })
    log('Sync finished', JSON.stringify(stat))
  } finally {
    lock.release()
  }
}

async function cmdForward(opts: CliOptions, cwd: string): Promise<void> {
  const { adb, scope } = setupDevice(opts)
  const ctx = resolveContext(opts, cwd)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  try {
    forwardMiniServer(adb, MINISERVER_PORT)
    forwardCdp(adb, pkg, opts.cdpPort)
  } finally {
    lock.release()
  }
  // The tunnels of the forward sub-command have to stay alive (they are meant
  // for external tools), so no automatic cleanup is registered here
  log(`Forwarded: tcp:${MINISERVER_PORT} -> tcp:${MINISERVER_PORT}`)
  log(`Forwarded: tcp:${opts.cdpPort} -> app(${pkg}) webview`)
}

async function cmdTrigger(opts: CliOptions, cwd: string): Promise<void> {
  const { adb, scope } = setupDevice(opts)
  const ctx = resolveContext(opts, cwd)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  const cleanup = registerCleanup(adb, opts.cdpPort)
  try {
    forwardMiniServer(adb, MINISERVER_PORT)
    await trigger(opts.cmd, MINISERVER_PORT)
    log(`Sent: ${opts.cmd}`)
  } finally {
    cleanup()
    lock.release()
  }
}

async function cmdProbe(opts: CliOptions, cwd: string): Promise<void> {
  const { adb, scope } = setupDevice(opts)
  const ctx = resolveContext(opts, cwd)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  // The probe shares the adb port forwards with the watch loop, so it must not
  // run while a watcher owns the device (it would tear the tunnels down).
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  const cleanup = registerCleanup(adb, opts.cdpPort)
  try {
    const { hit } = await runProbe(adb, pkg, opts)
    log(hit ? '✅ marker hit' : '❌ marker not hit')
  } finally {
    cleanup()
    lock.release()
  }
}

/**
 * Cold start the app and, when --page is given, land on that page.
 *
 * This is the uni-hmr equivalent of the HBuilderX "run to page" action. The
 * native cold-start channels of the DCloud runtime (`unimp_direct_data`,
 * `unimp_run_extra_info`, `__extras__`) were all verified to be unreachable
 * from an `adb shell am start` on a real device: the runtime only honours them
 * through `plus.getRedirectInfo()`, which needs a Weex webview that the
 * service layer does not have, so `plus.runtime.arguments` is ignored. The
 * page is therefore reached through CDP after the app rendered its entry page.
 */
async function cmdLaunch(opts: CliOptions, cwd: string): Promise<void> {
  const { adb, scope } = setupDevice(opts)
  // The launch sub-command only talks to the device, it never builds, so the
  // uni CLI is not required here
  const ctx = resolveContext(opts, cwd, { needBin: false })
  const pkg = resolvePackage(adb, opts, ctx.appid)
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  const cleanup = registerCleanup(adb, opts.cdpPort)
  try {
    const url = opts.page ? buildPageUrl(opts.page, opts.query) : null
    log(`Cold starting ${pkg}…`)
    const activity = launchApp(adb, pkg)
    log(`Launcher activity: ${activity}`)

    forwardMiniServer(adb, MINISERVER_PORT)
    // The pid only exists a moment after `am start`, and the devtools socket
    // a moment after the pid
    await waitForAppPid(adb, pkg)
    forwardCdp(adb, pkg, opts.cdpPort)

    if (!url) {
      log('The app was started (no --page given, nothing to navigate to)')
      return
    }

    log('Waiting for the app to render its entry page…')
    const entry = await waitForAppReady(opts.cdpPort)
    if (!entry) {
      throw new Error(
        'The app did not render a page within the timeout.\n' +
          '  Make sure the application starts normally on its own.'
      )
    }
    log(`Entry page: ${entry.title}`)

    log(`Navigating to ${url}…`)
    const res = await navigateToPage(opts.cdpPort, url, {
      expectRoute: splitPageUrl(opts.page!).path,
    })
    if (!res.ok) throw new Error(res.message)
    log(`✅ landed on ${res.title}`)
  } finally {
    cleanup()
    lock.release()
  }
}

async function cmdWatch(opts: CliOptions, cwd: string): Promise<void> {
  const { device, adb, scope } = setupDevice(opts)
  const link = isWirelessSerial(device.serial) ? 'wireless' : 'usb'
  log(`Target device: ${device.serial} (${device.model || 'unknown model'}, ${link})`)
  if (scope !== device.serial) log(`Device identity: ${scope}`)

  const ctx = resolveContext(opts, cwd)
  const pkg = resolvePackage(adb, opts, ctx.appid)
  log(`Application package: ${pkg}  appid: ${ctx.appid}`)

  // Two watchers on the same device would fight over the same managed
  // manifest and delete each other's files on the device. The lock keeps them
  // apart: the second one refuses to start.
  const lock = acquireLock(stateKey(scope, pkg, ctx.appid))
  // The lock file has to disappear even when the process dies unexpectedly
  process.on('exit', () => lock.release())

  // 1) Start the uni dev watch
  const uniArgs = ctx.uniArgs.length ? ctx.uniArgs : ['-p', ctx.platform]
  log(`Starting uni dev watch: ${uniArgs.join(' ')}`)
  const uni = startUni({ bin: ctx.bin as string, cwd, args: uniArgs })

  const shutdown = (): void => {
    uni.stop()
    lock.release()
  }
  // Cleanup hook for the port forwards (removes the tunnels on exit, so that
  // the CDP endpoint is not left exposed on the machine)
  const cleanupForwards = registerCleanup(adb, opts.cdpPort, shutdown)

  // 2) Wait for the first build
  log('Waiting for the first build to complete…')
  await uni.waitFirstBuild()
  log('The first build is complete')

  // 3) First full sync
  forwardMiniServer(adb, MINISERVER_PORT)
  const stat = await syncArtifacts(adb, ctx, pkg, { scope, full: true })
  log(`The first sync is complete: ${JSON.stringify(stat)}`)

  // 3.5) Run-to-page: land on the requested page once the app is up
  const pageUrl = opts.page ? buildPageUrl(opts.page, opts.query) : null
  if (pageUrl) {
    log(`Run-to-page enabled: ${pageUrl}`)
    try {
      // The app has to be running (and its devtools socket up) before the page
      // can be reached, but a build alone does not restart it
      await waitForAppPid(adb, pkg, { timeoutMs: 15_000 })
      forwardCdp(adb, pkg, opts.cdpPort)
      log('Waiting for the app to render its entry page…')
      const entry = await waitForAppReady(opts.cdpPort)
      if (!entry) {
        log('⚠️  the app did not render a page in time; continuing without run-to-page')
      } else {
        log(`Entry page: ${entry.title}`)
        const res = await navigateToPage(opts.cdpPort, pageUrl, {
          expectRoute: splitPageUrl(opts.page!).path,
        })
        if (res.ok) log(`✅ landed on ${res.title}`)
        else log(`⚠️  ${res.message}`)
      }
    } catch (e) {
      log(`⚠️  run-to-page skipped: ${(e as Error).message}`)
    }
  }

  // 4) Trigger the refresh + probe
  if (!opts.noTrigger) {
    await trigger(opts.cmd, MINISERVER_PORT)
    log('The runtime refresh has been triggered')
  }
  if (!opts.noProbe) {
    try {
      const { hit } = await runProbe(adb, pkg, opts)
      log(
        hit
          ? '✅ marker hit'
          : '⚠️ marker not hit (after the first build the page may not show the marker yet)'
      )
    } catch (e) {
      log(`The probe failed (this does not break the HMR loop): ${(e as Error).message}`)
    }
  }

  // 5) Incremental loop: poll the artifact fingerprint (wait for a change and
  //    for it to settle, so that a single edit does not trigger several refreshes)
  log('Watching for changes (Ctrl+C to quit)…')
  let baseline = artifactFingerprint(ctx.outDir)
  for (;;) {
    let next
    try {
      next = await waitForStableChange(ctx.outDir, baseline, { intervalMs: 400 })
    } catch (e) {
      log((e as Error).message)
      break
    }
    baseline = next

    const t0 = Date.now()
    try {
      const s = await syncArtifacts(adb, ctx, pkg, { scope, full: opts.full })
      log(`Sync: ${JSON.stringify(s)}`)

      // Do not refresh the page when the artifacts did not really change
      // (this avoids a pointless view reload)
      if (s.mode === 'noop') continue

      if (!opts.noTrigger) {
        // Capture the DOM signature before the refresh, so that a stale hit
        // (the old page WebView that is still alive during the restart) is
        // not mistaken for a successful update.
        let baseline: DomBaseline | null = null
        if (!opts.noProbe) {
          try {
            forwardCdp(adb, pkg, opts.cdpPort)
            baseline = await captureDomSignature(opts.cdpPort, opts.markers)
          } catch {
            // No baseline available -> the hit is accepted as is
          }
        }
        await trigger(opts.cmd, MINISERVER_PORT)
        log(`Refresh triggered (${Date.now() - t0}ms)`)
        if (!opts.noProbe) {
          try {
            const { hit, fresh } = await runProbe(adb, pkg, opts, baseline)
            if (hit) log('✅ marker hit')
            else if (fresh) log('✅ the view was updated (the marker is gone, the DOM changed)')
            else log('⚠️ marker not hit (the view was not updated)')
          } catch {
            // A failing probe does not block the loop
          }
        }
      } else if (!opts.noProbe) {
        try {
          const { hit } = await runProbe(adb, pkg, opts)
          if (hit) log('✅ marker hit')
        } catch {
          // A failing probe does not block the loop
        }
      }
    } catch (e) {
      log(`The sync failed: ${(e as Error).message}`)
    }
  }
  shutdown()
  cleanupForwards()
}

export async function run(argv: string[]): Promise<void> {
  const opts = parseArgs(argv)
  if (opts.version) {
    console.log(packageVersion())
    return
  }
  if (opts.help) {
    usage()
    return
  }
  const cwd = process.cwd()

  // Sub-command parsing: an explicit sub-command name must not be forwarded to the uni CLI
  const sub = opts.rest[0]
  const subCommands = ['doctor', 'sync', 'forward', 'probe', 'trigger', 'launch', 'watch']
  const command = sub && subCommands.includes(sub) ? sub : 'watch'
  if (sub && subCommands.includes(sub)) {
    opts.rest = opts.rest.slice(1)
  }

  try {
    switch (command) {
      case 'doctor':
        return await cmdDoctor(opts, cwd)
      case 'sync':
        return await cmdSync(opts, cwd)
      case 'forward':
        return await cmdForward(opts, cwd)
      case 'probe':
        return await cmdProbe(opts, cwd)
      case 'trigger':
        return await cmdTrigger(opts, cwd)
      case 'launch':
        return await cmdLaunch(opts, cwd)
      case 'watch':
        return await cmdWatch(opts, cwd)
    }
  } catch (e) {
    console.error(`[uni-hmr] error: ${(e as Error).message}`)
    process.exitCode = 1
  }
}
