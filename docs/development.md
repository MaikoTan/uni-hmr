# Development

```bash
cd uni-hmr
yarn install
yarn typecheck   # tsc --noEmit
yarn build       # tsdown -> dist/uni-hmr.mjs
yarn test        # node --test with the tsx loader
```

The package is written in TypeScript (5.x) and bundled by `tsdown`; Yarn manages
the dependencies. `dist/` is generated, it is not checked in.

## Layout

```
bin/uni-hmr.ts       CLI entry point (the package `bin` points at the build output)
src/adb.ts           adb wrapper + the multi-device strategy + the wireless support
src/uni.ts           uni CLI wrapper + fingerprint + debounce
src/sync.ts          full tar / incremental md5 / the managed manifest
src/trigger.ts       the snc commands + the CDP probe
src/project.ts       discovery of the appid / package name / artifact directory
src/validate.ts      shell quoting + the input allow-list validation
src/lock.ts          the device scoped lock (one process per device)
src/cli.ts           the sub-command orchestration
test/unit.test.ts    the unit tests
tsdown.config.ts     the bundler configuration (ESM, node22, sourcemap)
tsconfig.json        the type checking configuration (noEmit, strict)
docs/                the long form documentation
```

## The tests

The test suite is a pure unit test suite, it does not need a device:

```bash
yarn test
```

It runs the TypeScript sources directly through the `tsx` loader:

```bash
node --import tsx --test "test/**/*.test.ts"
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
