# Security

## Protection against command injection

Every command that is passed to `adb shell` (the device side runs `sh`) goes
through `src/validate.ts`:

| Validation function | Purpose | Rule |
|---|---|---|
| `shellQuote(value)` | POSIX single-quote escaping | `'` → `'\''` |
| `assertPackageName(pkg)` | Android package name | `/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/` |
| `assertAppid(appid)` | uni appid | `/^[A-Za-z0-9_-]+$/` |
| `assertRelPath(rel)` | Device-side relative path | Rejects absolute paths, empty segments, `.` / `..`, NUL; only `_ . @ + ~ ( ) [ ] -` are allowed inside a segment |
| `assertPagePath(page)` | uni-app page path (`--page`, the inline query is stripped first) | At least two segments, each `/^[A-Za-z0-9_-]+$/`, a leading slash is stripped |
| `assertPageQuery(query)` | Page query string (`--query` or the part after `?` in `--page`) | `/^[A-Za-z0-9._~%&=+,:@/-]*$/` (typo guard, not a shell boundary) |

Covered interpolation points: `sync.ts` (`remoteManifest` / `pushIncremental` /
`removeRemote` / `pushFullTar`), `cli.ts` (`mkdir -p` / `ls -d`),
`project.ts` (`lookupPackageByAppid`), `trigger.ts` (`pidof`, which
previously had **no quoting at all**).

The allow-list character set was derived from the real build output: the dist
holds 744 files and the only special character that occurs is `@`
(`uni_modules/my-module/static/html/js/uni-webview-js@1.5.4.js`).

## The safe semantics of the device-side deletion

`removeRemote()` **only deletes a file when both conditions hold**:

1. It is recorded in the **managed manifest** (a file that this tool pushed).
2. It no longer exists in the local artifacts.

> The www directory on the device also contains the `uni_modules/*/utssdk/*.uts`
> files written by the UTS compiler (they are not in dist but they are required
> at runtime). A blind `rm -rf` would delete them and break the app at runtime,
> so the managed manifest is mandatory.
>
> The paths additionally go through the `assertRelPath` allow-list, which
> blocks `../` traversal and shell metacharacters.

## The device lock

Only **one** process at a time may work on a device. Two watchers on the same
device would fight over the same managed manifest: the one that writes the
manifest describes a different set of files than the one that reads it, so the
reader deletes files that the writer still needs (measured in the wild:
`Removing 734 stale files` and a broken www directory on the device).

Therefore every sub-command that touches the device takes a **device scoped
lock** (`$TMPDIR/uni-hmr/<identity>__<pkg>__<appid>.lock`, mode `0600`) for the
duration of the run:

- the lock is taken with the `wx` flag, so it is atomic (no race between two
  processes that start at the same time)
- the lock file contains the **pid** of the owner; a lock whose owner process is
  gone is **stale** and is taken over, so a crashed run does not block the next
  one
- the second process **exits with an error** instead of corrupting the device:
  `Another uni-hmr process (pid <pid>) is already working on this device.`
- the scope is `device identity + package + appid`, so different devices and
  different applications can still run in parallel
- the lock is also released on `SIGINT` / `SIGTERM` / `SIGHUP` and on a normal
  exit

The lock also protects the **adb port forwards**, which are shared per device:
without it, a `probe` run during a watch would tear down the tunnels of the
watcher and the next refresh would fail with `ECONNREFUSED`.

## The local state file

- The managed manifest lives in the user cache directory (`$TMPDIR/uni-hmr/`),
  and the file name is derived from the device identity, the package name and
  the appid.
- The file name encoding is **lossless**: the safe characters are kept as is,
  the rest is hex encoded, and the hash of the original string is appended.
  The old implementation replaced every illegal character with `_`, which
  collapsed `192.0.2.55:5555` and `192.0.2.55_5555` into the same file -
  two devices would then share one manifest and the push history of one device
  would drive the deletion on the other device.
- The directory is `0700` and the file is `0600`; the permissions of an
  existing directory are **tightened** before writing (`mkdirSync` does not
  change the permissions of a directory that already exists).
- Before writing, `lstatSync` checks for **symbolic links** (both the file and
  the parent directory); a match aborts the write instead of overwriting.
- The write goes through a temp file and an **atomic `rename`**, so a crash
  cannot leave half-written JSON behind.

## The device identity

The scope of the lock and of the managed manifest is the **device identity**
rather than the transport serial, because the transport serial of a wireless
device (`host:port`) changes on every reconnect.

The identity is read from the device with two read-only commands:

| Source | Command | Property |
|---|---|---|
| `android_id` | `settings get secure android_id` | unique per device, identical over USB and Wi-Fi |
| `ro.serialno` | `getprop ro.serialno` | the hardware serial number |

- Both values are **read only** and are never written back; the tool never
  changes a setting of the device.
- The `android_id` is validated against the format Android uses (16 hex
  digits), so an unexpected answer cannot inject anything into the file name
  of the state directory.
- The hardware serial is only used when it is **trustworthy**: some ROMs
  report the same placeholder for every unit, which would merge two different
  phones into one scope. When two connected devices of the same kind report
  the same serial, the transport serial is used instead.
- The identity is stored **locally only**; it is not sent anywhere.

## The temporary archive files

- The local archive is created in a `0700` private directory whose name and
  file name both carry a random string. The old implementation used a
  **predictable** name such as `uni-hmr-full-${pid}.tar` in `/tmp`, and
  `tar -cf` follows an already existing symlink when writing → another user
  on the machine could pre-create
  `/tmp/uni-hmr-full-<pid>.tar -> ~/.bashrc` and make the archive overwrite an
  arbitrary file.
- The device-side archive path is **random on every round**
  (`/data/local/tmp/uni-hmr-<rand>.tar`); the push, the extraction and the
  cleanup all use the same name. The old implementation used the fixed path
  `/data/local/tmp/uni-hmr-full.tar`, which left a TOCTOU window between the
  push and the `tar -xmf` - any process on the device with shell permissions
  could replace the content and make the app load attacker-controlled JS.
- Whether it succeeds or fails, the device-side archive and the local temporary
  directory are cleaned up.

## The port forwards

`adb forward` creates a **local listener**:

- Once `tcp:19222 → localabstract:webview_devtools_remote_<pid>` is
  established, any process on the machine can connect to `127.0.0.1:19222` and
  execute arbitrary JS inside the app's WebView through CDP (which can read the
  login state and the cookies).
- `tcp:13131 → tcp:13131` works the same way and allows sending snc commands
  directly.

Therefore, apart from the `forward` sub-command (where the tunnels have to
stay alive for external tools), every sub-command **removes the tunnels on
exit** (`SIGINT` / `SIGTERM` / `SIGHUP` / normal exit).

## Supply chain

- **Zero runtime dependencies** (the `dependencies` field is empty), only Node
  built-in modules are used.
- The test runner is the Node built-in `node:test` / `node:assert`; the only
  development dependencies are TypeScript, `tsdown` (the bundler) and `tsx` (the
  TS loader used by the tests). The published package ships only the bundled
  `dist/` output.
- `dist/uni-hmr.mjs` is built from `bin/uni-hmr.ts`, has the permissions `0755`
  and keeps the `#!/usr/bin/env node` shebang.
- On the host side every call uses the array form of `execFileSync` /
  `spawn(process.execPath, [...])`, so the **host shell is never involved**;
  only the device side runs `sh`, and every tainted value that reaches it goes
  through the allow-list validation and the single-quote escaping.

## The CDP expression injection

The `probe()` and `navigateToPage()` functions in `trigger.ts` serialise
the markers and the page url with `JSON.stringify()` before interpolating them
into `Runtime.evaluate`, so the content is escaped correctly and there is **no
expression injection**.

`assertPageQuery()` is a typo guard, not a security boundary: the query never
reaches a shell, it travels as a JSON string inside the CDP expression. It
still rejects quotes, semicolons, backticks and `$()` so that a pasted command
fragment fails loudly instead of being sent to the app.

## Known limitations

The path allow-list of `assertRelPath` only allows `A-Za-z0-9._@+~()[]-`.
If the artifacts contain a file name with a **space / `%` / `,` / `!` / `#` /
`&` / `=`**, the sync **aborts with an error** (it does not silently skip),
and the error message lists the rejected paths.

This is a deliberate trade-off: relaxing the allow-list means relaxing the
shell injection surface. The measured dist (744 files) only contains one
special character, `@`.
