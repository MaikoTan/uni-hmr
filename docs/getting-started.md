# Getting started in a fresh project

This guide describes how to use `uni-hmr` in a uni-app project that has never
used it before.

## 1. Install

```bash
npm install -g uni-hmr
# or without a global install
npx uni-hmr doctor
```

## 2. Requirements

| Requirement | Notes |
|---|---|
| **Node ≥ 22** | The CDP probe uses the built-in `globalThis.WebSocket` |
| **A uni-app (vue3) project** | `@dcloudio/vite-plugin-uni` must be installed, so that `uni dev -p app-plus` produces `dist/dev/app` |
| **adb** | In `PATH`, or the `ADB` environment variable, or a standard SDK path |
| **A debug build of the app on the device** | The app has to be installed **and started at least once**, so that the runtime creates its `apps/<appid>/www` directory |
| **A debuggable APK** | `android:debuggable="true"` — required for the CDP probe |
| **A base with the DCloud debug channel** | See section 3 |
| **USB debugging** | Or wireless debugging, paired (see the README) |

## 3. Choose a base

The runtime refresh is delivered over the DCloud **mini server** (TCP `13131`
inside the app) and verified through the **Chrome DevTools Protocol**. Both
are only present in a *debug* build. There are two ways to get one.

### Route A — a custom base (recommended for a real product)

The DCloud debug server is shipped as an official AAR in the Android offline
SDK: `SDK/libs/debug-server-release.aar`. It contains the whole debug channel
(`io.dcloud.debug.*`, 48 classes) **and** the mini server
(`io.dcloud.common.util.net.http.LocalServer`).

Copy the AAR into your Android project and wire it into the `debug` variant
only:

```
app/libs/debug-server-release.aar
```

`app/build.gradle`:

```gradle
dependencies {
    implementation fileTree(dir: '../libs', include: ['*.aar'], exclude: [
            // The debug channel must not end up in the release variant
            'debug-server-release.aar'
    ])

    // Debug only
    debugImplementation files('../libs/debug-server-release.aar')
}
```

`app/src/debug/assets/data/dcloud_control.xml` — this is what turns the runtime
into a debug runtime. **Replace the appid with the appid of your project**:

```xml
<hbuilder debug="true" syncDebug="true">
<apps>
    <app appid="__UNI__YOUR_APPID" appver=""/>
</apps>
</hbuilder>
```

`app/src/debug/AndroidManifest.xml` — declare the debug service and allow
cleartext traffic (the debug channel uses `ws://` and `http://`):

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:usesCleartextTraffic="true">
        <service
            android:name="io.dcloud.debug.WebSocketService"
            android:exported="true" />
    </application>
</manifest>
```

> The AAR's own manifest already declares `WebSocketService`, `PullService` and
> `PullDebugActivity`, so merging it into the app manifest is enough — the
> explicit `<service>` above is only a safety net.

That is the whole device-side setup: **one AAR plus two small files**.

Build and install the `debug` variant, then start it once by hand. The runtime
seeds `assets/data/dcloud_control.xml` into
`/storage/emulated/0/Android/data/<package>/apps/<appid>/www/`.

### Route B — the HBuilderX standard base (zero Android work)

The standard base APK (`io.dcloud.HBuilder`) already contains the debug
channel and a `dcloud_control.xml` with `debug="true" syncDebug="true"`.

```bash
uni-hmr --pkg io.dcloud.HBuilder --appid HBuilder
```

No Android project, no AAR, no manifest edits. The downside is that the
appid is fixed to `HBuilder`, and the base cannot be customised.

> The mini server binds a **fixed port** (`13131`) on the device. Only one app
> can hold it at a time, so a standard base and a custom base cannot run side
> by side on the same device. Stop the other one first:
>
> ```bash
> adb shell am force-stop io.dcloud.HBuilder
> ```

## 4. Enable file watching

uni-app's app platform uses `build --watch`. Its watcher is bound to the
*inode* of each file, so `git checkout` and the atomic save of an editor
replace the file and the watch silently dies: the dev process is still alive,
but nothing rebuilds anymore.

Inject the polling mode in `vite.config.ts`:

```ts
export default defineConfig(({ mode }) => {
  if (process.env.UNI_PLATFORM === 'app' && mode === 'development') {
    process.env.CHOKIDAR_USEPOLLING ??= '1'
    process.env.CHOKIDAR_INTERVAL ??= '500'
  }
  return { /* ... */ }
})
```

> Do **not** use `build.watch.usePolling` (ignored by Vite) or
> `build.watch.chokidar.usePolling` (a TypeScript error). Do **not** guard the
> block with `if (config.build.watch)` either — that condition is always true,
> and the production build would never terminate.

## 5. Run it

```bash
cd <your-app-dir>

# 1) pre-flight check: adb, device, uni CLI, appid, artifacts, package, www dir
uni-hmr doctor

# 2) the HMR loop
uni-hmr
```

The loop is: build → detect the change → sync → `snc:script debugRefresh` →
verify through CDP. Press `Ctrl+C` to stop.

If `doctor` cannot resolve something, the fallbacks are:

| Situation | Fix |
|---|---|
| `No installed application matches the appid` | `--pkg <PACKAGE>` |
| The appid is not in `src/manifest.json` | `--appid <APPID>` |
| Several devices are attached | `--serial <SERIAL>` |
| A wireless device | `--connect host:port`, `--pair host:port --pair-code CODE` |
| The page shows no marker | `--mark "MYMARKER"` |

### Run to a specific page

Both the loop and a plain cold start can land on a specific page, the same way
HBuilderX "run to page" does:

```bash
# land on the page after the first sync, then keep watching
uni-hmr --page pages/index/index

# cold start the app and land on the page with query parameters
uni-hmr launch --page "/pages/detail/detail?id=42&tab=info"

# the query may also be passed separately
uni-hmr launch --page pages/detail/detail --query "id=42&tab=info"
```

The page path comes from `pages.json` (`pages/a/b`; a leading slash is
accepted too). The query is written inline after `?` or passed with `--query`,
which is appended after an inline query. Percent-encode non-ASCII values
(`title=%E4%B8%AD%E6%96%87`). `launch` does not need the uni CLI, because it
never builds.

## 6. The probe marker

The CDP probe looks for a marker string in the rendered page. The default is
`HMRMARK`; put it somewhere that is always visible, for example in `App.vue`:

```html
<template>
  <view>
    <!-- HMRMARK -->
    <router-view />
  </view>
</template>
```

The marker is only used for **verification**. The refresh itself works
without it — the loop then reports `the view was updated (the marker is gone,
the DOM changed)`. A marker that is a substring of another marker produces
false positives, so use a unique string.

## 7. What this is not

- It is **not** a module-level hot replacement. The whole service bundle is
  reloaded and the view is rebuilt.
- **UTS / native plugins** are re-initialised on every reload. A plugin that
  was captured in a module-level variable may be invalid after the reload —
  wrap such calls in `try/catch` and re-acquire the plugin.
- The **release** build contains no debug channel, so HMR is impossible there.
  Only the `debug` variant works.

## 8. Verification on a real device

The flow above was verified on a physical Android 13 device with the
HBuilderX standard base:

```bash
uni-hmr sync --pkg io.dcloud.HBuilder --appid HBuilder --full
# -> 744 files, 1518 ms

uni-hmr trigger --pkg io.dcloud.HBuilder
# -> Sent: snc:script debugRefresh

uni-hmr probe --pkg io.dcloud.HBuilder --mark "HMRMARK,App Launch"
# -> === pages/mine/login/login[2] === innerTextLen=…
#    HIT  HMRMARK
```

A text change in the artifact was confirmed through the CDP DOM, so the page
really re-rendered on the device.

## 9. Troubleshooting

See [troubleshooting](troubleshooting.md). The most common causes:

| Symptom | Cause |
|---|---|
| The device never rebuilds | The polling injection of section 4 is missing |
| `No webview devtools socket found` | The app is not running, or its pid changed |
| `Cannot connect to the device mini server` | The port forward was removed by another process |
| The page reloads but shows the old content | The artifacts were only half written — the tool waits for the build to settle, so this usually means a build error |