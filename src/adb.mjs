/**
 * adb wrapper and device management.
 *
 * Multi-device policy (explicit requirement):
 *   0 devices -> error out, tell the user to plug in / authorise
 *   1 device  -> use it automatically
 *  >1 device  -> error out and list the selectable devices (serial + model),
 *                telling the user to pick one with --serial
 *   --serial given -> verify the device is online, otherwise error out and list
 *                the selectable devices
 *
 * Every adb call carries `-s <serial>` so that nothing is ever pushed to the
 * wrong device when several are connected.
 * Wireless debugging (ADB over TCP/IP) is supported as well: the transport
 * serial of such a device is `host:port` (e.g. `192.0.2.55:5555`), and
 * every other part of this file works the same way for it.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Locate the adb executable. ADB env var first, then common SDK paths, then PATH. */
export function findAdb(env = process.env) {
  const candidates = [
    env.ADB,
    path.join(env.ANDROID_HOME || env.ANDROID_SDK_ROOT || '', 'platform-tools', 'adb'),
    path.join(env.HOME || os.homedir(), 'Android/Sdk/platform-tools/adb'),
    path.join(env.HOME || os.homedir(), 'Library/Android/sdk/platform-tools/adb'),
    path.join(env.LOCALAPPDATA || '', 'Android/Sdk/platform-tools/adb'),
    '/usr/local/bin/adb',
    '/usr/bin/adb',
  ].filter(Boolean)

  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return 'adb'
}

/** Run adb synchronously and return stdout (with `\r` stripped). */
export function adbRaw(adbPath, args, opts = {}) {
  const { encoding = 'utf8', ...rest } = opts
  // execFileSync returns a Buffer when encoding is undefined; normalise to string
  const out = execFileSync(adbPath, args, { encoding, ...rest })
  return typeof out === 'string' ? out.replace(/\r/g, '') : out
}

/**
 * Parse the output of `adb devices -l`.
 * Returns the online device list: { serial, state, model, product, device, transportId }
 * Devices whose state is 'offline' / 'unauthorized' are collected separately so
 * that error messages can mention them.
 */
export function parseDevices(output) {
  const online = []
  const offline = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('List of devices')) continue
    // e.g. HW00000001  device  usb:1-8 product:PRODUCTX model:MODELX device:CODENAME_X
    const parts = line.split(/\s+/)
    if (parts.length < 2) continue
    const serial = parts[0]
    const state = parts[1]
    const info = { serial, state }
    for (const p of parts.slice(2)) {
      const idx = p.indexOf(':')
      if (idx <= 0) continue
      info[p.slice(0, idx)] = p.slice(idx + 1)
    }
    if (state === 'device') online.push(info)
    else offline.push(info)
  }
  return { online, offline }
}

/** List connected devices. */
export function listDevices(adbPath) {
  const { online, offline } = parseDevices(adbRaw(adbPath, ['devices', '-l']))
  return { online, offline }
}

/**
 * A transport serial of a wireless (TCP/IP) device looks like `host:port`,
 * e.g. `192.0.2.55:5555` or `127.0.0.1:15555`.
 *
 * The port is what distinguishes it from a USB serial: a USB serial never
 * contains a colon (the vendor serial numbers are alphanumeric), while a
 * wireless transport is always addressed by an explicit port.
 *
 * @param {string} serial
 * @returns {boolean}
 */
export function isWirelessSerial(serial) {
  const s = String(serial)
  const idx = s.lastIndexOf(':')
  if (idx <= 0) return false
  const port = s.slice(idx + 1)
  if (!/^\d+$/.test(port)) return false
  const portNum = Number(port)
  return portNum > 0 && portNum < 65536
}

/**
 * Read the **hardware** serial number of a device.
 *
 * @param {object} adb an adb wrapper bound to a specific serial
 * @returns {string|null} the hardware serial, or null when it is not available
 */
export function readPhysicalSerial(adb) {
  try {
    const prop = adb.shell('getprop ro.serialno').trim()
    if (!prop) return null
    if (/^unknown$/i.test(prop)) return null
    // A multi-line answer means the property is not a single serial
    if (prop.includes('\n')) return null
    return prop
  } catch {
    // The device may be gone; the caller falls back to the transport serial
    return null
  }
}

/**
 * Read the `android_id` of a device.
 *
 * It is a per-installation identifier that is stable across the transports
 * (USB and Wi-Fi report the same value) and is unique per device, so it is a
 * good second identity source when `ro.serialno` is not trustworthy.
 *
 * The value is validated against the format Android uses (16 hex digits),
 * which also keeps an unexpected answer out of the file name of the scope.
 *
 * @param {object} adb an adb wrapper bound to a specific serial
 * @returns {string|null}
 */
export function readAndroidId(adb) {
  try {
    const id = adb.shell('settings get secure android_id').trim()
    if (!id || id === 'null' || id === 'undefined') return null
    if (id.includes('\n')) return null
    // Android uses 16 hex digits; anything else is not a usable identity
    if (!/^[0-9a-f]{16}$/i.test(id)) return null
    return id
  } catch {
    return null
  }
}

/**
 * The **scope key** of a device: the identity under which the managed manifest
 * and the device lock are stored.
 *
 * The transport serial of a wireless device is `host:port`, which changes as
 * soon as the device reconnects (the pairing service assigns a new random
 * port) or the phone gets a new DHCP lease. Using it as the scope key would
 * therefore:
 *   - split the state of one physical device into several scopes (a USB run
 *     and a Wi-Fi run would not see each other's manifest)
 *   - lose the manifest when the port changes, which degrades the safe
 *     deletion into "delete nothing"
 *
 * So the scope is resolved from the device itself:
 *   1. `android_id` - unique per device, stable across the transports
 *   2. `ro.serialno` - the hardware serial number, but only when it is
 *      trustworthy (some ROMs report the same placeholder for every unit,
 *      which would merge two different devices into one scope)
 *   3. the transport serial - the last resort
 *
 * The prefix keeps the three sources apart, so that a device whose
 * `android_id` happens to look like a serial cannot collide with another one.
 *
 * @param {string} adbPath
 * @param {object} device the resolved device ({ serial })
 * @param {object[]} [onlineDevices] all the online devices
 * @returns {string}
 */
export function deviceScope(adbPath, device, onlineDevices = []) {
  const transport = device.serial
  const adb = createAdb(adbPath, transport)

  // The android_id is unique per device and does not change when the phone
  // switches between USB and Wi-Fi, so it is the preferred identity.
  const androidId = readAndroidId(adb)
  if (androidId) return `aid:${androidId}`

  const physical = readPhysicalSerial(adb)
  if (!physical) return `trn:${transport}`

  // The hardware serial is only used when it is trustworthy. Two devices that
  // report the same serial are usually the **same phone seen over two
  // transports** (USB and Wi-Fi at the same time); two devices of the same
  // kind reporting the same serial means a placeholder value, and then the
  // transport serial keeps them apart.
  if (onlineDevices.length > 1) {
    for (const other of onlineDevices) {
      if (!other.serial || other.serial === transport) continue
      const otherAdb = createAdb(adbPath, other.serial)
      // The other device has a trustworthy identity of its own, so the two
      // are genuinely different devices
      if (readAndroidId(otherAdb)) continue
      if (readPhysicalSerial(otherAdb) !== physical) continue
      // Same serial, same transport kind -> a placeholder, not an identity
      if (isWirelessSerial(other.serial) === isWirelessSerial(transport)) {
        return `trn:${transport}`
      }
    }
  }
  return `pid:${physical}`
}

/**
 * `adb connect <host:port>`.
 *
 * The call is bounded by a timeout: `adb connect` to an address that does not
 * answer (a device on another subnet, a wrong port) **blocks forever** in
 * some adb versions, which would hang the tool without any feedback.
 *
 * @param {string} adbPath
 * @param {string} address host:port of the wireless device
 * @param {number} [timeoutMs] the maximum time to wait
 * @returns {{ok: boolean, message: string}}
 */
export function adbConnect(adbPath, address, timeoutMs = 15000) {
  if (!isWirelessSerial(address)) {
    return {
      ok: false,
      message: `"${address}" is not a valid wireless address (expected host:port).`,
    }
  }
  let out = ''
  try {
    out = execFileSync(adbPath, ['connect', address], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r/g, '').trim()
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).replace(/\r/g, '').trim() : ''
    const stdout = e.stdout ? String(e.stdout).replace(/\r/g, '').trim() : ''
    const detail = stdout || stderr || e.message
    if (e.killed || e.signal === 'SIGTERM') {
      return {
        ok: false,
        message:
          `Could not connect to ${address}: no answer within ${timeoutMs}ms.\n` +
          `  Check that the device is on the same network as this machine, ` +
          `that wireless debugging is enabled, and that the port is correct.`,
      }
    }
    return {
      ok: false,
      message:
        `Could not connect to ${address}: ${detail}\n` +
        `  Check that the device is on the same network, that wireless ` +
        `debugging is enabled, and that the pairing was accepted.`,
    }
  }
  if (/^connected to /i.test(out) || /^already connected to /i.test(out)) {
    return { ok: true, message: out }
  }
  if (/^unable to connect to /i.test(out) || /^failed to connect to /i.test(out)) {
    return {
      ok: false,
      message:
        `Could not connect to ${address}: ${out}\n` +
        `  Check that the device is on the same network, that wireless ` +
        `debugging is enabled, and that the pairing was accepted.`,
    }
  }
  return { ok: false, message: out || `adb connect ${address} failed.` }
}

/**
 * `adb pair <host:port>` (the Android 11+ wireless debugging pairing).
 *
 * @param {string} adbPath
 * @param {string} address host:pair-port of the device
 * @param {string} [code] the pairing code shown on the device
 * @param {number} [timeoutMs] the maximum time to wait
 * @returns {{ok: boolean, message: string}}
 */
export function adbPair(adbPath, address, code, timeoutMs = 30000) {
  if (!isWirelessSerial(address)) {
    return {
      ok: false,
      message: `"${address}" is not a valid pairing address (expected host:port).`,
    }
  }
  try {
    // The pairing code is fed through stdin, otherwise adb would wait for it
    // on the terminal.
    const out = execFileSync(adbPath, ['pair', address], {
      encoding: 'utf8',
      input: code ? `${code}\n` : undefined,
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).replace(/\r/g, '')
    const trimmed = out.trim()
    if (/successfully paired/i.test(trimmed)) return { ok: true, message: trimmed }
    return { ok: false, message: trimmed || `adb pair ${address} failed.` }
  } catch (e) {
    const stderr = e.stderr ? String(e.stderr).replace(/\r/g, '').trim() : ''
    const stdout = e.stdout ? String(e.stdout).replace(/\r/g, '').trim() : ''
    return {
      ok: false,
      message: stdout || stderr || e.message,
    }
  }
}

/** Format a device list for display in error messages. */
export function formatDeviceList(devices) {
  return devices
    .map((d, i) => {
      const model = d.model || d.product || d.device || 'unknown model'
      const link = isWirelessSerial(d.serial) ? 'wireless' : 'usb'
      return `  ${i + 1}) ${d.serial}\n       model: ${model}  (${link})`
    })
    .join('\n')
}

/**
 * Resolve the target device.
 *
 * @param {string} adbPath
 * @param {string} [serial] device requested by the user via --serial
 * @param {{online: object[], offline: object[]}} [devices] a pre-fetched device list
 * @returns {{serial: string, model?: string, product?: string}}
 */
export function resolveDevice(adbPath, serial, devices) {
  const { online, offline } = devices || listDevices(adbPath)

  if (online.length === 0) {
    const extra = offline.length
      ? `\n  ${offline.length} device(s) are connected but not ready:\n${formatDeviceList(offline)}`
      : ''
    throw new Error(
      `No authorised Android device was detected.\n` +
        `  Check that USB debugging is enabled, that you accepted the authorisation ` +
        `prompt on the device, and that adb can reach it.${extra}\n` +
        `  For a wireless device, connect it first: adb connect <host:port>`
    )
  }

  if (serial) {
    const hit = online.find((d) => d.serial === serial)
    if (!hit) {
      const hint = offline.some((d) => d.serial === serial)
        ? `\n  Device ${serial} is connected but not ready (offline/unauthorized); ` +
          `accept the authorisation prompt on the device first.\n`
        : ''
      throw new Error(
        `The requested device ${serial} is not in the list of online devices.${hint}\n` +
          `  Available devices:\n${formatDeviceList(online)}\n` +
          `  Usage: --serial <SERIAL>`
      )
    }
    return hit
  }

  if (online.length > 1) {
    throw new Error(
      `${online.length} Android devices are connected at the same time, so the target ` +
        `device cannot be determined automatically.\n` +
        `  Available devices:\n${formatDeviceList(online)}\n` +
        `  Use --serial <SERIAL> to pick one.`
    )
  }

  return online[0]
}

/** Wrap adb calls so that they are always targeted at a specific serial. */
export function createAdb(adbPath, serial) {
  const base = ['-s', serial]

  return {
    serial,
    binPath: adbPath,
    raw: (args, opts) => adbRaw(adbPath, [...base, ...args], opts),
    shell: (cmd) => adbRaw(adbPath, [...base, 'shell', cmd]).trim(),
    push: (src, dest) =>
      adbRaw(adbPath, [...base, 'push', src, dest], { stdio: ['ignore', 'pipe', 'pipe'] }),
    forward: (args, opts) => adbRaw(adbPath, [...base, 'forward', ...args], opts),
  }
}
