# Development

```bash
cd uni-hmr
yarn install
yarn test        # node --test
```

## Layout

```
bin/uni-hmr.mjs      CLI entry point
src/adb.mjs          adb wrapper + the multi-device strategy + the wireless support
src/uni.mjs          uni CLI wrapper + fingerprint + debounce
src/sync.mjs         full tar / incremental md5 / the managed manifest
src/trigger.mjs      the snc commands + the CDP probe
src/project.mjs      discovery of the appid / package name / artifact directory
src/validate.mjs     shell quoting + the input allow-list validation
src/lock.mjs         the device scoped lock (one process per device)
src/cli.mjs          the sub-command orchestration
test/unit.test.mjs   the unit tests
docs/                the long form documentation
```

## The tests

The test suite is a pure unit test suite, it does not need a device:

```bash
node --test "test/**/*.test.mjs"
```

It covers the device parsing and the multi-device strategy, the manifest
diffing, the managed manifest (permissions, atomic write, symlink refusal), the
shell quoting and the input validation, the debounce behaviour, the port
forward cleanup, the archive naming, the CDP probe (stale hit rejection) and
the device lock (take, release, stale takeover, concurrent refusal).

The wireless support is covered as well: the detection of a `host:port`
transport serial, the resolution of the device identity (the same device over
USB and over Wi-Fi gets the same scope, two different devices do not), the
fallback to the transport serial, and the `adb connect` error handling.
