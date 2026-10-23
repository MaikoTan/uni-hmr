/**
 * uni-hmr pure function unit tests.
 * Run: yarn test (node --test with the tsx loader)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, mkdirSync, existsSync, chmodSync, symlinkSync } from 'node:fs'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseDevices, formatDeviceList, resolveDevice, findAdb, isWirelessSerial, deviceScope, readPhysicalSerial, adbConnect, adbPair, createAdb, listDevices } from '../src/adb'
import { parsePlatformArg, platformDir, extractAppid, findUniEntry } from '../src/project'
import { parseRemoteManifest, diffManifest, listFiles, readManagedManifest, stateKey, statePath, writeManagedManifest, removeRemote, pushFullTar } from '../src/sync'
import { artifactFingerprint, waitForStableChange } from '../src/uni'
import type { DomBaseline } from '../src/trigger'
import { removeForwards, waitForMarker, formatProbeResults, normalizeTargetTitle, isFresh, appPid, waitForAppPid } from '../src/trigger'
import { acquireLock, hasLock, isProcessAlive, lockOwner } from '../src/lock'
import { parseArgs, packageVersion } from '../src/cli'
import { shellQuote, assertPackageName, assertAppid, assertRelPath, assertPagePath, assertPageQuery, buildPageUrl, splitPageUrl } from '../src/validate'

/** 测试用的 DOM 基线：marked 字段不参与 waitForMarker / isFresh 的判定 */
function domBaseline(sig: string, title: string): DomBaseline {
  return { 'pages/index/index': { sig, title } as any }
}

test('parseDevices parses the online / offline devices', () => {
  const out = `List of devices attached
HW00000001       device usb:1-1 product:PRODUCTX model:MODELX device:CODENAME_X
emulator-5554          offline
unauthorized-1        unauthorized
`
  const { online, offline } = parseDevices(out)
  assert.equal(online.length, 1)
  assert.equal(online[0].serial, 'HW00000001')
  assert.equal(online[0].model, 'MODELX')
  assert.equal(online[0].product, 'PRODUCTX')
  assert.equal(offline.length, 2)
})

test('parseDevices ignores the header and the empty lines', () => {
  const { online } = parseDevices('List of devices attached\n\n\n')
  assert.equal(online.length, 0)
})

test('formatDeviceList outputs the serial and the model', () => {
  const s = formatDeviceList([{ serial: 'ABC123', model: 'Pixel_5' }])
  assert.match(s, /ABC123/)
  assert.match(s, /Pixel_5/)
})

test('platformDir normalises app-plus to app', () => {
  assert.equal(platformDir('app-plus'), 'app')
  assert.equal(platformDir('app'), 'app')
  assert.equal(platformDir('app-android'), 'app-android')
  assert.equal(platformDir('h5'), 'h5')
})

test('parsePlatformArg: an explicit -p is kept as is', () => {
  const r = parsePlatformArg(['-p', 'app'])
  assert.equal(r.platform, 'app')
  assert.deepEqual(r.args, ['-p', 'app'])
})

test('parsePlatformArg: a bare platform name becomes the -p form', () => {
  const r = parsePlatformArg(['app-plus'])
  assert.equal(r.platform, 'app-plus')
  assert.deepEqual(r.args, ['-p', 'app-plus'])
})

test('parsePlatformArg: the default is app-plus', () => {
  const r = parsePlatformArg([])
  assert.equal(r.platform, 'app-plus')
  assert.deepEqual(r.args, ['-p', 'app-plus'])
})

test('extractAppid parses src/manifest.json with comments', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const p = path.join(dir, 'manifest.json')
  writeFileSync(p, `{\n  // a comment\n  "appid": "__UNI__ABCDEF",\n  "name": "x"\n}\n`)
  assert.equal(extractAppid(p), '__UNI__ABCDEF')
})

test('extractAppid parses the id of a strict JSON dist manifest.json', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const p = path.join(dir, 'manifest.json')
  writeFileSync(p, JSON.stringify({ id: '__UNI__ABCDEF', name: 'x' }))
  assert.equal(extractAppid(p), '__UNI__ABCDEF')
})

test('parseRemoteManifest parses the md5sum output', () => {
  const out = `d41d8cd98f00b204e9800998ecf8427e  ./app-service.js
0cc175b9c0f1b6a831c399e269772661  ./app-config.js
`
  const m = parseRemoteManifest(out)
  assert.equal(m.size, 2)
  assert.equal(m.get('app-service.js'), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(m.get('app-config.js'), '0cc175b9c0f1b6a831c399e269772661')
})

test('diffManifest distinguishes added / changed / extra files', () => {
  const local = new Map([
    ['a.js', 'h1'],
    ['b.js', 'h2'],
    ['new.js', 'h3'],
  ])
  const remote = new Map([
    ['a.js', 'h1'],
    ['b.js', 'OLD'],
    ['gone.js', 'h4'],
  ])
  const { changed, removed } = diffManifest(local, remote)
  assert.deepEqual(changed.sort(), ['b.js', 'new.js'])
  assert.deepEqual(removed, ['gone.js'])
})

test('listFiles collects the relative paths recursively (POSIX style)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  mkdirSync(path.join(dir, 'pages'))
  writeFileSync(path.join(dir, 'app-service.js'), 'x')
  writeFileSync(path.join(dir, 'pages', 'index.css'), 'y')
  const files = listFiles(dir).sort()
  assert.deepEqual(files, ['app-service.js', 'pages/index.css'])
})

test('artifactFingerprint changes when the content changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const target = path.join(dir, 'app-service.js')
  writeFileSync(target, 'a')
  const fp1 = artifactFingerprint(dir)
  writeFileSync(target, 'bb')
  const future = new Date(Date.now() + 5000)
  utimesSync(target, future, future)
  const fp2 = artifactFingerprint(dir)
  assert.notEqual(fp1, fp2)
})

test('artifactFingerprint returns missing when the directory does not exist', () => {
  assert.equal(artifactFingerprint('/nonexistent/path/xyz'), 'missing')
})

// ── Multi-device strategy (resolveDevice) ───────────────────────────────────

/** Build a fake adb script whose `devices -l` prints the given content. */
function mockAdb(devicesOutput: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, `#!/bin/sh\nif [ "$1" = "devices" ]; then\n  cat <<'EOF'\n${devicesOutput}\nEOF\nelse\n  exit 0\nfi\n`)
  chmodSync(p, 0o755)
  return p
}

test('resolveDevice picks the only online device automatically', () => {
  const adb = mockAdb(
    `List of devices attached\nHW00000001       device usb:1-1 model:MODELX device:CODENAME_X`
  )
  const d = resolveDevice(adb)
  assert.equal(d.serial, 'HW00000001')
  assert.equal(d.model, 'MODELX')
})

test('★with several devices it fails and lists the selectable devices', () => {
  const adb = mockAdb(
    `List of devices attached\nAAA111   device usb:1-1 model:Pixel_7 device:panther\nBBB222   device usb:1-2 model:XQ123 device:ploit`
  )
  assert.throws(
    () => resolveDevice(adb),
    (e: any) => {
      // It must report that the target device cannot be determined
      assert.match(e.message, /2 Android devices are connected/)
      // It must list the serial and the model of both devices
      assert.match(e.message, /AAA111/)
      assert.match(e.message, /Pixel_7/)
      assert.match(e.message, /BBB222/)
      assert.match(e.message, /XQ123/)
      // It must point at --serial
      assert.match(e.message, /--serial/)
      return true
    }
  )
})

test('--serial selects one of the devices when several are connected', () => {
  const adb = mockAdb(
    `List of devices attached\nAAA111   device usb:1-1 model:Pixel_7 device:panther\nBBB222   device usb:1-2 model:XQ123 device:ploit`
  )
  const d = resolveDevice(adb, 'BBB222')
  assert.equal(d.serial, 'BBB222')
  assert.equal(d.model, 'XQ123')
})

test('★a --serial device that is not online fails and lists the selectable devices', () => {
  const adb = mockAdb(
    `List of devices attached\nAAA111   device usb:1-1 model:Pixel_7 device:panther`
  )
  assert.throws(
    () => resolveDevice(adb, 'NOPE999'),
    (e: any) => {
      assert.match(e.message, /is not in the list of online devices/)
      assert.match(e.message, /AAA111/) // the selectable devices are still listed
      return true
    }
  )
})

test('with no device it fails and points at the USB debugging check', () => {
  const adb = mockAdb('List of devices attached')
  assert.throws(() => resolveDevice(adb), /No authorised Android device was detected/)
})

test('offline / unauthorized devices are not counted as online', () => {
  const adb = mockAdb(
    `List of devices attached\nCCC333   unauthorized\nDDD444   offline`
  )
  assert.throws(() => resolveDevice(adb), /No authorised Android device was detected/)
})

test('findAdb prefers the ADB environment variable', () => {
  const custom = '/custom/path/to/adb'
  // When the directory does not exist findAdb falls back, so first make sure
  // it really checks the ADB variable
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, '#!/bin/sh\n')
  chmodSync(p, 0o755)
  assert.equal(findAdb({ ADB: p, HOME: dir, ANDROID_HOME: '', ANDROID_SDK_ROOT: '' }), p)
})

test('managed manifest: it can be written and read back, and is empty when the file does not exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const f = path.join(dir, 'state.json')
  assert.deepEqual(readManagedManifest(f), [])
  writeManagedManifest(f, ['a.js', 'b.js'])
  assert.deepEqual(readManagedManifest(f), ['a.js', 'b.js'])
})

test('statePath differs per serial/pkg/appid and replaces the illegal characters', () => {
  const p = statePath('192.0.2.55:5555', 'com.x.y', '__UNI__ABC')
  // The illegal characters are encoded losslessly (':' -> '_3a_') and the hash
  // of the original string is appended
  assert.match(p, /192\.0\.2\.55_3a_5555/)
  assert.match(p, /__UNI__ABC/)
  // Different devices get different files
  assert.notEqual(p, statePath('OTHER', 'com.x.y', '__UNI__ABC'))
})

test('★safe deletion: unmanaged files (such as the UTS SDK sources) are not affected', () => {
  // Scenario: the device has an utssdk source file that is not in the dist
  // artifacts and not in the local managed manifest either
  const local = new Map([['app-service.js', 'h1']])
  const remote = new Map([
    ['app-service.js', 'h1'],
    ['uni_modules/foo/utssdk/index.uts', 'h2'], // unmanaged
  ])
  const managed = ['app-service.js'] // only the dist artifacts are managed

  const { changed } = diffManifest(local, remote)
  const localSet = new Set(local.keys())
  // Only the files of the managed manifest that no longer exist locally are cleaned up
  const removed: string[] = managed.filter((f) => !localSet.has(f))

  assert.deepEqual(changed, [])
  assert.deepEqual(removed, [] as string[])
  // The key assertion: the unmanaged utssdk file must never be in the delete list
  assert.ok(!removed.includes('uni_modules/foo/utssdk/index.uts'))
})

test('★safe deletion: a managed file that disappeared locally is cleaned up', () => {
  const local = new Map([['app-service.js', 'h1']])
  const managed = ['app-service.js', 'pages/gone.css']
  const localSet = new Set(local.keys())
  const removed: string[] = managed.filter((f) => !localSet.has(f))
  assert.deepEqual(removed, ['pages/gone.css'])
})

// ── Security: shell quoting and input validation ────────────────────────────

test('shellQuote wraps in single quotes and escapes the inner single quotes', () => {
  assert.equal(shellQuote('abc'), "'abc'")
  assert.equal(shellQuote("a'b"), `'a'\\''b'`)
  assert.equal(shellQuote('a;rm -rf /'), "'a;rm -rf /'")
})

test('★shellQuote blocks a single-quote-closing injection', () => {
  // The classic injection: close the quote and append a command
  const evil = "x'; rm -rf /storage/emulated/0; echo '"
  const quoted = shellQuote(evil)
  // It must still be one single-quoted string: every inner quote becomes '\''
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"))
  // After removing the outer quotes, the inner ' can only appear as '\''
  const inner = quoted.slice(1, -1)
  assert.ok(!inner.includes("'") || inner.includes("'\\''"))
})

test('assertPackageName rejects command injection payloads', () => {
  assert.equal(assertPackageName('com.example.myapp'), 'com.example.myapp')
  assert.equal(assertPackageName('com.a.b_c'), 'com.a.b_c')
  // A semicolon / backtick / $ / space must all be rejected
  for (const bad of [
    "com.x; rm -rf /",
    "com.x`id`",
    "com.x$(id)",
    "com.x y",
    "com.x'",
    "com.x&&id",
    "../../etc",
    "",
  ]) {
    assert.throws(() => assertPackageName(bad), /Invalid application package name/, `it must reject: ${bad}`)
  }
})

test('assertAppid rejects command injection payloads', () => {
  assert.equal(assertAppid('__UNI__ABCDEF'), '__UNI__ABCDEF')
  for (const bad of ["x'; id; '", 'a b', 'a/b', '', 'a$b']) {
    assert.throws(() => assertAppid(bad), /Invalid appid/, `it must reject: ${bad}`)
  }
})

test('★assertRelPath rejects path traversal and shell metacharacters', () => {
  assert.equal(assertRelPath('app-service.js'), 'app-service.js')
  assert.equal(assertRelPath('assets/img/logo@1.png'), 'assets/img/logo@1.png')
  assert.equal(assertRelPath('uni_modules/x/utssdk/index.uts'), 'uni_modules/x/utssdk/index.uts')
  for (const bad of [
    '../etc/passwd',
    'a/../../b',
    '/absolute/path',
    'a/./b',
    'a//b',
    "a'; rm -rf /; '",
    'a b',
    'a$(id)',
    'a`id`',
    'a\nb',
    '',
  ]) {
    assert.throws(() => assertRelPath(bad), /Invalid artifact relative path/, `it must reject: ${bad}`)
  }
})

test('★removeRemote rejects a traversal path (no shell command is issued at all)', () => {
  const calls: string[] = []
  const adb = { shell: (c: string) => {
      calls.push(c)
      return ''
    } }
  assert.throws(() => removeRemote(adb, '/www', ['../../etc/passwd']), /Invalid artifact relative path/)
  assert.equal(calls.length, 0, 'no shell command must be issued when the validation fails')
})

test('removeRemote builds a quoted rm command for a normal path', () => {
  const calls: string[] = []
  const adb = { shell: (c: string) => {
      calls.push(c)
      return ''
    } }
  removeRemote(adb, '/www', ['pages/gone.css'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0], "rm -f '/www/pages/gone.css'")
})

test('writeManagedManifest refuses to write through a symbolic link', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const target = path.join(dir, 'target.json')
  writeFileSync(target, 'important')
  const link = path.join(dir, 'state.json')
  symlinkSync(target, link)
  assert.throws(() => writeManagedManifest(link, ['a.js']), /symbolic link/)
  // The content of the target file must not be overwritten
  assert.equal(readFileSync(target, 'utf8'), 'important')
})

// ── Cross-platform: resolving the uni CLI entry ─────────────────────────────

test('findUniEntry resolves the real JS entry (and not the .bin shim)', () => {
  // The project is located relative to this test file, so the test does not
  // depend on an absolute path of a specific machine.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
  const candidates = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules' && d.name !== '.git')
    .map((d) => path.join(repoRoot, d.name))
    .filter((dir) => existsSync(path.join(dir, 'package.json')))
  const dir = candidates.find((d) => existsSync(path.join(d, 'node_modules', '@dcloudio', 'vite-plugin-uni')))
  if (!dir) return // skip when the environment does not match
  const entry = findUniEntry(dir)
  assert.ok(entry, 'the uni entry must be resolved')
  assert.ok(entry.endsWith('uni.js'), `the entry must be a .js file, got: ${entry}`)
  // The key point: not node_modules/.bin/uni (a shell shim on Windows)
  assert.ok(!entry.includes(path.join('.bin', 'uni')))
})

// ── Debounce (waitForStableChange) ─────────────────────────────────────────

test('waitForStableChange returns only once the fingerprint is stable', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-fp-'))
  writeFileSync(path.join(dir, 'a.txt'), 'v1')
  const baseline = artifactFingerprint(dir)

  // Simulate "one build writes in several rounds": first a, then b, then stable
  setTimeout(() => writeFileSync(path.join(dir, 'a.txt'), 'v2'), 30)
  setTimeout(() => writeFileSync(path.join(dir, 'b.txt'), 'x'), 90)

  const fp = await waitForStableChange(dir, baseline, { intervalMs: 20, stableMs: 120 })
  assert.notEqual(fp, baseline)
  // b.txt must exist when it returns (so it really waited for the stable point)
  assert.ok(existsSync(path.join(dir, 'b.txt')))
})

test('waitForStableChange does not return when the artifacts do not change (it rejects on timeout)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-fp-'))
  writeFileSync(path.join(dir, 'a.txt'), 'v1')
  const baseline = artifactFingerprint(dir)

  await assert.rejects(
    () => waitForStableChange(dir, baseline, { intervalMs: 20, timeoutMs: 200 }),
    /Timed out waiting for the artifacts to update/
  )
})

test('waitForStableChange falls back after maxSettleMs when the artifacts keep changing', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-fp-'))
  writeFileSync(path.join(dir, 'a.txt'), 'v1')
  const baseline = artifactFingerprint(dir)
  // It keeps changing and is never stable -> it must return after maxSettleMs
  // instead of hanging forever
  const timer = setInterval(() => writeFileSync(path.join(dir, 'a.txt'), String(Date.now())), 10)
  const fp = await waitForStableChange(dir, baseline, {
    intervalMs: 20,
    stableMs: 100000,
    maxSettleMs: 300,
    timeoutMs: 5000,
  })
  clearInterval(timer)
  assert.notEqual(fp, baseline)
})

// ── Audit fixes: temp files / state directory / port forward cleanup ───────

test('statePath generates different paths for different serials (no more sanitize collapse)', () => {
  const a = statePath('192.0.2.55:5555', 'com.x', '__UNI__A')
  const b = statePath('192.0.2.55_5555', 'com.x', '__UNI__A')
  assert.notEqual(a, b, 'a lossy replacement would collapse :5555 and _5555 into the same file name')
  // The path fragment must still be safe to use as a file name
  assert.ok(!/[\\/]/.test(path.basename(a)))
})

test('the statePath file name contains no path separator and no shell metacharacter', () => {
  const p = statePath('../../etc/passwd; rm -rf /', 'com.x', '__UNI__A')
  const base = path.basename(p)
  assert.ok(!base.includes('/'), `the file name must not contain a path separator: ${base}`)
  assert.ok(base !== '.' && base !== '..', `the file name must not be . or ..: ${base}`)
  assert.ok(!/[\s;|`$()]/.test(base), `it must not contain shell metacharacters: ${base}`)
  // After the encoding there must be no consecutive dot segments (traversal shape)
  assert.ok(!base.includes('/../'))
})

test('writeManagedManifest refuses a symbolic link parent directory', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const real = path.join(base, 'real')
  mkdirSync(real, { recursive: true })
  const link = path.join(base, 'linked')
  symlinkSync(real, link)

  const stateFile = path.join(link, 'state.json')
  assert.throws(() => writeManagedManifest(stateFile, ['a.js']), /symbolic link/)
  // No manifest may appear in the attacker directory
  assert.equal(existsSync(path.join(real, 'state.json')), false)
})

test('writeManagedManifest writes the file with the 0600 permissions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const stateFile = path.join(dir, 'state.json')
  writeManagedManifest(stateFile, ['a.js', 'b.js'])
  const st = statSync(stateFile)
  assert.equal(st.mode & 0o777, 0o600, `expected 0600, got ${(st.mode & 0o777).toString(8)}`)
  assert.deepEqual(readManagedManifest(stateFile), ['a.js', 'b.js'])
})

test('writeManagedManifest replaces the file atomically: no temp file is left behind', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const stateFile = path.join(dir, 'state.json')
  writeManagedManifest(stateFile, ['a.js'])
  writeManagedManifest(stateFile, ['b.js'])
  const leftovers = readdirSync(dir).filter((f) => f !== 'state.json')
  assert.deepEqual(leftovers, [], `no temp file must be left behind: ${leftovers}`)
  assert.deepEqual(readManagedManifest(stateFile), ['b.js'])
})

test('removeForwards removes all the port forwards', () => {
  const calls: string[] = []
  const adb = { forward: (args: string[]) => calls.push(args.join(' ')) }
  removeForwards(adb, [13131, 19222])
  assert.deepEqual(calls, ['--remove tcp:13131', '--remove tcp:19222'])
})

test('removeForwards: a failure on one port does not affect the other ports', () => {
  const calls: string[] = []
  const adb = {
    forward: (args: string[]) => {
      if (args[1] === 'tcp:13131') throw new Error('the port does not exist')
      calls.push(args.join(' '))
    },
  }
  removeForwards(adb, [13131, 19222])
  assert.deepEqual(calls, ['--remove tcp:19222'])
})

test('pushFullTar uses unpredictable local and device-side file names', async () => {
  const calls: string[] = []
  const adb = {
    shell: (c: string) => {
      calls.push(c)
      return ''
    },
    push: (src: string) => {
      calls.push(`push:${path.basename(src)}`)
      return ''
    },
  }
  const localRoot = mkdtempSync(path.join(tmpdir(), 'uni-hmr-dist-'))
  writeFileSync(path.join(localRoot, 'a.txt'), 'x')

  const r1 = await pushFullTar(adb, localRoot, '/www')
  const r2 = await pushFullTar(adb, localRoot, '/www')

  // The local archive name must not contain the pid (predictable) -> it has to
  // be in a private random directory
  assert.ok(!r1.tarFile.includes(String(process.pid)) || r1.tarFile.includes('tar-'))
  assert.notEqual(r1.tarFile, r2.tarFile, 'the local archive path must differ on every round')
  assert.notEqual(r1.remoteTar, r2.remoteTar, 'the device-side archive path must differ on every round (TOCTOU)')
  assert.match(r1.remoteTar, /^\/data\/local\/tmp\/uni-hmr-[0-9a-f]+\.tar$/)
  // The device-side archive must be cleaned up after the extraction
  assert.ok(calls.some((c) => c.startsWith('rm -f ') && c.includes(r1.remoteTar)))
})

test('writeManagedManifest tightens the permissions of an existing directory to 0700', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-'))
  const stateDir = path.join(dir, 'state')
  mkdirSync(stateDir, { recursive: true, mode: 0o777 })
  chmodSync(stateDir, 0o777)
  const stateFile = path.join(stateDir, 'state.json')
  writeManagedManifest(stateFile, ['a.js'])
  assert.equal(statSync(stateDir).mode & 0o777, 0o700, 'a pre-seeded 0777 directory must be tightened')
})

test('waitForMarker retries until the marker appears (the page WebView is recreated after the restart)', async () => {
  let calls = 0
  const probeFn = async (): Promise<any> => {
    calls++
    if (calls < 3) return [{ title: 'View', len: 0, hit: [['HMROK', false]] }]
    return [{ title: 'pages/index/index[1]', len: 12, hit: [['HMROK', true]] }]
  }
  const res = await waitForMarker(19222, ['HMROK'], {
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 2000,
    probeFn,
  })
  assert.equal(res.hit, true)
  assert.equal(calls, 3, 'the probe must be retried until the marker shows up')
})

test('waitForMarker gives up after the timeout and reports a miss', async () => {
  const probeFn = async (): Promise<any> => [{ title: 'View', len: 0, hit: [['HMROK', false]] }]
  const res = await waitForMarker(19222, ['HMROK'], {
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 20,
    probeFn,
  })
  assert.equal(res.hit, false)
  assert.equal(res.results.length, 1)
})

test('waitForMarker rethrows the last error when no target ever appeared', async () => {
  const probeFn = async (): Promise<any> => {
    throw new Error('CDP did not report any target')
  }
  await assert.rejects(
    () => waitForMarker(19222, ['HMROK'], { intervalMs: 1, settleMs: 1, timeoutMs: 20, probeFn }),
    /CDP did not report any target/
  )
})

test('formatProbeResults renders the hit and the miss lines', () => {
  const lines = formatProbeResults([
    { title: 'View', len: 0, htmlLen: 156, kids: 4, hit: [['HMROK', false]] },
    { title: 'pages/index/index[1]', len: 618, htmlLen: 52582, kids: 4, hit: [['HMROK', true]] },
    { title: 'broken', error: 'boom' },
  ])
  assert.equal(lines.length, 5)
  assert.match(lines[0], /=== View === innerTextLen=0 innerHTMLLen=156 bodyKids=4/)
  assert.match(lines[1], /^ {3}--- {2}HMROK$/)
  assert.match(lines[2], /=== pages\/index\/index\[1\] === innerTextLen=618 innerHTMLLen=52582 bodyKids=4/)
  assert.match(lines[3], /HIT {2}HMROK/)
  assert.match(lines[4], /=== broken === ERR boom/)
})

test('waitForMarker rejects a stale hit when the DOM did not change', async () => {
  // The old page WebView is still alive during the restart and still carries
  // the previous marker -> the signature is unchanged -> the hit is stale.
  const probeFn = async (): Promise<any> => [
    { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '100:10', hit: [['HMROK-A3', true]] },
  ]
  const res = await waitForMarker(19222, ['HMROK-A3'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 20,
    probeFn,
  })
  assert.equal(res.hit, false, 'a hit on an unchanged DOM must not be accepted')
  assert.equal(res.fresh, false)
})

test('waitForMarker accepts a hit once the DOM signature changed and is stable', async () => {
  let calls = 0
  const probeFn = async (): Promise<any> => {
    calls++
    if (calls === 1) {
      return [
        { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '100:10', hit: [['HMROK-A3', true]] },
      ]
    }
    return [
      { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '120:12', hit: [['HMROK-A4', true]] },
    ]
  }
  const res = await waitForMarker(19222, ['HMROK-A4'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 2000,
    probeFn,
  })
  assert.equal(res.hit, true)
  assert.equal(res.fresh, true)
  // The first poll sees the new signature, the second confirms that it is
  // stable -> the hit is accepted on the third poll.
  assert.equal(calls, 3)
})

test('waitForMarker does not accept a hit on a half loaded page', async () => {
  // The signature changes on every poll -> the view is still loading and the
  // hit must not be accepted.
  let calls = 0
  const probeFn = async (): Promise<any> => {
    calls++
    return [
      {
        title: 'pages/index/index[1]',
        key: 'pages/index/index',
        sig: `${100 + calls}:10`,
        hit: [['HMROK-A4', true]],
      },
    ]
  }
  const res = await waitForMarker(19222, ['HMROK-A4'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 30,
    probeFn,
  })
  assert.equal(res.hit, false, 'a hit on a page that is still changing must not be accepted')
})

test('waitForMarker accepts a hit once the reload counter changed', async () => {
  // The content did not change, but the page WebView was reloaded (its title
  // carries an incremented counter) -> the hit is not stale.
  const probeFn = async (): Promise<any> => [
    { title: 'pages/index/index[2]', key: 'pages/index/index', sig: '100:10', hit: [['HMROK-A4', true]] },
  ]
  const res = await waitForMarker(19222, ['HMROK-A4'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 2000,
    probeFn,
  })
  assert.equal(res.hit, true)
})

test('waitForMarker accepts a hit on a target that did not exist before', async () => {
  const probeFn = async (): Promise<any> => [
    { title: 'pages/other/other[1]', key: 'pages/other/other', sig: '300:30', hit: [['HMROK-A4', true]] },
  ]
  const res = await waitForMarker(19222, ['HMROK-A4'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 2000,
    probeFn,
  })
  assert.equal(res.hit, true)
})

test('waitForMarker rejects a stale hit even when another target changed', async () => {
  // The `View` container changed, but the hit comes from the stale page
  // WebView -> the hit must not be accepted.
  const probeFn = async (): Promise<any> => [
    { title: 'View', key: 'View', sig: '200:20', hit: [['HMROK', false]] },
    { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '100:10', hit: [['HMROK-A3', true]] },
  ]
  const res = await waitForMarker(19222, ['HMROK-A3'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 20,
    probeFn,
  })
  assert.equal(res.hit, false, 'the hit must come from the target that was rebuilt')
})

test('waitForMarker accepts a hit without a baseline (first build)', async () => {
  const probeFn = async (): Promise<any> => [
    { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '100:10', hit: [['HMROK', true]] },
  ]
  const res = await waitForMarker(19222, ['HMROK'], {
    baseline: null,
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 2000,
    probeFn,
  })
  assert.equal(res.hit, true)
})

test('normalizeTargetTitle strips the reload counter', () => {
  assert.equal(normalizeTargetTitle('pages/index/index[1]'), 'pages/index/index')
  assert.equal(normalizeTargetTitle('pages/index/index[23]'), 'pages/index/index')
  assert.equal(normalizeTargetTitle('View'), 'View')
  assert.equal(normalizeTargetTitle(undefined), '')
})

test('isFresh reports that the DOM changed even without a marker hit', () => {
  const baseline = domBaseline('100:10', 'pages/index/index[1]')
  assert.equal(
    isFresh([{ title: 'pages/index/index[1]', key: 'pages/index/index', sig: '120:12', hit: [['M', false]] }], baseline),
    true
  )
  assert.equal(
    isFresh([{ title: 'pages/index/index[1]', key: 'pages/index/index', sig: '100:10', hit: [['M', false]] }], baseline),
    false
  )
  assert.equal(isFresh([], baseline), false)
  assert.equal(isFresh([{ title: 'x', sig: '1:1' }], null), false)
})

test('waitForMarker reports fresh=true when the DOM changed but the marker is gone', async () => {
  const probeFn = async (): Promise<any> => [
    { title: 'pages/index/index[1]', key: 'pages/index/index', sig: '120:12', hit: [['HMROK-A7', false]] },
  ]
  const res = await waitForMarker(19222, ['HMROK-A7'], {
    baseline: domBaseline('100:10', 'pages/index/index[1]'),
    intervalMs: 1,
    settleMs: 1,
    timeoutMs: 20,
    probeFn,
  })
  assert.equal(res.hit, false)
  assert.equal(res.fresh, true, 'the view was updated, only the marker is missing')
})

// ── the device lock ─────────────────────────────────────────────────────────

test('isProcessAlive detects a living process and rejects an invalid pid', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(1.5), false)
  // pid 2^22 is above the usual pid_max, so it cannot be alive
  assert.equal(isProcessAlive(4194304), false)
})

test('acquireLock takes the lock and release removes it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const lock = acquireLock('dev1__pkg__appid', { dir })
  assert.equal(hasLock('dev1__pkg__appid', { dir }), true)
  assert.equal(lockOwner('dev1__pkg__appid', { dir }), process.pid)
  lock.release()
  assert.equal(hasLock('dev1__pkg__appid', { dir }), false)
})

test('acquireLock refuses a second holder of the same device', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const lock = acquireLock('dev1__pkg__appid', { dir })
  assert.throws(() => acquireLock('dev1__pkg__appid', { dir }), /already working on this device/)
  lock.release()
  // After the release the lock can be taken again
  const again = acquireLock('dev1__pkg__appid', { dir })
  again.release()
})

test('acquireLock allows different devices to run in parallel', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const a = acquireLock('dev1__pkg__appid', { dir })
  const b = acquireLock('dev2__pkg__appid', { dir })
  a.release()
  b.release()
})

test('acquireLock takes over a stale lock of a dead process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const file = path.join(dir, 'dev1__pkg__appid.lock')
  // pid 4194304 is above the usual pid_max -> the owner cannot be alive
  writeFileSync(file, '4194304\n')
  const lock = acquireLock('dev1__pkg__appid', { dir })
  assert.equal(lockOwner('dev1__pkg__appid', { dir }), process.pid)
  lock.release()
})

test('acquireLock treats an unreadable lock as stale', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  writeFileSync(path.join(dir, 'dev1__pkg__appid.lock'), 'not-a-pid\n')
  const lock = acquireLock('dev1__pkg__appid', { dir })
  assert.equal(lockOwner('dev1__pkg__appid', { dir }), process.pid)
  lock.release()
})

test('release does not remove a lock that belongs to another process', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const file = path.join(dir, 'dev1__pkg__appid.lock')
  writeFileSync(file, '4194304\n')
  const lock = acquireLock('dev1__pkg__appid', { dir })
  // Simulate that another process took the lock in the meantime
  writeFileSync(file, '4194303\n')
  lock.release()
  assert.equal(hasLock('dev1__pkg__appid', { dir }), true)
})

test('stateKey scopes the lock to serial + package + appid', () => {
  assert.notEqual(stateKey('a', 'p', 'x'), stateKey('b', 'p', 'x'))
  assert.notEqual(stateKey('a', 'p', 'x'), stateKey('a', 'q', 'x'))
  assert.notEqual(stateKey('a', 'p', 'x'), stateKey('a', 'p', 'y'))
  assert.equal(stateKey('a', 'p', 'x'), stateKey('a', 'p', 'x'))
  // The key is used as a file name -> it must not contain a path separator
  assert.equal(stateKey('a', 'p', 'x').includes('/'), false)
  assert.equal(stateKey('a', 'p', 'x').includes('\\'), false)
})

test('acquireLock refuses a state directory that is a symbolic link', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  const target = path.join(base, 'real')
  mkdirSync(target, { recursive: true })
  const link = path.join(base, 'link')
  symlinkSync(target, link)
  assert.throws(() => acquireLock('dev1__pkg__appid', { dir: link }), /symbolic link/)
})

test('acquireLock tightens the permissions of a pre-seeded state directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-lock-'))
  chmodSync(dir, 0o777)
  const lock = acquireLock('dev1__pkg__appid', { dir })
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(lock.path).mode & 0o777, 0o600)
  lock.release()
})

// ── Wireless debugging (ADB over TCP/IP) ───────────────────────────────────

/**
 * Build a fake adb script that answers `devices -l` and `shell getprop
 * ro.serialno` (and any other shell command with a fixed answer).
 *
 * The real adb is always called as `adb -s <serial> <command>`, so the mock
 * has to skip the `-s <serial>` pair to find the command.
 *
 * @param {string} devicesOutput the output of `adb devices -l`
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.shell] the answer per shell command
 */
function mockAdbFull(devicesOutput: string, opts: { shell?: Record<string, string> } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  // Inside the shell branch "$*" is the command that is passed to the device
  const answers = Object.entries(opts.shell || {})
    .map(
      ([cmd, out]) =>
        `  if [ "$*" = ${JSON.stringify(cmd)} ]; then printf '%s\\n' ${JSON.stringify(out)}; exit 0; fi`
    )
    .join('\n')
  writeFileSync(
    p,
    `#!/bin/sh
# Strip the "-s <serial>" prefix
if [ "$1" = "-s" ]; then shift 2; fi
cmd="$1"; shift
if [ "$cmd" = "devices" ]; then
  cat <<'EOF'
${devicesOutput}
EOF
elif [ "$cmd" = "shell" ]; then
${answers}
  exit 0
else
  exit 0
fi
`
  )
  chmodSync(p, 0o755)
  return p
}

test('isWirelessSerial detects a host:port transport serial', () => {
  assert.equal(isWirelessSerial('192.0.2.55:5555'), true)
  assert.equal(isWirelessSerial('127.0.0.1:15555'), true)
  assert.equal(isWirelessSerial('emulator-5554'), false)
  assert.equal(isWirelessSerial('HW00000001'), false)
  // A colon without a numeric port is not a wireless serial
  assert.equal(isWirelessSerial('weird:serial'), false)
  assert.equal(isWirelessSerial(':5555'), false)
  // The port has to be in range
  assert.equal(isWirelessSerial('1.2.3.4:0'), false)
  assert.equal(isWirelessSerial('1.2.3.4:70000'), false)
})

test('parseDevices reads a wireless device like any other device', () => {
  const { online } = parseDevices(
    `List of devices attached\n192.0.2.55:5555   device product:PRODUCTX model:MODELX device:CODENAME_X`
  )
  assert.equal(online.length, 1)
  assert.equal(online[0].serial, '192.0.2.55:5555')
  assert.equal(online[0].model, 'MODELX')
})

test('formatDeviceList tells the user whether the device is USB or wireless', () => {
  const s = formatDeviceList([
    { serial: '192.0.2.55:5555', model: 'MODELX' },
    { serial: 'HW00000001', model: 'MODELX' },
  ])
  assert.match(s, /192\.0\.2\.55:5555[\s\S]*wireless/)
  assert.match(s, /HW00000001[\s\S]*usb/)
})

test('★the device scope is the hardware serial, so that USB and Wi-Fi share one scope', () => {
  const adbPath = mockAdbFull(
    `List of devices attached\nHW00000001   device usb:1-8 model:MODELX`,
    { shell: { 'getprop ro.serialno': 'HW00000001' } }
  )
  const scope = deviceScope(adbPath, { serial: 'HW00000001' }, [])
  assert.equal(scope, 'pid:HW00000001')
})

test('★a wireless device gets the same scope as the same device over USB', () => {
  // The very same phone, seen over USB and over Wi-Fi
  const adbPath = mockAdbFull(
    `List of devices attached\nHW00000001   device usb:1-8 model:MODELX\n192.0.2.55:5555   device model:MODELX`,
    { shell: { 'getprop ro.serialno': 'HW00000001' } }
  )
  const online = listDevices(adbPath).online
  const usbScope = deviceScope(adbPath, online.find((d) => d.serial === 'HW00000001')!, online)
  const wifiScope = deviceScope(adbPath, online.find((d) => d.serial === '192.0.2.55:5555')!, online)
  assert.equal(usbScope, wifiScope)
  assert.equal(wifiScope, 'pid:HW00000001')
})

test('★the android_id identifies a device across the transports', () => {
  const adbPath = mockAdbFull(
    `List of devices attached\nHW00000001   device usb:1-8 model:MODELX\n192.0.2.55:5555   device model:MODELX`,
    {
      shell: {
        'getprop ro.serialno': 'HW00000001',
        'settings get secure android_id': 'a1b2c3d4e5f60718',
      },
    }
  )
  const online = listDevices(adbPath).online
  const usbScope = deviceScope(adbPath, online.find((d) => d.serial === 'HW00000001')!, online)
  const wifiScope = deviceScope(adbPath, online.find((d) => d.serial === '192.0.2.55:5555')!, online)
  assert.equal(usbScope, 'aid:a1b2c3d4e5f60718')
  assert.equal(wifiScope, 'aid:a1b2c3d4e5f60718')
})

test('★two different devices keep different scopes', () => {
  const adbPath = mockAdbFull(
    `List of devices attached\nAAA111   device model:Pixel_7\nBBB222   device model:XQ123`,
    {
      shell: {
        // The same value for every device -> the identity is not trustworthy
        'getprop ro.serialno': 'SAMEPLACEHOLDER',
        'settings get secure android_id': 'null',
      },
    }
  )
  const online = listDevices(adbPath).online
  const a = deviceScope(adbPath, online[0], online)
  const b = deviceScope(adbPath, online[1], online)
  assert.notEqual(a, b)
  // The placeholder serial is not used, the transport serial is
  assert.equal(a, 'trn:AAA111')
  assert.equal(b, 'trn:BBB222')
})

test('★a device that does not report any identity falls back to the transport serial', () => {
  const adbPath = mockAdbFull(
    `List of devices attached\n192.0.2.55:5555   device model:MODELX`,
    { shell: { 'getprop ro.serialno': '', 'settings get secure android_id': '' } }
  )
  const online = listDevices(adbPath).online
  const scope = deviceScope(adbPath, online[0], online)
  assert.equal(scope, 'trn:192.0.2.55:5555')
})

test('readPhysicalSerial returns null when the property is unknown', () => {
  const adbPath = mockAdbFull('List of devices attached', {
    shell: { 'getprop ro.serialno': 'unknown' },
  })
  const adb = createAdb(adbPath, 'X')
  assert.equal(readPhysicalSerial(adb), null)
})

test('★the scope key never contains a path separator', () => {
  const adbPath = mockAdbFull(
    `List of devices attached\n192.0.2.55:5555   device model:MODELX`,
    { shell: { 'getprop ro.serialno': '', 'settings get secure android_id': 'aid/with/slash' } }
  )
  const online = listDevices(adbPath).online
  const scope = deviceScope(adbPath, online[0], online)
  // An unexpected android_id is rejected, so the transport serial is used
  assert.equal(scope, 'trn:192.0.2.55:5555')
  assert.equal(scope.includes('/'), false)
  // And it is safe as a file name component
  assert.equal(stateKey(scope, 'pkg', 'appid').includes('/'), false)
})

test('adbConnect reports a successful connection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, '#!/bin/sh\nprintf "connected to 192.0.2.55:5555\\n"\n')
  chmodSync(p, 0o755)
  const r = adbConnect(p, '192.0.2.55:5555')
  assert.equal(r.ok, true)
  assert.match(r.message, /connected to/)
})

test('★adbConnect rejects an address that is not host:port', () => {
  const r = adbConnect('/bin/true', 'not-an-address')
  assert.equal(r.ok, false)
  assert.match(r.message, /not a valid wireless address/)
})

test('adbConnect explains a failed connection', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, '#!/bin/sh\nprintf "unable to connect to 192.0.2.55:5555\\n"\nexit 1\n')
  chmodSync(p, 0o755)
  const r = adbConnect(p, '192.0.2.55:5555')
  assert.equal(r.ok, false)
  assert.match(r.message, /Could not connect/)
})

test('adbPair reports a successful pairing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, '#!/bin/sh\nprintf "Successfully paired to 192.0.2.55:37000\\n"\n')
  chmodSync(p, 0o755)
  const r = adbPair(p, '192.0.2.55:37000', '123456')
  assert.equal(r.ok, true)
  assert.match(r.message, /Successfully paired/)
})

test('★adbPair rejects an address that is not host:port', () => {
  const r = adbPair('/bin/true', 'not-an-address')
  assert.equal(r.ok, false)
  assert.match(r.message, /not a valid pairing address/)
})

test('adbPair reports the error of a failed pairing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'uni-hmr-adb-'))
  const p = path.join(dir, 'adb')
  writeFileSync(p, '#!/bin/sh\nprintf "Failed: Unable to start pairing client.\\n" >&2\nexit 1\n')
  chmodSync(p, 0o755)
  const r = adbPair(p, '192.0.2.55:37000', '000000')
  assert.equal(r.ok, false)
  assert.match(r.message, /Failed/)
})

test('assertPagePath accepts a plain page path', () => {
  assert.equal(assertPagePath('pages/index/index'), 'pages/index/index')
  assert.equal(assertPagePath('pages/mine/about/detail'), 'pages/mine/about/detail')
})

test('assertPagePath strips a leading slash', () => {
  assert.equal(assertPagePath('/pages/index/index'), 'pages/index/index')
  assert.equal(assertPagePath('//pages/index/index'), 'pages/index/index')
})

test('assertPagePath rejects a path without a directory', () => {
  assert.throws(() => assertPagePath('index'), /at least a directory and a file/)
})

test('assertPagePath rejects an empty path', () => {
  assert.throws(() => assertPagePath(''), /empty/)
  assert.throws(() => assertPagePath(undefined), /empty/)
})

test('assertPagePath rejects a traversal attempt', () => {
  assert.throws(() => assertPagePath('pages/../../etc/passwd'), /may only contain/)
  assert.throws(() => assertPagePath('pages/index/index?a=1'), /may only contain/)
})

test('assertPageQuery accepts a normal query string', () => {
  assert.equal(assertPageQuery('a=1&b=2'), 'a=1&b=2')
  assert.equal(assertPageQuery('title=Hello%20World'), 'title=Hello%20World')
})

test('assertPageQuery treats an empty value as absent', () => {
  assert.equal(assertPageQuery(''), '')
  assert.equal(assertPageQuery(undefined), '')
  assert.equal(assertPageQuery(null), '')
})

test('assertPageQuery rejects a shell metacharacter', () => {
  assert.throws(() => assertPageQuery('a=1;rm -rf /'), /Expected a URL query string/)
  assert.throws(() => assertPageQuery('a=1&b=$(id)'), /Expected a URL query string/)
})

test('buildPageUrl joins the path and the query', () => {
  assert.equal(buildPageUrl('pages/index/index'), '/pages/index/index')
  assert.equal(buildPageUrl('/pages/index/index'), '/pages/index/index')
  assert.equal(buildPageUrl('pages/index/index', 'a=1&b=2'), '/pages/index/index?a=1&b=2')
  assert.equal(buildPageUrl('pages/index/index', ''), '/pages/index/index')
})

test('buildPageUrl accepts the query inline in the page argument', () => {
  assert.equal(buildPageUrl('pages/a/b?x=1'), '/pages/a/b?x=1')
  assert.equal(buildPageUrl('/pages/a/b?x=1&y=2'), '/pages/a/b?x=1&y=2')
  // A trailing `?` without a query is just dropped
  assert.equal(buildPageUrl('pages/a/b?'), '/pages/a/b')
})

test('buildPageUrl appends --query after an inline query', () => {
  assert.equal(buildPageUrl('pages/a/b?x=1', 'y=2'), '/pages/a/b?x=1&y=2')
  assert.equal(buildPageUrl('pages/a/b', 'y=2'), '/pages/a/b?y=2')
})

test('buildPageUrl rejects an invalid inline query', () => {
  assert.throws(() => buildPageUrl('pages/a/b?x=1;id'), /Expected a URL query string/)
  assert.throws(() => buildPageUrl('pages/a/b?x=$(id)'), /Expected a URL query string/)
})

test('splitPageUrl separates the path from the query', () => {
  assert.deepEqual(splitPageUrl('pages/a/b'), { path: 'pages/a/b', query: '' })
  assert.deepEqual(splitPageUrl('/pages/a/b?x=1&y=2'), { path: '/pages/a/b', query: 'x=1&y=2' })
  assert.deepEqual(splitPageUrl('pages/a/b?'), { path: 'pages/a/b', query: '' })
})

test('buildPageUrl rejects an invalid page path', () => {
  assert.throws(() => buildPageUrl('index'), /at least a directory and a file/)
  assert.throws(() => buildPageUrl('pages/index/index', 'a=1;id'), /Expected a URL query string/)
})

test('appPid returns the first pid', () => {
  const adb = { shell: () => '1234 5678' }
  assert.equal(appPid(adb, 'com.example.app'), '1234')
})

test('appPid returns null when the app is not running', () => {
  // pidof exits non-zero when nothing matches, which surfaces as a throw
  const adb = {
    shell: () => {
      throw new Error('Command failed: adb shell pidof com.example.app')
    },
  }
  assert.equal(appPid(adb, 'com.example.app'), null)
})

test('appPid returns null on empty output', () => {
  assert.equal(appPid({ shell: () => '' }, 'com.example.app'), null)
})

test('★appPid rejects an invalid package name', () => {
  assert.throws(() => appPid({ shell: () => '1' }, 'com.example;id'), /Invalid application package name/)
})

test('waitForAppPid resolves once the process shows up', async () => {
  let calls = 0
  const adb = {
    shell: () => {
      calls++
      if (calls < 3) throw new Error('not running yet')
      return '4321'
    },
  }
  const pid = await waitForAppPid(adb, 'com.example.app', { intervalMs: 1 })
  assert.equal(pid, '4321')
  assert.equal(calls, 3)
})

test('waitForAppPid gives up with a clear message', async () => {
  const adb = {
    shell: () => {
      throw new Error('not running')
    },
  }
  await assert.rejects(
    () => waitForAppPid(adb, 'com.example.app', { timeoutMs: 20, intervalMs: 1 }),
    /did not come up within 20ms/
  )
})

test('parseArgs recognises --version and -v', () => {
  assert.equal(parseArgs(['--version']).version, true)
  assert.equal(parseArgs(['-v']).version, true)
  assert.equal(parseArgs([]).version, false)
  assert.deepEqual(parseArgs(['-v']).rest, [])
  // --version 不能被当成平台参数传给 uni CLI
  assert.deepEqual(parseArgs(['--version', 'app-plus']).rest, ['app-plus'])
})

test('packageVersion matches the package manifest', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  assert.match(pkg.version, /^\d+\.\d+\.\d+/)
  assert.equal(packageVersion(), pkg.version)
})
