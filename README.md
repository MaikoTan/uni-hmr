# uni-hmr

Hot update tool for **uni-app** (App platform) development. One command does the
whole loop: build → incremental sync to a real device → runtime refresh → DOM
verification.

- Zero runtime dependencies (Node built-in modules only)
- Node ≥ 22

## Install

```bash
npm install -g uni-hmr
# or, without a global install
npx uni-hmr
```

## Usage

Run it from the root of the uni-app project:

```bash
uni-hmr                      # the app-plus platform by default
uni-hmr --mark "HMRMARK"     # set the probe marker
uni-hmr --page pages/index/index   # run to a page after the first sync
uni-hmr launch --page "/pages/detail/detail?id=42"   # cold start on a page
```

### Options

| Option | Description | Default |
|---|---|---|
| `--serial <SERIAL>` | Target device (required when several devices are connected) | automatic |
| `--connect <HOST:PORT>` | Connect a wireless device before running | — |
| `--pair <HOST:PORT>` | Pair with a wireless device | — |
| `--pair-code <CODE>` | The pairing code shown on the device screen | — |
| `--pkg <PACKAGE>` | Application package name | resolved from the appid on the device |
| `--appid <APPID>` | uni appid | read from `src/manifest.json` |
| `--cmd <CMD>` | Refresh command | `snc:script debugRefresh` |
| `--cdp-port <PORT>` | CDP port | `19222` |
| `--mark <A,B>` | Probe markers, comma separated | `HMRMARK` |
| `--page <PATH[?Q]>` | Run to a specific page, e.g. `pages/index/index` or `/pages/a/b?id=42` | — |
| `--query <A=1&B=2>` | Extra page parameters, appended to the query of `--page` (percent-encode non-ASCII) | — |
| `--no-trigger` | Do not send the refresh command after a sync | — |
| `--no-probe` | Do not run the CDP verification after a refresh | — |
| `--full` | Force a full tar sync | full on the first run, md5 diffing afterwards |
| `-v`, `--version` | Print the version | — |
| `-h`, `--help` | Print the usage | — |

### Wireless debugging

The tool works with a device that is connected over ADB over TCP/IP. Connect
it once with `adb connect`, then address it by its transport serial:

```bash
adb connect 192.0.2.55:5555
uni-hmr --serial 192.0.2.55:5555
```

Or let the tool connect for you:

```bash
uni-hmr --connect 192.0.2.55:5555
```

For a device that has never been paired (Android 11+ wireless debugging):

```bash
uni-hmr --pair 192.0.2.55:37000 --pair-code 123456 --connect 192.0.2.55:5555
```

> The port of a wireless device changes when it reconnects, so the tool
> identifies the device by its hardware identity instead. The same phone
> reached over USB and over Wi-Fi therefore shares one manifest and one lock.

### Run to a page

`--page` lands on a specific page instead of the entry page, like the
HBuilderX "run to page" action:

```bash
uni-hmr --page pages/index/index                           # after the first sync
uni-hmr launch --page "/pages/detail/detail?id=42&tab=info" # cold start on a page
uni-hmr launch --page pages/detail/detail --query "id=42"   # same, split in two options
```

`--page` takes the route from `pages.json` (`pages/a/b`; a leading slash is
accepted) and may carry the query inline (`pages/a/b?id=42`). `--query` is an
alternative way to pass the parameters and is appended after an inline query.
Percent-encode non-ASCII values. Quote the value when it carries a query
(`--page "/pages/a/b?id=42"`), because `?` is a shell glob character. See
`docs/how-it-works.md` for why this is done over CDP instead of through the
runtime launch arguments.

### Sub-commands

| Sub-command | Description |
|---|---|
| `watch` | The complete HMR loop (the default) |
| `doctor` | Environment pre-flight check |
| `sync` | Sync once, without starting uni |
| `forward` | Establish the port forwards only |
| `probe` | CDP probe, checks whether the marker is present |
| `trigger` | Send one refresh command only |
| `launch` | Cold start the app, optionally landing on `--page` |

> Only one process at a time may work on a device. A second one exits with an
> error instead of corrupting the files on the device.

### Environment variables

`ADB`, `PKG`, `APPID`, `CMD`, `CDP_PORT`, `MARK`, `UNI_HMR_SERIAL`,
`UNI_HMR_CONNECT`, `UNI_HMR_PAIR`, `UNI_HMR_PAIR_CODE`.

### Requirements

- **Node ≥ 22** (the CDP probe uses the built-in `globalThis.WebSocket`)
- **adb** in `PATH`, or the `ADB` environment variable, or a standard SDK path
- The target app installed and **started at least once**
- `@dcloudio/vite-plugin-uni` installed in the project
- USB debugging enabled and authorised on the device, or wireless debugging
  enabled and paired

## Documentation

- [How it works](docs/how-it-works.md)
- [Security](docs/security.md)
- [Cross-platform support](docs/cross-platform.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Development](docs/development.md)

## License

[LGPL-3.0-only](LICENSE)
