# claude-zhtw

Adds Traditional Chinese (Taiwan) to Claude Desktop on macOS as a **new locale
entry**. English and every shipped locale stay available and untouched; nothing
is hijacked or replaced.

    bin/patch-claude status          # version, signature, applied?, watcher, pending adaptation
    bin/patch-claude install         # patch + re-sign + exec-probe + swap. Launches nothing.
                                     #   --dry-run  stage only, never touch /Applications
                                     #   --no-agent skip the watcher
                                     #   --verify   also run the two-launch check, roll back on failure
    bin/patch-claude adapt           # Claude was updated -> re-apply. ASKS FIRST; only
                                     # then quits Claude, re-patches, re-signs, relaunches.
                                     #   --yes      explicit confirmation on the command line
                                     #   --dry-run  stop right before the install
    bin/patch-claude watch           # what the LaunchAgent runs: detect + notify. Never
                                     # installs, never calls codesign.
                                     #   --check    report only, write nothing
                                     #   --dry-run  print the notification instead of posting it
    bin/patch-claude uninstall       # restore latest backup, remove the watcher
    bin/patch-claude verify          # re-run the runtime health check on demand
    bin/patch-claude rearm           # clear a durable self-disarm; next launch re-arms
    bin/patch-claude agent-install   # install + load the watcher (and remove legacy agents)
    bin/patch-claude agent-uninstall # unload + remove it
    bin/patch-claude sync            # diff installed English vs TM -> pending.json
    bin/patch-claude merge FILE.json # fold translations back into the TM
    bin/patch-claude gated           # dump the gated_messages namespace

Only `install` and `adapt` ever re-sign, and both are user-initiated: `install`
is typed, `adapt` refuses to move without a keypress (or an explicit `--yes`).
Nothing in the background re-signs, because every re-signature costs the user a
Keychain password prompt — see "Two kinds of change" below.

## How the locale is added

Claude Desktop loads its main UI remotely from `https://claude.ai/epitaxy`;
`Contents/Resources/ion-dist/` is an unused fallback copy, so patching local
files does nothing. The shim runs in the Electron **main** process and redirects
exactly three kinds of request through `webRequest.onBeforeRequest`. Everything
else falls through to the app's own listener untouched.

1. `/i18n/zh-TW.json`, `/i18n/dynamic/zh-TW.json`, `/i18n/zh-TW.overrides.json`
   -> local catalogs. All three are required; the loader throws without them.
2. `/edge-api/bootstrap/<org>/app_start` -> re-fetched and rewritten so
   `locale` and `gated_messages.locale` both say `zh-TW`.
3. The one asset chunk containing the locale whitelist -> a patched copy with
   `"zh-TW"` spliced into the array, **enumerable but not a member** (below).

### `zh-TW` may enter the UI; it may never enter an outbound payload

That whitelist array does two unrelated jobs, and only one of them may see
`zh-TW`. Traced in the live bundle (`shared-2-DBb3I6k4`, 2026-08-20), the array
is exported from `shared-2` and consumed four times:

| consumer | operation | job |
|---|---|---|
| `shared-13` language menu | `Na.map(...)`, `Na.length` | enumerate the offered locales |
| `shared-15` boot negotiation | spread + iteration inside `Sv()` | resolve `spa:locale` / desktop `config.json` to a locale |
| `shared-5` `nw()` chat-send body | `co.includes(e.locale) ? e.locale : Za` | **is this a locale the server knows?** |
| `shared-4` `LU()` help links | `Ya.includes(a)` | **is this a locale the server knows?** |

The stock client uses `.includes()` as its own guard: anything the server would
not accept degrades to `"en-US"`. Splicing `"zh-TW"` into a plain array satisfied
the two enumerating consumers *and* disarmed that guard, so
`POST /api/organizations/<org>/chat_conversations/<uuid>/completion` started
carrying `locale:"zh-TW"` and the server answered

```
locale: Input should be 'en-US', 'de-DE', 'fr-FR', 'ko-KR', 'ja-JP', 'es-419',
        'es-ES', 'it-IT', 'hi-IN', 'pt-BR' or 'id-ID'
```

— a **blocking** failure: no message could be sent. That list is byte-identical
to the array's unpatched contents, order included, which is what makes the array
a mirror of the server's own enum rather than a UI preference list.

So the patch splices `"zh-TW"` in **and** gives that one array an own,
non-enumerable `includes` that answers `false` for `"zh-TW"` only. Iteration,
spread, `map`, `length`, `JSON.stringify`, `Object.keys` are all unchanged, so
the menu still lists 繁體中文 and boot negotiation still resolves it; every
`.includes()` gate falls back to the vendor's own `"en-US"` default, which is
exactly the path a locale the server does not know takes anyway.

This is a property of the value the shim injects, not a filter on the request
path. `onBeforeRequest` cannot rewrite a request body at all, and adding a
permanent outbound rewriter to the critical path is what produced the black
screen described below. `Array.prototype` is never touched — only this one array
object gets an own property.

`patchChunk` proves the two halves by **evaluating** the rewritten initialiser
before the chunk is ever served (`verifyLocaleArrayExpr`): enumerable, correct
length, `includes("zh-TW") === false`, `includes("en-US") === true`. Any failure
means the chunk is served unpatched — English, fully usable.

`chunk-cache.json` carries `pv` (the rewrite-semantics version, currently `2`).
A cache written by an older rewrite is ignored and re-probed, so a semantics fix
takes effect on the next launch instead of being masked by the previous body.

**Known residual, non-blocking.** The language menu's own `switchLocale` does
`PUT /api/account_profile {locale:<clicked code>}` *before* it stores the
override, and that call is not behind `.includes()`. Picking 繁體中文 while on
another language therefore raises the same 422 toast and the pick does not stick.
It is not needed in practice: `patch-claude` writes `locale` into the desktop
`config.json`, and the renderer's `Ow()` turns that into `spa:locale` +
`localeOverride` on its own. Fixing it would mean patching a second, lazily
loaded chunk.

`protocol.handle('https')` is deliberately **not** used. Taking over the whole
https scheme is what produced a black screen in an earlier revision: a single
pass-through failure kills every request on the page.

## Two kinds of change, and why only one of them may re-sign

"Claude changed" means two completely different things, with costs an order of
magnitude apart. Keeping them apart is the whole shape of this tool.

**(1) A new remote frontend build.** The whitelist chunk
(`.../assets/v1/shared-common-3-<hash>.js` at the time of writing) gets a
new content hash. The bundle on disk is byte-identical; our injection is still
there. The shim fetches the new chunk, patches it in memory and serves it — on
the **same launch**, with no restart, no disk write and no re-signature. This is
the common case and it is free.

**(2) The desktop app itself was updated.** A manual DMG install replaces the
whole bundle with Anthropic's stock build; not one line of ours survives.
(Squirrel's own in-app updater works again — see *Keeping Squirrel alive*
below — so this case now also arrives on its own, not only from a manual DMG.)
Recovering
means re-patching the asar and re-signing, and **every re-signature costs the
user at least one Keychain password prompt** (below). So it may only happen
after the user says yes.

The two are not told apart by a flag. They are told apart by *which observer is
still alive*:

| observer | exists when | can see | may conclude |
|---|---|---|---|
| the shim, in Claude's main process | the bundle is still ours | remote chunk URLs, its own health | case 1 only — never "re-patch needed" |
| `patch-claude watch`, from the LaunchAgent | always | `Info.plist`, our two files, the asar main | case 2 only — never remote builds |

The shim running *is* the proof that the bundle is ours, so everything it can
observe belongs to case 1; it has no path that requests a re-patch or a restart.
`reapply_reason()` only reads the bundle, so it can never fire on a remote build.
A remote build that the shim cannot adapt (Anthropic moved the whitelist out of
`shared-2`) is still case 1: re-signing would change nothing about bytes served
from claude.ai. It logs `ZHTW-REMOTE-SHAPE`, falls back to English, and asks for
nothing.

### Adapting to a new remote build, in place

The whitelist chunk is recognisable from its URL alone, which is what makes the
same-launch path possible. Scanning all ~2200 JS files of a shipped bundle with
`patchLocaleWhitelist` itself yields exactly one hit — the same file the URL
shape picks. So the candidate set per launch is a single URL, and the cost of
probing inline is one extra fetch of one file, only when there is no validated
rewrite for that URL yet.

The shape is `/assets/v1/shared-<name>?-<n>-<hash>.js`, and neither `<name>` nor
`<n>` may be hardcoded — both have moved, and each move cost one English launch
before the pattern was widened:

| observed in | URL |
|---|---|
| up to 1.37937.2 | `shared-2-<hash>.js` |
| 1.37937.3 | `shared-3-<hash>.js` |
| 1.44121.4 | `shared-common-3-<hash>.js` |

`CHUNK_RE` therefore accepts an optional lowercase name segment, and the family
key that `FAM_RE` extracts includes it, so `common-3` and `3` are different
families and cannot mis-match each other. The digits stay mandatory, which is
what keeps `shared-frame-<hash>.js` — a real sibling with no number — out.

The family key matters because every chunk is requested at almost the same
moment and only one request may be held per launch: without it the single hold
is spent on whichever chunk arrives first.

`onBeforeRequest` holds that one callback (5 s cap, plus a 6.5 s backstop
timer), fetches the chunk, patches it, caches it in `chunk-cache.js` keyed by
the content-hashed URL, and redirects. Steady state — cache hit — skips all of
it. A redirect is only ever issued for a URL whose patched body is in memory and
hash verified. Timeout, network error, regex miss and unexpected `import.meta`
shapes all resolve to "let the original request through", so the failure mode is
an English UI, never a dead app or a held page. Background discovery is retained
underneath as the fallback for the day the URL shape stops holding.

Relative import specifiers in the patched chunk are rewritten to absolute URLs
against the original https base, and `import.meta.url` becomes a literal of the
original URL. Without this the module graph splits and the renderer dies —
verified with a control run.

## Runtime verification and rollback

### `install` launches nothing

The default sequence is quit-check -> stage -> exec probe -> re-check -> swap.
An installer that closes the user's Claude and then opens and closes it twice by
itself reads as "this tool is messing with my machine", and that perception cost
is real when the tool is handed to colleagues. The old two-launch check is kept
behind `install --verify` and as the standalone `verify` subcommand.

What the removed launches used to catch, and what covers it now:

| failure                                   | old net           | now |
|-------------------------------------------|-------------------|-----|
| bundle cannot exec at all (bad re-sign, AMFI SIGKILL) | exec probe | exec probe, unchanged, still before `/Applications` is touched |
| rewrite breaks the renderer (black screen) | launch 1/2 + auto-rollback to backup | shim self-heal: disarm + one reload at 90 s -> working English UI; second launch disarms at startup |
| bundle execs but the app never renders, and the shim also fails to load or log | launch 1/2 | **nothing.** The user sees it on their own first launch and must run `uninstall` |

The third row is the honest cost. The exec probe proves the process is not
SIGKILLed at exec; it does **not** prove a window ever appears. The shim's
self-heal only fires if the shim itself is running. A failure that kills the app
between exec and shim load is now caught by the user, not by the installer.

#### The probe stops at the shim (`ZHTW_EXEC_PROBE`)

An earlier revision of this file claimed the probe "does not even load the app's
main script". That was wrong. `--version` has no special meaning for a packaged
app: Electron runs the main script, so the shim loads and — before this change —
went on to `require` Claude's original main, initialising the app far enough to
reach Electron `safeStorage` and the login-keychain item
`svce="Claude Safe Storage" / acct="Claude Key"`. Verbatim evidence, from the
14:12:18 install (`install-run.log` ends `=== 14:12:18 結束 exit=0 ===`, and that
run launched nothing):

    boot.log   06:12:18.443 === boot shim 載入 ===          <- UTC; local 14:12:18
               06:12:18.444 scheme 已註冊（合併版）
               06:12:18.444 ZHTW-BOOT locale=zh-TW armed=1 cached=1 fail=1
               06:12:18.444 handlers 已註冊

So `install` now sets `ZHTW_EXEC_PROBE=<absolute path>` on the probe subprocess
only. The shim tests that variable at the top of the file — before
`require('electron')`, before registering the `zhtw` scheme, before any
`webRequest` listener, before any cache or `health.json` write, and before the
closing `require` of the original main — writes `ZHTW-PROBE-OK …` to that path
and calls `process.exit(0)`. Without the variable nothing changes: a normal
launch takes exactly the same path it always did.

The receipt is a file, not stdout, because Node's `process.stdout` is
asynchronous for pipes on macOS and `process.exit()` can drop unflushed bytes.

`probe_or_die()` now requires all three of: not killed by a signal, `exit 0`, and
a receipt starting with `ZHTW-PROBE-OK`. The old code compared the return code
against `137`, which `subprocess` never produces — a signalled child returns
`-signum`, so an AMFI `SIGKILL` arrives as `-9` and the old check missed it
entirely. Fixture runs of the real `probe_or_die`:

    [fx-amfi]      exec_probe -> returncode=-9 receipt=''   -> abort (AMFI)
    [fx-noreceipt] exec_probe -> returncode=0  receipt=''   -> abort (shim never ran)
    [fx-nonzero]   exec_probe -> returncode=3  receipt=''   -> abort
    [fx-ok]        exec_probe -> returncode=0  receipt='ZHTW-PROBE-OK …' -> pass

How much this saves is not fully measured. The probe raising the dialog is a
race against Electron's own `--version` exit, and it does not fire every time:
for the 14:12:18 probe above the unified log has no `com.apple.Authorization`
event in that minute at all, while user launches at 13:10:31 / 14:26:48 /
15:29:50 each produced `SecurityAgent … SC confirmation dialog detected` within
a second of their `ZHTW-BOOT` line. The dialog at the user's own first launch is
unavoidable without an Apple-anchored certificate (see below) and is unchanged;
what this removes is the *possibility* of a second one during install.

### The layers that remain

1. **No redirect without a validated body** (above).
2. **Exec probe** before the swap: exit 0 plus a `ZHTW-PROBE-OK` receipt
   from the shim, and never a signalled death. Loads the shim only; the
   original main is never required, so the probe cannot touch the keychain.
3. **Runtime self-heal.** If the UI webContents reaches https and no healthy
   heartbeat arrives within `HEAL_WINDOW_MS` (90 s), the shim disarms all
   rewriting in the process and reloads that webContents exactly once
   (`HEAL_MAX_RELOADS = 1`). The reload serves original bytes, so the app comes
   back in English and working. Logs `ZHTW-RELOADED`.
4. **Runtime self-disarm.** Two consecutive launches that *actually started
   rendering and then failed* disable all rewriting from the next launch on,
   durably, until `patch-claude rearm` (or the next `install`) clears it.

   The counter deliberately does **not** key on "armed, then wall-clock silence".
   Startup can be held before the page ever begins loading — the Keychain
   authorisation dialog does exactly that — and a slow answer then looks
   identical to a broken rewrite. Measured on this machine, that miscount fired
   and disarmed a perfectly working install (`ZHTW-BOOT` lines at 06:26:48 /
   06:28:39 / 07:29:50 / 07:30:09 UTC, each with a `SecurityAgent`
   "SC confirmation dialog detected" in the system log at the same second).

   So a failure is counted at the only two points that carry evidence the page
   started and then failed:
   * `doHeal()` — the UI webContents reported itself on https, took one of our
     rewrites, and a fresh re-measure is still unhealthy;
   * `ZHTW-SCRIPTFAIL` — the renderer names one of *our* rewritten resources as
     having failed to load.

   Both are gated on `rewroteSomething`: if this launch never served a rewritten
   body, nothing that happens to the page can be our fault. Clearing the counter
   is the exact dual — a launch that rewrote something *and* came back healthy
   resets it. A launch that never started loading leaves no trace either way.
   Logged as `ZHTW-FAILCOUNT`; `patch-claude status` shows the current count and
   any durable disarm.

Under `--verify` the old net is restored: pass condition is a `ZHTW-HEALTHY`
line written from inside the page reporting `innerText` length, *visible*
element count, `readyState` and URL. No heartbeat within the window, or any
`ZHTW-SCRIPTFAIL` / `ZHTW-BOOTFAIL` / `ZHTW-RELOADED`, restores the backup and
exits non-zero. Visible-element count is load-bearing: a page whose module graph
failed entirely still reports a non-zero `innerText.length` from the static
shell.

`ZHTW-BOOTFAIL` is a hard failure rather than a warning: with `zh-TW` selected
and `gated_messages.locale` unaligned, ~4000 `secret:*` strings collapse to a
blank space and sidebar items get filtered out — worse than not patching.

## After a Claude update: detect, notify, and wait to be told

`agent-install` writes `~/Library/LaunchAgents/com.nanshan.claude-zhtw.watch.plist`:

    WatchPaths       /Applications, /Applications/Claude.app/Contents/Info.plist
    ThrottleInterval 120        RunAtLoad  true

**There is no `StartInterval` and no `KeepAlive`.** In the steady state — patch
applied, versions matching — nothing is resident and nothing wakes up. Every
trigger is an event: a `/Applications` directory change, an `Info.plist` change,
or login. `ThrottleInterval` only coalesces the burst of kqueue events a bundle
replacement produces; it is not a timer.

`/Applications` is the load-bearing watch. Squirrel's installer and a manual DMG
drag both replace the bundle by renaming it aside and moving the new one in,
which mutates the `/Applications` directory vnode. That directory is never
itself deleted, so its kqueue registration cannot go stale.

`/usr/bin/python3` is used rather than `sys.executable`, which resolves to a
physical CommandLineTools path that Apple replaces wholesale on CLT updates.

### What the agent does, and what it must never do

The job is `patch-claude watch`. It reads `Info.plist`, stats the two files the
patch adds, and — if and only if our injection is gone — posts one Notification
Center banner and writes `adaptation-pending.json`. It never runs `install` and
never invokes `codesign`. It cannot re-sign the bundle, so it cannot make the
machine ask for a password.

That restraint is the point. A re-signature is not a background-safe operation:
macOS binds the `Claude Safe Storage` grant to the build's cdhash through two
independent gates (below), both of which an ad-hoc signature can only key on
cdhash, so every re-sign guarantees at least one password dialog. Doing that on
a `WatchPaths` event means asking for a password at a moment the user neither
chose nor could predict. The user accepts one prompt per update — but only when
the update is theirs.

An earlier revision had this agent run `install` directly, with a temporary
second agent (`…reapply.await-quit`) blocking on `kqueue NOTE_EXIT` so the
re-apply could be deferred until Claude quit. Both are removed. The waiter's only
purpose was to postpone a background re-apply; with no background re-apply there
is nothing to postpone, and a component that only self-removes and is never armed
would just look like help. `agent-install` and `agent-uninstall` boot out and
delete both legacy labels, and the `reapply` / `await-quit` subcommand names now
map to the read-only `watch` — so a stale plist that is still loaded stops
re-signing the moment this file lands, without waiting for the user to re-run
anything.

### The notification, and why it is the least intrusive option available

After a desktop-app update nothing of ours runs inside Claude, so the message
cannot come from the app. The only surviving observer is the LaunchAgent, and
the only thing it may do is tell the user.

`osascript -e 'display notification …'` was chosen over `display dialog` /
`display alert` because a banner is passive: it disappears on its own, it steals
no focus, it blocks nothing, and it can be switched off in System Settings →
Notifications (the source shows up as Script Editor) or removed outright with
`agent-uninstall`. It is posted **at most once per Claude build** — the pending
marker records that it went out, so the burst of `WatchPaths` events a bundle
replacement produces, plus `RunAtLoad` at every login, still yields one banner.
Ignoring it forever is a supported outcome: Claude keeps working in English.

Attributing the banner to our own name would require shipping a signed `.app`
just to be the notification source; an unsigned app bundle in the user's home
directory buys a Gatekeeper prompt, which is worse than the attribution it fixes.

The banner is not the system of record. `adaptation-pending.json` is, and
`patch-claude status` reports it (`適配更新 : 待確認 — …`), as does the desktop
installer script, which uses it to pick a third branch distinct from "first
install" and "already applied".

### Confirmation is a keypress, never a timeout

`patch-claude adapt` prints what will happen — Claude is quit, the bundle is
replaced, it is re-signed, macOS will ask for the Keychain password once, Claude
is relaunched — and then waits. There is no default-yes and no timer: a timeout
that proceeds is not a confirmation. If stdin is not a terminal the command
refuses outright and exits 2, unless `--yes` is on the command line, which is
itself an explicit user action. Declining is free: `/Applications` is untouched,
`codesign` is never invoked, and the marker stays for later.

Quitting is polite: `osascript … to quit`, then a `kqueue EVFILT_PROC /
NOTE_EXIT` wait on the main process — a kernel-event wait at 0 % CPU, not a
poll. It never force-kills; if Claude does not quit, `adapt` aborts and the
bundle is left alone. `install` re-checks for a running Claude immediately
before the swap, since staging and codesign take minutes and the opening check
goes stale — that re-check has fired for real.

### The self-trigger loop is gone with the writes

`reapply` used to rewrite 12 `Info.plist` files to sync the asar integrity hash,
so a naive `WatchPaths` agent re-triggered itself forever — an unguarded control
run re-entered 7 times in 65 s. `watch` writes nothing inside the bundle, so
that source no longer exists. `reapply_reason()` is kept anyway: it is the
judgement itself, and it is cheap — stat two files, compare version and build
against `state.json`, return early without opening the 35 MB asar. It also
returns `None` when `state.json` is absent, so a machine that never installed
(or that ran `uninstall`) is never told something was taken away from it.

`rollback()` still records the failing version in `reapply-failed.json`, but that
record no longer gates anything: with no automatic retry there is no loop to
break, and blocking a command the user typed would be wrong. `status` and
`adapt` surface it as a warning. A `flock` bounds concurrent `adapt` runs.

## Keeping Squirrel alive

Claude ships Squirrel.Mac. Its verification path is visible in the shipped
binaries — `nm -u` on both `Squirrel` and `Resources/ShipIt` lists exactly six
Security imports:

    _SecCodeCopySelf                        # the running app
    _SecCodeCopyDesignatedRequirement       # ...its DR
    _SecRequirementCopyData                 # serialise for the ShipIt handoff
    _SecRequirementCreateWithData           # ...and rebuild it there
    _SecStaticCodeCreateWithPath            # the downloaded update
    _SecStaticCodeCheckValidityWithErrors   # update vs. that DR, flags 0x19

`0x19` is a literal at the call site (`mov w1, #0x19`) —
`kSecCSCheckAllArchitectures | kSecCSCheckNestedCode | kSecCSStrictValidate`.

The asymmetry that matters: Squirrel checks whether the **update** satisfies the
DR it read from **us**. Nothing in that list checks whether *we* satisfy our own
DR — there is no `SecCodeCheckValidity` on self anywhere in either binary.

After an ad-hoc re-signature `codesign` synthesises the DR as
`cdhash H"..." or cdhash H"..."`. An Anthropic-signed update has different
cdhashes, so verification returned `-67050` (`errSecCSReqFailed`) and ShipIt
logged `SQRLCodeSignatureErrorDomain Code=-1`, then `Too many attempts to
install, aborting update`. No update could ever install.

So `resign()` passes `codesign -r` on the **outer bundle only**, declaring a
requirement with two branches:

    designated => (<Anthropic's own requirement, read from disk>)
                  or (identifier "com.anthropic.claudefordesktop"
                      and !(anchor apple generic))

The left branch is for Squirrel: an official update is Anthropic-signed, so it
satisfies it and installs. The right branch is for the login Keychain, and it is
not optional — see *Costs*. macOS records this same DR when the user clicks
"Always Allow", then re-evaluates the **running process** against it on every
later launch. With only the left branch our ad-hoc signature could never match
its own DR, so the grant could never stick. The right branch makes the bundle
satisfy the requirement it advertises.

Both branches take their identifier from the same source — the left branch's own
`identifier "…"` clause — so they cannot drift apart. The left branch is read at
install time from whichever Anthropic-signed bundle is on disk
(`/Applications/Claude.app` itself when it is still stock, otherwise the newest
`Claude.backup-before-zhTW-*.app`) and is never hardcoded, so it tracks
Anthropic's certificate and OU. If no officially signed bundle can be found, or
if no identifier can be derived for the right branch, `install` says so and signs
as before: an unbound right branch would be satisfied by *anything* not anchored
to Apple, which is no check at all, so the feature is dropped rather than
silently weakened further.

`is_official_dr()` rejects any requirement containing `!`. That is load-bearing:
the composed DR is otherwise indistinguishable from an official one, so without
it a reinstall would treat our own previous output as the "official" source and
nest another `(… or …)` layer on every run.

**Outer bundle only is forced, not cautious.** When `codesign` seals a bundle it
copies each nested item's *current* DR into the outer
`_CodeSignature/CodeResources`, and `kSecCSCheckNestedCode` later validates the
nested items against that copy. Giving a nested item the Anthropic DR makes it
fail its own recorded requirement:

    $ codesign --force --sign - -r anthropic.req .../Squirrel.framework
    $ codesign --force --sign - -r anthropic.req .../Claude.app
    $ codesign --verify --deep --strict .../Claude.app
    .../Claude.app: nested code is modified or invalid          # exit 1

With the DR on the outer bundle alone, all 13 nested items keep their own
cdhash requirements and `--verify --deep --strict` exits 0.

Verified against the real bundles rather than argued: building the requirement
the way `SQRLCodeSignature` does, round-tripping it through the ShipIt
serialisation, and running the update check at flags `0x19` returns `0` for the
genuine Anthropic bundle from the re-signed app, where the old cdhash DR
returned `-67050`.

What is **not** verified is a real end-to-end update: that needs a Claude
release newer than the installed one, which cannot be manufactured. The
mechanism is proven, the round trip is not.

A successful update replaces the bundle with Anthropic's stock build and the
patch is gone — the intended outcome. The `com.nanshan.claude-zhtw.watch`
LaunchAgent already treats a Squirrel install and a manual DMG identically (both
mutate the `/Applications` directory vnode), posts one banner, and still never
re-signs anything without `patch-claude adapt` and a keypress.

## Costs

- **The in-app updater works, and the price is a weaker update check.** The DR's
  right branch — `identifier "com.anthropic.claudefordesktop" and !(anchor apple
  generic)` — is satisfied by *any* code carrying that bundle identifier that is
  not anchored to Apple. So Squirrel no longer proves an update came from
  Anthropic; someone who can write into the ShipIt cache could stage an unsigned
  bundle with that identifier and it would pass the code-signature check.

  This was accepted knowingly. It needs local write access to the user's account,
  and anyone with that has cheaper attacks available; whereas the alternative —
  declaring only Anthropic's branch — makes the per-launch Keychain prompt
  permanently unfixable, which is the worst day-to-day problem this project has.
  The DR is where that trade is written down; changing the balance means changing
  `compose_dr()` and nothing else.
- **WebAuthn / hardware-key login, Microsoft SSO, and the Cowork VM sandbox
  stop working.** `keychain-access-groups` and
  `com.apple.security.virtualization` are bound to Anthropic's Apple team
  identity; keeping them under an ad-hoc signature gets the process SIGKILLed
  by AMFI at exec, so they must be stripped.
- **A Keychain prompt appears after every install, not once ever.** It asks for
  `Claude Safe Storage`, Claude's own Electron `safeStorage` key. Clicking
  "Always Allow" *does* persist — but only for the exact build that asked.
  It belongs to the user's own first launch: since `ZHTW_EXEC_PROBE` (above) the
  install run itself never initialises the app, so it can no longer add a second
  prompt of its own.

  macOS binds a keychain grant to the requesting code through two independent
  checks, and under an ad-hoc signature both of them are pinned to the build's
  cdhash:

  * the **trusted-application ACL** stores the app's designated requirement.
    `SecTrustedApplicationCopyRequirement` on the bundle shows exactly what the
    entry would carry. An ad-hoc app's DR is nothing but `cdhash H"..."`.
    (Anthropic's own signature stores `identifier "com.anthropic.claudefordesktop"
    and anchor apple generic and ... certificate leaf[subject.OU] = Q6L2SF6YDW`,
    which is why *their* updates never re-prompt.)

    **This gate is why the DR has a right branch.** Declaring only Anthropic's
    requirement would revive Squirrel and, in the same stroke, make this gate
    permanently unsatisfiable — the entry would carry a certificate condition an
    ad-hoc build cannot meet:

        DR = anchor apple generic … OU = Q6L2SF6YDW   -> our code:  -67050
        DR = (that) or (identifier … and !anchor)     -> our code:       0

    With the disjunction the recorded requirement is satisfiable by our own
    build, so gate 1 behaves exactly as it did before this change — no better,
    no worse. Gate 2 is untouched either way: `partitionIdForProcess` reads the
    *signature*, not the DR, and the signature is still ad-hoc with no team id,
    so the partition stays `cdhash:`.

    Note this does not by itself end the prompt. Gate 1 was already refusing on
    this machine for reasons still unexplained in `PENDING-AUTOUPDATE.md` (a
    prompt with `kcacl` and no `integrity`). What the right branch buys is that
    the investigation there remains possible; the Anthropic-only DR would have
    closed it permanently.
  * the **partition list** (`ACLAuthorizationPartitionID`) stores a partition id
    computed by securityd from the client's signature. `partitionIdForProcess`
    in `securityd/src/clientid.cpp` only emits `teamid:` for Apple-anchored
    chains (Mac App Store / TestFlight / Developer ID / Mac Development / Mac
    Distribution); everything else that is merely signed falls through to
    `cdhash:<hash>`.

  Re-signing changes the cdhash, so both entries stop matching and macOS asks
  again. On this machine the live `Claude Safe Storage` ACL had accumulated 17
  cdhash-pinned trusted-application entries and a matching pile of `cdhash:`
  partitions — one per install attempt — alongside the single stable
  `teamid:Q6L2SF6YDW` from the original.

  This is why nothing re-signs unattended. The prompt is not a bug to be
  engineered away — it is the fixed price of an ad-hoc signature — so the only
  thing left to control is *when* it is charged, and the answer is: only in
  response to something the user just did.

  **A locally generated self-signed certificate does not fix this.** It would
  make the trusted-application requirement certificate-based and stable, but the
  partition id would still be `cdhash:` — `getTeamIDFromSigner`
  (`OSX/libsecurity_codesigning/lib/CodeSigner.cpp`) refuses to take a team id
  from a non-Apple certificate, and every `teamid:` branch in
  `partitionIdForProcess` is gated on `anchor apple`. So the prompt would still
  return after each install, while `codesign` would additionally refuse to use
  the identity until it is trusted — and per `man security`, changing per-user
  trust settings "require[s]" "an authentication dialog". Strictly worse.

  The only mechanism macOS offers that actually ends the re-prompt is an
  **Apple-issued Developer ID certificate**: that yields `teamid:<TEAM>`, one
  grant covering every future build, exactly as Anthropic's does. Nothing that
  can be generated locally reaches that branch.

Every install backs up to `/Applications/Claude.backup-before-zhTW-<ts>.app`.

## Translation

29,154 strings, translated from the English source rather than converted from
Simplified. `glossary.tsv` holds 413 normative Taiwan terms. The translation
memory is keyed by **English source string**, not by Claude's internal message
ids, so it survives Claude's internal refactors: after an update, existing
strings carry over and only genuinely new English appears untranslated.

That property is measured, not assumed. Three consecutive Claude releases —
1.40609.1, 1.44121.4, 1.46388.2 — brought 1,642, 740 and 1,205 strings the
memory had never seen. Every other string in each catalogue still matched, so
`sync` reported 24,023/25,634, then 25,119/25,775, then 25,356/26,530 for
`main` rather than starting over. Coverage of the installed catalogues (main,
dynamic, shell) is currently 100%.

    bin/patch-claude sync              # -> pending.json  {category: {en: en}}
    # translate the values, save as {en: zh}
    bin/patch-claude merge mine.json
    bin/patch-claude install
