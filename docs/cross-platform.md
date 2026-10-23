# Cross-platform support

`uni-hmr` is **not bound to Linux**. It has zero third-party runtime
dependencies and only uses the Node built-in modules, so it runs on Linux,
macOS and Windows. What is bound to a platform is the **target device**
(Android), not the host OS.

| Capability | Linux | macOS | Windows |
|---|---|---|---|
| `yarn run uni-hmr` | ✅ | ✅ | ✅ |
| Automatic discovery of the `uni` CLI | ✅ | ✅ | ✅ |
| Incremental sync / full tar sync | ✅ | ✅ | ✅ |
| CDP probe | ✅ | ✅ | ✅ |
| Run to a page (`--page` / `launch`) | ✅ | ✅ | ✅ |
| `adb` auto-detection | `~/Android/Sdk` `/usr/local/bin` `/usr/bin` | `~/Library/Android/sdk` | `%LOCALAPPDATA%\Android\Sdk` |

## The platform differences

### 1. The shape of `node_modules/.bin/uni` (already handled)

- Linux / macOS: `node_modules/.bin/uni` is a **symlink** to `bin/uni.js`.
- Windows: Yarn / npm generate a **shell shim script** (`.cmd` / `.ps1`) whose
  content is a batch file such as `@SET PATHEXT=...`, not JavaScript.

Calling `spawn(process.execPath, [bin])` on Windows parses the shim as JS and
crashes.

> **How it is avoided**: the `findUniEntry()` function in `src/project.ts` uses
> `createRequire(path.join(dir, 'package.json')).resolve('@dcloudio/vite-plugin-uni/bin/uni.js')`
> to look up the **real JS entry** level by level, and only falls back to the
> `.bin/uni` shim when it cannot be found.
> Note that `createRequire` has to be **rebuilt with the `package.json` of each
> level**, otherwise the resolution path does not follow the directory walk.

### 2. The host `tar`

The full sync calls the host `tar` to create the archive (Windows 10+ ships
bsdtar, macOS uses the BSD tar with pax as the default). The toybox `tar` on
the device was verified to unpack GNU, pax and pax archives carrying
`SCHILY.xattr` correctly (exit=0), so the **archive format is not a
cross-platform blocker**.

### 3. Path handling

The host paths are handled with `node:path` throughout, and they are normalised
to the POSIX form with `.split(path.sep).join('/')` when they are converted
into device-side relative paths.

## The multi-device behaviour

| Online devices | Behaviour |
|---|---|
| 0 | Fails with an error and points at the USB debugging / authorisation check; the offline and unauthorized devices are listed as well |
| 1 | Selected automatically |
| >1 | **Fails with an error and lists the selectable devices** (serial + model) and asks for `--serial` |

A `--serial` device that is not online produces the same kind of error, with
the list of the available devices. Every adb call carries `-s <serial>`, so
nothing is ever pushed to the wrong machine.

## Wireless debugging

The tool is not bound to the USB cable. A device that is reached over ADB over
TCP/IP works the same way, because every adb call is made with `-s <serial>`
and the transport serial of a wireless device is just another serial.

### Addressing a wireless device

The transport serial of a wireless device is `host:port`:

```bash
adb connect 192.0.2.55:5555
uni-hmr --serial 192.0.2.55:5555
```

The tool can also do the connection itself:

```bash
uni-hmr --connect 192.0.2.55:5555
```

For a device that has never been paired (the Android 11+ wireless debugging
pairs once and then connects on a port that changes every time):

```bash
uni-hmr --pair 192.0.2.55:37000 --pair-code 123456 --connect 192.0.2.55:5555
```

> `adb connect` **blocks forever** when the address does not answer in some adb
> versions, so the tool bounds the call with a timeout and reports a readable
> error instead of hanging.

### The device identity

The transport serial of a wireless device is **not stable**: the pairing
service assigns a new random port every time the phone reconnects, and the
DHCP lease can change the IP address.

The managed manifest and the device lock are therefore keyed by the **device
identity** instead of by the transport serial:

| Priority | Source | Property |
|---|---|---|
| 1 | `android_id` (`settings get secure android_id`) | unique per device, identical over USB and Wi-Fi |
| 2 | `ro.serialno` (`getprop ro.serialno`) | the hardware serial, used only when it is trustworthy |
| 3 | the transport serial | the fallback |

The hardware serial is not trusted blindly: some ROMs report the same
placeholder value for every unit, which would merge two different phones into
one scope (and therefore into one manifest and one lock). When two connected
devices of the same kind report the same serial, the transport serial is used
instead.

The consequence is that the same phone reached over USB and over Wi-Fi shares
one manifest and one lock, so the two transports cannot delete each other's
files on the device.

### What does not work over Wi-Fi

`adb mdns services` is used by `adb pair` to discover the pairing port
automatically. It is not always compiled into the `adb` binary (the
`platform-tools` of some distributions report
`error: unknown host service 'mdns:services'`), so the pairing port has to be
read from the screen of the device in that case.

