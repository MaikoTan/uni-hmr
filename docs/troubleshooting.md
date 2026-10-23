# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `write EPIPE` | The streaming tar is being used. Use `push` plus the device-side extraction (already implemented in this tool) |
| `tar: bad header` | The same cause, the pty corrupted the binary stream |
| `tar: settime ...: Operation not permitted` with exit code 1 | The device-side tar is missing `-m` |
| `remote secure_mkdirs failed` | The target parent directory does not exist, create it with `mkdir -p` first |
| `No webview devtools socket found for the app (<pid>)` | The app is not running, or the pid changed after a restart. Check with `doctor` |
| `The app is not running: <pkg>` | Start the target app manually once |
| `The app process <pkg> did not come up within 20000ms` | `am start` returned but the app crashed on launch. Start it by hand and read `adb logcat` |
| `The navigation command was sent but the app did not land on <route>` | The page is not in `pages.json`, the route is misspelled, or the app redirected away from it (a login gate). Check the path with `--page` first |
| `--page` lands on the right page but the parameters are empty | The page reads a different key in `onLoad`, or the value needs percent-encoding |
| `run-to-page skipped: ...` in watch mode | The app was not running when the first sync finished. Start it, or use `uni-hmr launch --page ...` which starts it for you |
| `No installed application matches the appid <appid>` | The app has to be started at least once, or set `--pkg` manually |
| `DONE Build complete` never appears | It does appear during the first build; a timeout means the uni CLI is misbehaving, look at the forwarded log |
| The page does not refresh | Make sure the command is `snc:script debugRefresh`; the `snc:update` family does not refresh the DOM |
| The sync works but the page throws an error | Most likely a half-finished artifact was synced → increase `stableMs` |
| `Invalid artifact relative path (contains disallowed characters)` | A file name in the artifacts uses a character that the allow-list rejects (see [security](security.md#known-limitations)) |
| `No authorised Android device was detected` | USB debugging is off, the authorisation prompt was not accepted, or the device is in an offline/unauthorized state |
| `N Android devices are connected at the same time` | Several devices are attached, pick one with `--serial <SERIAL>` |
| `Another uni-hmr process (pid <pid>) is already working on this device` | Another uni-hmr process owns the device lock. Stop it, or use another device with `--serial`. The lock is released automatically when the owner dies |
| `Cannot connect to the device mini server (127.0.0.1:13131): connect ECONNREFUSED` | The adb port forward was removed by another process. A second uni-hmr process on the same device would do that; the device lock now prevents it |
| `Could not connect to <host:port>` | The wireless device does not answer. Check that the phone is on the **same network** as this machine, that wireless debugging is still enabled, and that the port is the current one (it changes on every reconnect) |
| `Could not connect to <host:port>: no answer within 15000ms` | The address does not answer at all. A phone behind a router that does a NAT without a port forwarding is not reachable, even when the phone can reach this machine |
| `The requested device <serial> is not in the list of online devices` (a wireless serial) | The phone reconnected and got a new port. List the devices with `doctor` and use the current serial |
| `error: unknown host service 'mdns:services'` | The `adb` binary was built without the mdns support, so the pairing port cannot be discovered automatically. Read the port from the screen of the device and pass it with `--pair` |
