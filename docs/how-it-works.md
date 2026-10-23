# How it works

```
  ┌─ uni dev watch (node .../vite-plugin-uni/bin/uni.js -p app-plus)
  │      ↓ writes to dist/dev/app
  │   fingerprint polling + time window debounce    ← src/uni.ts
  │      ↓ "the build is complete"
  │   md5 diff → adb push                           ← src/sync.ts
  │      ↓
  │   snc:script debugRefresh                       ← src/trigger.ts
  │      ↓
  │   CDP probe verifies that the marker is present  ← src/trigger.ts
  └──────────────────────────────────────────────────────────
```

## 1. The build completion signal

The `output()` function of the uni CLI **swallows two consecutive identical
messages** (the same type + the same msg returns early). During an incremental
build `DONE  Build complete.` is very likely to be byte-identical to the
previous round, so the signal is de-duplicated and never shows up on stdout.

The tool therefore uses a **dual-signal** strategy:

| Scenario | Signal |
|---|---|
| First full build | the stdout `DONE  Build complete.` |
| Later incremental builds | polling the **artifact fingerprint** (mtime + size of the top level files, plus the directory mtime) |

## 2. Debounce: why a time window and not a poll counter

A single build writes to disk in several rounds (measured: 3 rounds within
about 300ms):

```
T+16.2s  app-config-service.js / app-config.js / manifest.json
T+16.4s  __uniappview.html / app-renderjs.js / app-service.js(6291456) / app-wxs.js / app.css
T+16.5s  app-service.js settles to its final value 7427690
```

Note that the intermediate `app-service.js` is only 6291456 bytes while the
final one is 7427690 bytes. Syncing in the middle would push **half-finished
JavaScript** to the device (syntax errors, blank screen).

The rule is therefore: the fingerprint has to stay **unchanged for `stableMs`
(default 1000ms)** before the build counts as finished.

- A "unchanged for N consecutive polls" counter is unreliable: the poll interval
  is fixed, so if two write rounds are further apart than the interval the build
  would be declared stable halfway through.
- A time window matches the real build duration much better.
- The extreme case (the artifacts keep changing) is covered by `maxSettleMs`
  (default 15s), so the tool never hangs forever.

Additionally: when the artifacts did not actually change (`mode: "noop"`) the
page is **not** refreshed, which avoids a pointless view reload.

## 3. Full sync: why `tar | adb shell tar -x` does not work

The original streaming approach failed at two points:

1. `Error: write EPIPE` — `adb shell` allocates a pty by default and the
   terminal line discipline corrupts the binary stream.
2. Adding `-T` to disable the pty turned it into `tar: bad header` — the Node
   pipe and the adb shell protocol still have boundary problems.

> It was verified that the tar header read on the Node side is `2e2f00...`
> (`./` plus zero padding), a **valid ustar name field**, so the local data was
> fine and the problem was in the transport channel.

**The correct approach** is to use the standalone file transfer channel of
`adb push` (the SYNC protocol, binary safe and md5 verifiable):

```
tar -cf <tmp>.tar -C dist/dev/app .
  → adb push <tmp>.tar /data/local/tmp/uni-hmr-full.tar
  → adb shell "cd <remoteDir> && tar -xmf /data/local/tmp/uni-hmr-full.tar"
```

Measured: **71MB / 744 files ≈ 1.5s**.

Two pitfalls:

- The parent directory has to be created with `mkdir -p`, otherwise `adb push`
  reports `remote secure_mkdirs failed: Operation not permitted`.
- `tar -xmf` is required (`-m` = do not restore the mtime). sdcard does not
  support setting the time on a directory, and without `-m` you get 160+ lines
  of `tar: settime ...: Operation not permitted` and an **exit code 1** (even
  though the files were extracted correctly).

## 4. Incremental sync and the safe deletion policy

Incremental sync compares the local md5 manifest against the device side
`find . -type f -exec md5sum {} +` and only pushes the files whose md5 differs.

> The deletion policy is **safety first**: besides the dist artifacts, the www
> directory on the device also holds the **`uni_modules/*/utssdk/*.uts` source
> files written by the UTS compiler** (they are not in dist but they are
> required at runtime). So only the files that **this tool pushed itself**,
> that are recorded in the managed manifest, and that no longer exist locally
> are deleted. The managed manifest lives **locally**
> (`$TMPDIR/uni-hmr/<identity>__<pkg>__<appid>.json`); when it is lost the tool
> degrades to "delete nothing" - the safe direction.
>
> Because the manifest describes "what this machine pushed", only **one
> process at a time** may work on a device - otherwise the two processes would
> delete each other's files on the device. A device scoped lock
> (`<identity>__<pkg>__<appid>.lock`) enforces that; the second process exits
> with an error. See [security](security.md#the-device-lock).
>
> The scope uses the **device identity** rather than the transport serial, so
> that the same phone reached over USB and over Wi-Fi shares one manifest and
> one lock. See [cross-platform](cross-platform.md#the-device-identity).

## 5. The runtime refresh

The `snc` commands (semantics confirmed on a real device):

| Command | Effect |
|---|---|
| `snc:script debugRefresh` | Restarts the whole weex instance, the service and the view are rebuilt together ✅ **the only path that refreshes the view DOM** |
| `snc:update _www/app-service.js` | Hot-swaps only the service bundle, **the DOM is not refreshed** ❌ |
| `snc:update all` | Reloads only the view webview → blank view ❌ |
| `snc:update current` | Reloads only the first webview ❌ |

The command must be a **bare string with no trailing newline** — the device
matches it exactly with `PdrUtil.isEquals`, so a trailing `\r\n` makes the
branch fail to match.

## 6. The CDP verification

The tool forwards `localabstract:webview_devtools_remote_<pid>` to a local port
and uses the CDP `Runtime.evaluate` to read `document.body.innerText` and check
whether the marker is present.

There are two CDP targets: `View` (the empty app-service container page) and
`pages/index/index[N]` (the real page DOM). The probe **scans both targets**.
The marker has to be a unique string (`HMRMARK`); do not use a substring like
`Laptop` that is contained in `LaptopHMR2`, otherwise you get false positives.

## 7. Run to a page

`--page` / `uni-hmr launch` reproduce the HBuilderX "run to page" action: the
app starts and lands on one page with its query parameters, instead of on the
entry page from `pages.json`.

`--page` accepts the whole url (`/pages/a/b?id=42`) or a bare path plus
`--query`; the path and the query are validated separately and only then joined
into the `uni.reLaunch` url.

The obvious channel would be the runtime launch arguments, and it does not
work. The DCloud runtime reads a set of intent extras
(`unimp_direct_data`, `unimp_run_extra_info`, `unimp_run_arguments`,
`__launch_path__`, `__extras__`), but on a real device every one of them is a
dead end for a cold start triggered with `adb shell am start`:

- `IntentConst.obtainArgs` blacklists the `unimp_*` keys and
  `__launch_path__`, so they never reach the JS layer at all.
- `__extras__` does arrive (`plus.runtime.arguments` contains the payload), but
  the framework only parses it when `plus.getRedirectInfo()` is **absent**.
  In the service layer that module exists and returns `null`, because it needs
  a Weex webview instance that the service layer does not own, so the payload
  is silently dropped.

So the page is reached **after** the app is up, over CDP:

```
am force-stop <pkg>
am start -n <pkg>/<launcher activity>
wait for the process (pidof) and the devtools socket
forward localabstract:webview_devtools_remote_<pid>
wait until the entry page rendered and its DOM settled   ← the app's own
                                                            launch redirects
                                                            (login gate, token
                                                            refresh) must finish
                                                            first
Runtime.evaluate: uni.reLaunch({ url: '/pages/a/b?id=42' })
verify: the CDP target title becomes pages/a/b[N]
```

`uni.reLaunch` rather than `uni.navigateTo`: "run to a page" means landing
there with a clean page stack, exactly like a cold start; `navigateTo` would
push the page on top of the current one and the back button would leave it.

Two details worth knowing:

- The evaluation is **fire-and-forget**. The built-in WebSocket client does not
  set `awaitPromise`, so the `success` callback of `uni.reLaunch` cannot be
  awaited over CDP. The result is verified by watching the CDP target titles
  instead, which also proves the view really changed.
- The launcher activity is **resolved on the device**
  (`cmd package resolve-activity --brief`) rather than hardcoded: it is
  `io.dcloud.PandoraEntry` for the DCloud runtime, but a plain `MainActivity`
  for an app that embeds the SDK differently.
