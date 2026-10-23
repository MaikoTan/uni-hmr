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
import { ensureStateDir } from './sync.mjs'

/** The lock directory, next to the managed manifest (0700). */
const LOCK_DIR = path.join(os.tmpdir(), 'uni-hmr')

/**
 * Check whether a process is still alive.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM means the process exists but belongs to another user
    return !!(e && e.code === 'EPERM')
  }
}

/**
 * Acquire the lock for a device scope.
 *
 * @param {string} key the device scope (already sanitized)
 * @param {{dir?: string}} [opts] `dir` overrides the lock directory (tests)
 * @returns {{path: string, release: () => void}} the lock handle
 * @throws {Error} when the lock is held by a living process
 */
export function acquireLock(key, opts = {}) {
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
      if (!e || e.code !== 'EEXIST') throw e
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

/**
 * Read the pid of the current lock owner.
 *
 * @param {string} key the device scope (already sanitized)
 * @param {{dir?: string}} [opts] `dir` overrides the lock directory (tests)
 * @returns {number|null}
 */
export function lockOwner(key, opts = {}) {
  const file = path.join(opts.dir || LOCK_DIR, `${key}.lock`)
  try {
    if (!lstatSync(file).isFile()) return null
    const pid = Number(readFileSync(file, 'utf8').trim())
    return Number.isInteger(pid) ? pid : null
  } catch {
    return null
  }
}

/**
 * Check whether a lock file exists for a device scope.
 *
 * @param {string} key the device scope (already sanitized)
 * @param {{dir?: string}} [opts] `dir` overrides the lock directory (tests)
 * @returns {boolean}
 */
export function hasLock(key, opts = {}) {
  return existsSync(path.join(opts.dir || LOCK_DIR, `${key}.lock`))
}
