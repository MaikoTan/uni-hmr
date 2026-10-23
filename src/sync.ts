/**
 * Artifact synchronisation: local dist/dev/<platform> <-> device www directory.
 *
 * Two strategies:
 *   - full        tar the whole tree -> adb push -> extract on the device
 *                 (first sync / forced full sync). Measured 71MB / 744 files
 *                 in about 1.5s.
 *   - incremental md5 diff, pushing only the files that changed. Measured about
 *                 90-130ms for a single file.
 *
 * Key constraints:
 *   - `adb push` fails when the parent directory does not exist
 *     (secure_mkdirs failed), so `mkdir -p` is required before pushing.
 *   - /storage/emulated/0 on the device is sdcard, which does not support
 *     setting directory timestamps; tar needs -m to avoid a wall of errors.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  lstatSync,
  chmodSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertRelPath, shellQuote } from './validate'
import type { PushAdb, ShellAdb } from './adb'

/** Recursively collect the relative paths of all files under a directory (POSIX style). */
export function listFiles(root: string, base = root, out: string[] = []): string[] {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(root, e.name)
    if (e.isDirectory()) {
      listFiles(full, base, out)
    } else if (e.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'))
    }
  }
  return out
}

/** Compute the md5 hash of a local file. */
export function md5File(abs: string): string {
  return createHash('md5').update(readFileSync(abs)).digest('hex')
}

/**
 * Build the local "relative path -> md5" manifest.
 * Hashing the file contents in-process is much faster than shelling out to
 * md5sum 744 times.
 */
export function localManifest(root: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rel of listFiles(root)) {
    try {
      map.set(rel, md5File(path.join(root, rel)))
    } catch {
      // The file may have been deleted while we were walking the tree
    }
  }
  return map
}

/**
 * Parse a device-side md5sum manifest.
 * The input looks like: `<hash>  ./relative/path` (md5sum uses two spaces).
 */
export function parseRemoteManifest(stdout: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^([0-9a-f]{32})\s+(.+)$/.exec(trimmed)
    if (!m) continue
    let p = m[2]
    // md5sum emits `./foo/bar` or `foo/bar`; normalise by stripping the ./
    if (p.startsWith('./')) p = p.slice(2)
    map.set(p, m[1])
  }
  return map
}

/** Fetch the device-side manifest. `find -exec md5sum {} +` takes about 0.42s. */
export function remoteManifest(adb: ShellAdb, remoteDir: string): Map<string, string> {
  const out = adb.shell(`cd ${shellQuote(remoteDir)} && find . -type f -exec md5sum {} +`)
  return parseRemoteManifest(out)
}

export interface ManifestDiff {
  changed: string[]
  removed: string[]
}

/**
 * Compute the list of files that need to be pushed.
 *
 *   changed present locally but different (or missing) on the device
 *   removed present on the device but gone locally -> needs deletion
 *   added   same as changed (newly created locally)
 */
export function diffManifest(
  local: Map<string, string>,
  remote: Map<string, string>
): ManifestDiff {
  const changed: string[] = []
  const removed: string[] = []
  for (const [rel, hash] of local) {
    if (remote.get(rel) !== hash) changed.push(rel)
  }
  for (const rel of remote.keys()) {
    if (!local.has(rel)) removed.push(rel)
  }
  return { changed, removed }
}

/**
 * Incremental push: only push the files whose md5 does not match.
 * The parent directory is created before each push (adb push does not do it).
 */
export function pushIncremental(
  adb: PushAdb & ShellAdb,
  localRoot: string,
  remoteDir: string,
  files: string[]
): string[] {
  const pushed: string[] = []
  const dirs = new Set<string>()
  for (const rel of files) {
    assertRelPath(rel)
    const abs = path.join(localRoot, rel)
    const dir = path.posix.dirname(rel)
    if (dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir)
      adb.shell(`mkdir -p ${shellQuote(`${remoteDir}/${dir}`)}`)
    }
    adb.push(abs, `${remoteDir}/${rel}`)
    pushed.push(rel)
  }
  return pushed
}

/**
 * Delete files that are no longer needed on the device.
 *
 * Safety constraint 1: the device-side www directory does not only hold dist
 *   artifacts. It also holds the utssdk source files that the UTS compiler
 *   writes under uni_modules (they are absent from dist but required at
 *   runtime). Therefore we only delete files that this tool pushed itself and
 *   that are recorded in the managed manifest.
 *
 * Safety constraint 2: `rel` must pass the allow-list check (rejecting `..`,
 *   absolute paths and shell metacharacters). Otherwise a poisoned manifest
 *   could construct a traversal and delete files outside the www directory.
 */
export function removeRemote(adb: ShellAdb, remoteDir: string, files: string[]): void {
  for (const rel of files) {
    assertRelPath(rel)
    adb.shell(`rm -f ${shellQuote(`${remoteDir}/${rel}`)}`)
  }
}

/** Managed manifest state directory: 0700, so other users cannot read or pre-seed it. */
const STATE_DIR = path.join(os.tmpdir(), 'uni-hmr')

/**
 * The managed manifest records the files this tool pushed, so that cleanup is
 * safe.
 *
 * The manifest is kept **locally** (one state per machine) rather than on the
 * device:
 *   - it describes "what this machine pushed", so local state matches naturally
 *   - it avoids shipping a large JSON blob through `adb shell`, where quoting
 *     and line wrapping are unreliable
 *   - if the manifest is lost the tool degrades to "delete nothing", which is
 *     the safe direction
 */
export function statePath(serial: string, pkg: string, appid: string): string {
  return path.join(STATE_DIR, `${stateKey(serial, pkg, appid)}.json`)
}

/**
 * The device scope key: serial + package + appid.
 *
 * The same scope is used for the device lock, so that two processes working on
 * the same device and the same application exclude each other, while
 * different devices or different applications can run in parallel.
 */
export function stateKey(serial: string, pkg: string, appid: string): string {
  return `${sanitize(serial)}__${sanitize(pkg)}__${sanitize(appid)}`
}

/**
 * Encode an arbitrary string into a **lossless** file name fragment.
 *
 * The old sanitize() replaced every character outside `[A-Za-z0-9._-]` with
 * `_`, which is **lossy**: `192.0.2.55:5555` and `192.0.2.55_5555` collapsed
 * onto the same file name, so two different devices shared one managed manifest
 * and one device's push history drove deletions on the other. We now keep safe
 * characters verbatim, hex-encode the rest and append a short hash, which is
 * lossless and collision-free.
 */
function sanitize(s: unknown): string {
  const raw = String(s)
  let safe = ''
  for (const ch of raw) {
    if (/[A-Za-z0-9._-]/.test(ch)) safe += ch
    else safe += '_' + Buffer.from(ch, 'utf8').toString('hex') + '_'
  }
  // Append a hash of the original string to rule out any residual collision
  return `${safe.slice(0, 80)}.${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`
}

/** Read the managed manifest. */
export function readManagedManifest(stateFile: string): string[] {
  try {
    const j = JSON.parse(readFileSync(stateFile, 'utf8'))
    return Array.isArray(j.files) ? j.files : []
  } catch {
    return []
  }
}

/**
 * Make sure the state directory exists and is private.
 *
 * Safety constraint: the directory may not be a symbolic link. It lives under
 *   $TMPDIR; if another user on the same machine pre-seeds it as a symlink,
 *   `mkdirSync(recursive)` **succeeds silently** (the symlink target already
 *   exists) and the state files would be written into a directory chosen by
 *   the attacker -> manifest poisoning -> spurious deletions on the device.
 *   So the directory is lstat'ed too.
 *
 * The directory is `0700`; `mkdirSync` does not change the permissions of an
 *   existing directory, so a pre-seeded `0777` directory is tightened
 *   explicitly.
 */
export function ensureStateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  let st
  try {
    st = lstatSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return
    throw e
  }
  if (st.isSymbolicLink()) {
    throw new Error(
      `The uni-hmr state directory is a symbolic link, refusing to use it: ${dir}\n` +
        '  Please delete that directory and try again.'
    )
  }
  if ((st.mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700)
  }
}

/**
 * Write the managed manifest.
 *
 * Safety constraint 1: neither the state directory nor the target file may be
 *   a symbolic link (see `ensureStateDir`).
 *
 * Safety constraint 2: directory 0700, file 0600.
 *   The manifest decides which device-side files may be deleted, so other users
 *   on the machine must not be able to read or modify it.
 *
 * Safety constraint 3: write a temp file, then atomically rename.
 *   This avoids leaving half-written JSON behind after a crash (which would
 *   fail to parse and degrade to [], a fallback rather than correctness).
 */
export function writeManagedManifest(stateFile: string, files: string[]): void {
  const dir = path.dirname(stateFile)
  ensureStateDir(dir)
  try {
    if (lstatSync(stateFile).isSymbolicLink()) {
      throw new Error(
        `The managed manifest path is a symbolic link, refusing to write: ${stateFile}\n` +
          `  Please delete that file and try again.`
      )
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e
  }

  // Temp file in the same directory -> atomic rename
  const tmp = path.join(
    dir,
    `.${path.basename(stateFile)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  )
  try {
    writeFileSync(tmp, JSON.stringify({ files }), { mode: 0o600 })
    renameSync(tmp, stateFile)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {}
  }
}

export interface FullTarPaths {
  tarFile: string
  remoteTar: string
}

/**
 * Full sync via a tar archive.
 *
 * Implementation note: we `adb push` the tar file and then extract it on the
 *   device, rather than streaming with `tar | adb shell tar -x`, because:
 *   - `adb shell` allocates a pty by default, and the terminal line discipline
 *     corrupts the binary stream (control characters are treated as signals)
 *   - even with `-T` to disable the pty, Node-side streaming into the adb
 *     protocol still has boundary problems (observed: corrupted tar headers)
 *   With "push the whole file, then extract on the device", adb uses its
 *   standard file transfer channel, which is binary safe and md5-verifiable.
 *   Measured 71MB transferred plus extracted in 1.1s.
 *
 * Safety constraint 1: the local archive path must be **unpredictable**.
 *   The old implementation used a predictable name like
 *   `uni-hmr-full-${pid}.tar` in /tmp, and `tar -cf` **follows an existing
 *   symlink** when writing -> another user on the same machine could pre-seed
 *   `/tmp/uni-hmr-full-<pid>.tar -> ~/.bashrc` and make the archive overwrite an
 *   arbitrary file. We now create it with a random name inside a 0700 private
 *   directory, so it cannot be pre-seeded.
 *
 * Safety constraint 2: the device-side archive path must be **unique per run**.
 *   The old implementation used a fixed /data/local/tmp/uni-hmr-full.tar,
 *   which leaves a TOCTOU window between the push and the `tar -xmf`: any
 *   process on the device with shell access could swap the contents, and the
 *   app would then load attacker-controlled JS. We now use a random name and
 *   push, extract and clean up under the same name.
 *
 * `-m` skips restoring mtimes (sdcard cannot set directory timestamps, which
 * would otherwise produce hundreds of error lines).
 */
export function pushFullTar(
  adb: PushAdb & ShellAdb,
  localRoot: string,
  remoteDir: string
): FullTarPaths {
  // Private directory + random file name: unpredictable and not pre-seedable
  const tmpDir = path.join(
    os.tmpdir(),
    `uni-hmr-tar-${process.pid}-${randomBytes(8).toString('hex')}`
  )
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
  const tarFile = path.join(tmpDir, 'app.tar')
  // The same random name on the device, so no other process can grab it
  const remoteTar = `/data/local/tmp/uni-hmr-${randomBytes(8).toString('hex')}.tar`
  try {
    execFileSync('tar', ['-cf', tarFile, '-C', localRoot, '.'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })

    // Push to the device temp dir (adb push fails if the parent is missing)
    adb.shell('mkdir -p /data/local/tmp')
    adb.push(tarFile, remoteTar)

    // Extract into the target directory on the device
    adb.shell(`cd ${shellQuote(remoteDir)} && tar -xmf ${shellQuote(remoteTar)}`)

    return { tarFile, remoteTar }
  } finally {
    // Remove the device-side archive as soon as it has been used
    try {
      adb.shell(`rm -f ${shellQuote(remoteTar)}`)
    } catch {
      // Ignore when the device is unavailable
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  }
}
