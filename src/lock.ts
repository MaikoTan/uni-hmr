/**
 * A device scoped lock.
 *
 * Two watchers on the same device would fight over the same managed manifest:
 * one of them writes the manifest, the other one reads a manifest that
 * describes a different set of files and then deletes files that are still
 * needed. The result is a broken www directory on the device.
 *
 * The lock is therefore taken for the whole duration of a watch/sync run and
 * is scoped to the device (serial + package + appid), so that different
 * devices or different projects can run in parallel.
 *
 * The lock file lives next to the managed manifest and holds the pid of the
 * owner. A lock whose owner process is gone is considered stale and is taken
 * over.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync, lstatSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureStateDir } from './sync'

/** The lock directory, next to the managed manifest (0700). */
const LOCK_DIR = path.join(os.tmpdir(), 'uni-hmr')

export interface LockOptions {
  /** Overrides the lock directory (tests) */
  dir?: string
}

export interface LockHandle {
  path: string
  release: () => void
}

/** Check whether a process is still alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to another user
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Acquire the lock for a device scope.
 *
 * @param key the device scope (already sanitized)
 * @throws when the lock is held by a living process
 */
export function acquireLock(key: string, opts: LockOptions = {}): LockHandle {
  const dir = opts.dir || LOCK_DIR
  // The same hardening as for the managed manifest: the directory may not be
  // a symlink and it has to be private
  ensureStateDir(dir)
  const file = path.join(dir, `${key}.lock`)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // The 'wx' flag fails when the file already exists -> the lock is taken
      writeFileSync(file, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return {
        path: file,
        release: () => {
          try {
            const owner = Number(readFileSync(file, 'utf8').trim())
            // Only remove the lock when we still own it
            if (owner === process.pid) unlinkSync(file)
          } catch {
            // The lock was already removed
          }
        },
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
      // The lock exists -> check whether the owner is still alive
      let owner = NaN
      try {
        owner = Number(readFileSync(file, 'utf8').trim())
      } catch {
        // An unreadable lock is treated as stale
      }
      if (isProcessAlive(owner)) {
        throw new Error(
          `Another uni-hmr process (pid ${owner}) is already working on this device.\n` +
            '  Stop it first, or pick another device with --serial.'
        )
      }
      // Stale lock (the owner died) -> remove it and try once more
      try {
        unlinkSync(file)
      } catch {
        // Someone else removed it in the meantime
      }
    }
  }
  throw new Error(`Could not acquire the uni-hmr lock: ${file}`)
}

/** Read the pid of the current lock owner. */
export function lockOwner(key: string, opts: LockOptions = {}): number | null {
  const file = path.join(opts.dir || LOCK_DIR, `${key}.lock`)
  try {
    if (!lstatSync(file).isFile()) return null
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

/** Check whether a lock file exists for a device scope. */
export function hasLock(key: string, opts: LockOptions = {}): boolean {
  return existsSync(path.join(opts.dir || LOCK_DIR, `${key}.lock`))
}
