STATUS: complete
# Regression review of the uncommitted audit changes

## src/lib/wsl.ts — `cd … || exit 1` (item 1)

Callers checked: `foamExec` has exactly four call sites (wsl.ts:661 `echo "$FOAM_RUN"`,
wsl.ts:1223 `<cmd> -help`, wsl.ts:2878 `checkMesh` — only the last passes a `workDir`).
The command runner `executeCommandAsync` has three call sites
(src/app/api/commands/route.ts:52 and :75, src/lib/agent-policy.ts:287); all three
validate the case name first and address an existing case, and case CREATION does not
go through it (`createCase`, wsl.ts:1329, uses `mkdir -p`). No caller legitimately
depends on the command still running after a failed `cd`.

No regression found in this change. Two smaller notes on the same hunks:

LOW — src/lib/wsl.ts:1771 — background worker still swallows its own `cd` error
scenario: a background command (`./Allrun … &`) is launched for a case whose directory
disappears between the outer shell's `cd` and the detached worker's own `cd`.
why the change causes it: the OUTER shell was changed to `cd … || exit 1` (no
`2>/dev/null`), but the worker script generated at wsl.ts:1771 still reads
`cd <casePath> 2>/dev/null || exit 1`. The worker's stdout/stderr go to `/dev/null`,
so the run dies silently and the launcher still prints `BG_PID=<pid>`; the UI reports
the command as started.
suggested correction: none needed for correctness of the outer fix; if the worker's
`cd` is worth reporting, drop its `2>/dev/null` and have the launcher check that the
pid is still alive before printing BG_PID.

LOW — src/lib/wsl.ts:2878 — `checkMesh` failures still lose their message
scenario: `runCheckMesh` on a case with a broken mesh.
why: `foamExec('checkMesh 2>&1', casePath, 60000)` merges stderr into stdout, so on a
non-zero exit `runInWsl`'s catch (wsl.ts:114) reports `e.stderr || e.message` — stderr
is empty, so the user gets the generic execFileSync message and not checkMesh's output.
Pre-existing, but the `cd … || exit 1` change now routes the *new* "No such directory"
message through the same lossy path (that one does land on stderr, so it survives).
suggested correction: in `runInWsl`'s catch use `e.stdout` when `e.stderr` is empty.

## src/lib/wsl.ts — `getCaseLog` and `getProcesses` (item 2)

Shell of the new command is correct: `[ -f … ]` follows symlinks, `tail -n N -- p |
tail -c 41943040` yields the last N lines bounded to 40 MiB, the `if` exits 0 on the
success branch, and both paths are single-quoted by `shellQuote`. `decompressPar` →
`decomposePar` (wsl.ts:1916) is right and makes the process list agree with the two
kill functions (wsl.ts:1947, wsl.ts:1977), which already grepped `decomposePar`; no
OpenFOAM utility is named `decompressPar`, so nothing stops being listed.

Callers: `?action=logs` (route.ts:59) is capped at 5000 by the UI dropdown
(monitor.tsx:1029 — max option is 5000), so it always used `tail` and is unchanged.
The ONLY caller that reached the old `cat` branch is the residual chart
(monitor.tsx:283, `maxLines=50000`). That one did need the whole file:

MEDIUM — src/lib/wsl.ts:2019-2028 — residual chart silently loses the start of a long run
scenario: user runs simpleFoam for a few hours; `log.simpleFoam` passes 50 000 lines
(OpenFOAM prints roughly 10-20 lines per time step, so ~3000 time steps). Open Monitor
→ Show Chart. The chart now begins at whatever time is 50 000 lines from the end, so
the initial residual drop — the part of the curve a user actually reads to judge
convergence — is gone, and because the window is anchored to the END of the file the
x-axis start creeps forward on every refresh, making the chart appear to "lose" data
while the solver runs.
why the change causes it: `safeTail >= 50000` used to select `cat` (whole file);
it now always selects `tail -n 50000`. The comment at wsl.ts:2019 ("tail -n N returns
exactly the same bytes as cat … so nothing is lost") holds only for logs of at most N
lines, which is not the case this branch existed for.
suggested correction: keep the bound but do not throw away the beginning — e.g. read
`head -n 20000` plus `tail -n 30000` for the chart, or downsample server-side
(`awk 'NR%k==0'`) so the whole time range is still represented.

LOW — src/lib/wsl.ts:2031 — an unreadable log now comes back as an empty pane
scenario: `log.simpleFoam` exists but is not readable (root-owned after a `sudo`
run, or a stale NFS/9p handle). `[ -f ]` succeeds, `tail` fails, its stderr is
discarded by `2>/dev/null`, and the function returns "".
why the change causes it: the old form was `cat … 2>/dev/null || echo "Log not
found: …"`, so any failure to read produced the message; the new `if/else` only
produces it when the file does not exist.
suggested correction: `else`-branch on the tail's own status too, e.g.
`… | tail -c N || echo <msg>` is not enough (pipeline status), so use
`if [ -r … ]` instead of `[ -f … ]`.

Note (not a regression): a first line cut mid-line by `tail -c` cannot mis-parse —
`parseAllResiduals` (monitor.tsx:109) anchors on `/^Time\s*=/` and skips everything
until `currentTime >= 0`, so a partial first line is simply ignored.

## src/lib/wsl.ts — `writeFile` temp-file + rename (item 3)

Shell semantics check out: `execFileSync` passes the command as one argv element with
no Windows shell in between, so `$$` reaches bash unexpanded and is the pid of the
`bash -c` shell; `T='<quoted>'.tmp.$$` is an assignment, so the quoted/unquoted
concatenation is not word-split even for a path with spaces; bash restores `$?` across
an EXIT trap that does not itself `exit`, so the exit status still comes from
`base64 -d` / `mv`; and on success the trap's `rm -f` is a harmless no-op because `$T`
has already been renamed away. Three real problems:

MEDIUM — src/lib/wsl.ts:1583-1588 — saving a file destroys its permission bits
scenario: a tutorial case whose `Allrun` calls `./Allmesh` (the standard OpenFOAM
pattern). The user opens `Allmesh` in the File Editor, changes a line, saves. The next
`Allrun` fails with `./Allmesh: Permission denied` and the run stops at meshing.
why the change causes it: `base64 -d > file` wrote THROUGH the existing inode and kept
its mode (0755). The new form creates a fresh temp file — mode 0666 & ~umask, i.e.
0644 — and renames it over the target, so the executable bit is gone. The same applies
to a symlink target (tutorial cases symlink shared scripts): `mv` replaces the symlink
with a regular file instead of writing through it.
Note the top-level Allrun/Allclean buttons are NOT affected: `normalizeCommand`
(wsl.ts:1688) rewrites `./Allrun` to `bash ./Allrun`. It is the nested `./Script`
calls inside those scripts, run by bash in WSL, that need the bit.
suggested correction: copy the mode across before the rename, e.g.
`cp -p --attributes-only <target> "$T" 2>/dev/null || true` (or `chmod --reference`)
between the decode and the `mv`, guarded for the file-does-not-exist case.

MEDIUM — src/lib/wsl.ts:1588 — writing to a path that is a DIRECTORY now reports success
scenario: the agent calls `write_case_file { case: "cavity", path: "system", … }` (or
`path: "0"`) — a plausible model mistake, and nothing in `validateRelativePath` rejects
it. Old behaviour: `base64 -d > <case>/system` failed with "Is a directory" and the
caller got `Unable to write system: …`. New behaviour: `mv -f -- <case>/system.tmp.4711
<case>/system` moves the temp file INTO the directory, exits 0, and the tool answers
`written: cavity/system (812 bytes)`. The content is silently parked at
`<case>/system/system.tmp.4711`, the trap cannot remove it (the name it knows is gone),
and it is left behind for good.
why the change causes it: `mv f d` where `d` is an existing directory means "move f
into d"; the redirect it replaced had no such fallback.
suggested correction: `mv -f -- "$T" <target>` → guard with `[ ! -d <target> ]` first,
or use `mv -fT -- "$T" <target>` (GNU `--no-target-directory`), which fails instead.

LOW — src/lib/wsl.ts:1585 — an interrupted write leaves a stray sibling that other
code reads as a case file
scenario: `wsl --shutdown`, a power loss, or the packaged app being closed while a
save is in flight leaves `0/U.tmp.4711` behind (the EXIT trap cannot run in those
cases). `validateBoundaryConditions` (wsl.ts:2500) enumerates EVERY regular file in
`0/` with `find -maxdepth 1 -type f`, so the BC panel then reports
`U.tmp.4711: no boundaryField found` — or, if the temp file is complete, silently
double-checks a phantom field. `listDirectory` (wsl.ts:1513, `for item in "$DIRPATH"/*`)
shows it in the File Editor tree, and it is visible there for the whole duration of a
normal save too (up to the 30 s timeout on a slow 9p write).
why the change causes it: there was no sibling file before; the new `/tmp` sweeper
added in this same diff (wsl.ts:1804) only covers `wslgui_*` under `/tmp`, not these.
suggested correction: name the temp file with a leading dot (`.<base>.tmp.$$`) so it is
excluded by the `*` glob and by `find`-based field enumeration, and skip
`*.tmp.[0-9]*` in the `0/` enumeration.

## AMENDMENT to item 3 — `writeFile` was edited while this review ran

The working tree changed under me: `writeFile` (wsl.ts:1562-1606) no longer uses
`T=…; trap … EXIT; $$`. It now generates the scratch name in JavaScript
(`${fullPath}.tmp.${randomBytes(6).toString('hex')}`) and runs
`base64 -d > <tmp> && mv -f -- <tmp> <dst> || { rm -f -- <tmp>; exit 1; }`.
That grouping is correct (`rm` + non-zero exit on either a failed decode or a failed
rename), `randomBytes` is imported (wsl.ts:5), and `npm run typecheck` passes.

Which of my three findings survive that rewrite:
 - "saving a file destroys its permission bits" — STILL APPLIES unchanged (a fresh
   temp file at umask + `mv` still discards mode 0755 and still replaces a symlink).
 - "writing to a path that is a DIRECTORY now reports success" — STILL APPLIES
   unchanged; `mv -f -- <tmp> <dst>` with `<dst>` an existing directory still moves
   the file into it and exits 0.
 - "an interrupted write leaves a stray sibling" — STILL APPLIES, and the failure
   surface is slightly wider: with the EXIT trap gone, only an orderly non-zero exit
   cleans up, so a killed `wsl.exe`, a `wsl --shutdown` or a power loss now leaves
   `0/U.tmp.<hex>` behind with nothing to remove it. The dot-prefix suggestion still
   stands, since `listDirectory` and the `0/` field scan both pick the name up.
The `$$` / trap paragraph at the head of that section is obsolete.

## src/lib/wsl.ts — negative caches (item 4)

`clearNegativeCaches()` (wsl.ts:351) has exactly ONE caller: `resetCache()`
(wsl.ts:2969). `resetCache()` in turn is reachable from only two places —
`setDistro()` (wsl.ts:~600, and only when the distro actually changes) and
POST `/api/wsl {action:'fullStatus'}`. No client sends that POST: the Dashboard's
refresh is GET `?action=fullStatus` (dashboard.tsx:99), the header dot is GET
`?action=ping` (page.tsx:129). So in practice the negative caches are cleared only
by switching distro. The answer to "is it called everywhere a user-initiated retry
happens" is no.

HIGH — src/lib/wsl.ts:363 + 517-529 — one call inside the 5 s window poisons a
POSITIVE cache permanently
scenario: cold boot. The page's first request runs `findBashrc()` while WSL is still
starting; it fails and sets `bashrcFailedAt`. WSL finishes starting ~1 s later. The
same page load's remaining burst (fullStatus → `getQuickStatus` → `getOpenFOAMVersion`
→ `getFoamEnv`) arrives inside the 5 s window: `foamSource()` returns '' from the
negative cache WITHOUT probing, but `runInWsl('env -0')` now SUCCEEDS because WSL is
up. The OpenFOAM-less environment is stored in `cachedFoamEnv` (wsl.ts:528) — a
positive cache with no expiry — and written to `~/.wslgui-cache.json` by
`persistCache()`. `getOpenFOAMVersion()` then stores `cachedVersion = 'Unknown'`
(wsl.ts:~618), which is sticky because of its `if (cachedVersion) return cachedVersion`
guard.
Result: version reads "Unknown", the env panel is empty, and
`getFoamApplications()` / `getFoamSrc()` (wsl.ts:~789, ~796) return '' so the
applications/src browser is empty — for the rest of the server process. It also
survives a restart: `loadDiskCache` accepts any stored env with more than 5 keys
(wsl.ts:~261) and the validator only discards `foamEnv` when it HAS a `FOAM_RUN`
(wsl.ts:~285), which this one does not.
why the change causes it: before, a failed `findBashrc()` was cached as '' and every
later caller short-circuited the same way, so the two caches at least agreed. The 5 s
window makes `findBashrc()` answer "no OpenFOAM" without probing while the very next
WSL call in the same burst succeeds, and nothing invalidates `cachedFoamEnv` /
`cachedVersion` when the window later expires.
suggested correction: have `getFoamEnv()` refuse to cache a result obtained while
`foamSource()` was empty (or when the returned env has no `WM_PROJECT_DIR`), and give
`cachedVersion` the same treatment — do not cache the literal 'Unknown'.

MEDIUM — src/lib/wsl.ts:~480-500 — `setOpenFOAMVersion` clears the positive caches but
not the negative ones, so the version the user just picked is ignored
scenario: WSL was slow a moment ago (`bashrcFailedAt` set). The user opens Settings and
picks an OpenFOAM version. `setOpenFOAMVersion` sets `selectedBashrc` and nulls
`cachedBashrc`/`cachedFoamEnv`/`cachedVersion`/`cachedRunDir`/`cachedTutDir` by hand —
it does NOT call `resetCache()`, so `bashrcFailedAt` is untouched. The route
(`api/wsl/route.ts:62-68`) immediately calls `getOpenFOAMVersion()` and
`getRunDirectory()`; `findBashrc()` returns '' from the still-warm negative cache
without ever testing the bashrc that was just selected, so the response is
`{success:true, version:'Unknown', runDir:''}` and — per the finding above —
`cachedFoamEnv`/`cachedVersion` are poisoned for the session.
why the change causes it: the negative cache is new; the hand-written cache reset in
`setOpenFOAMVersion` predates it and was never extended.
suggested correction: call `clearNegativeCaches()` at the top of
`setOpenFOAMVersion()`, and also on GET `?action=fullStatus` (the Dashboard's actual
refresh) rather than only on the POST nothing sends.

LOW — src/lib/wsl.ts:57 + 307 — a probe failure can persist the WRONG distro name
scenario: the real distro is `Ubuntu-24.04`; `wsl --list` times out once, so
`distroFailedAt` is set and `getDistro()` returns the literal guess `Ubuntu-22.04`.
Any `persistCache()` in the next 5 s writes `distro: 'Ubuntu-22.04'` to
`~/.wslgui-cache.json` alongside paths that were resolved against the real distro.
why the change causes it: `persistCache()` calls `getDistro()`, which now has a branch
that returns a guess it has not verified.
suggested correction: skip `persistCache()` (or omit the `distro` key) while
`distroFailedAt` is set. Self-healing on the next launch, so low.

## src/lib/agent-policy.ts — new argument checks (item 5)

The loop at agent-policy.ts:163-177 rejects three token shapes in EVERY argument.
Legitimate commands it now refuses, beyond `mapFields ../otherCase`:

HIGH — src/lib/agent-policy.ts:174 — the whole two-case family of utilities becomes
unreachable, not just mapFields
scenario: the agent is asked to start a fine-mesh run from a coarse solution, or to
clone a case. Every utility that takes ANOTHER case as an argument is now refused,
because sibling cases under `$FOAM_RUN` can only be named with `..` and absolute paths
are refused by the neighbouring rule, so no spelling of the argument survives:
  - `mapFields ../coarse -consistent -sourceTime latestTime`
  - `mapFieldsPar ../coarse -sourceTime latestTime`   (openfoam-data.ts:144)
  - `foamCloneCase ../pitzDaily myCase`               (openfoam-data.ts:162)
These are not escapes: the source case is inside `$FOAM_RUN`, the same directory the
agent may already read and write through `list_cases` / `read_case_file`.
why the change causes it: the rule tests the SHAPE of the token, not where it resolves
to, so "a sibling case" and "the Windows disk" are indistinguishable to it.
suggested correction: resolve the token against the case directory
(`path.posix.normalize(casePath + '/' + token)`) and accept it when the result is still
inside `getRunDirectory()` — the same test `validateRelativePath` already performs for
file arguments — instead of banning the spelling.

MEDIUM — src/lib/agent-policy.ts:164 — `-case` is refused even when it names the case
the call already targets, and the app's own documentation tells the agent to use it
scenario: the agent runs `foam_help blockMesh`, whose output is `blockMesh -help` from
the index; OpenFOAM's argList prints `-case <dir>` in the usage of EVERY utility. The
app's own command reference does the same in eight entries (openfoam-data.ts:40, 42,
43, 48, 71, 90, 107 list `-case <dir>` under commonOptions). The agent writes
`blockMesh -case .` — the harmless, extremely common form that names the current
directory — and gets back "the case is the one named in this call … Call the tool
again with a different case", which describes a mistake it did not make; there is no
different case to name, so the advice is unfollowable and the model is likely to
retry variations.
why the change causes it: the check is on the option token alone and never looks at
its value.
suggested correction: allow `-case` when its value resolves to the case directory
(`.`, `./`, or the case's own name), and refuse only the values that leave it — and
reword the message to say what an acceptable value is.

MEDIUM — src/lib/agent-policy.ts:171,174 — a dictionary shared between cases can no
longer be referenced
scenario: a parametric study laid out as `$FOAM_RUN/common/blockMeshDict` plus
`$FOAM_RUN/run01…run20`. `blockMesh -dict ../common/blockMeshDict` (and the same for
`-decomposeParDict ../common/decomposeParDict`, which is how a parallel study keeps one
decomposition) is refused. Same root cause and same fix as the first finding.

Not affected, checked: the `mpirun -np N <cmd> -parallel` prefix (the loop's tokens
`-np`, `N`, `<cmd>` trip nothing); `-dict system/foo`, `-region fluid`, `-entry
boundaryField/inlet/type`, `-func 'mag(U)'`, `-time 0:100`; redirections, which
`SHELL_METACHARACTERS` (agent-policy.ts:104) already refused before this change.

Also on this file (write_case_file / script names):

LOW — src/lib/agent-policy.ts:88-91 + 265-272 — `isCaseScriptPath` matches on basename
only, so a legitimate non-script file is refused
scenario: `write_case_file { case: "x", path: "system/Allrun" }` or any file whose
basename happens to be one of the five names but which is not at the case root — the
only thing `run_openfoam` can execute is `./Allrun` at the case root (normalizeCommand,
wsl.ts:1688), so a nested one is not a command.
suggested correction: compare the whole relative path against the five names rather
than `split('/').pop()`.

## src/middleware.ts + electron/main.js (item 6)

Middleware — no in-app breakage found, and I checked every local caller:
 - Every browser call in `src/` is a RELATIVE `/api/...` fetch (no absolute URL exists
   in the client — grep for `fetch('http` / `fetch(\`http` returns nothing), so the
   Electron renderer, loaded from `http://127.0.0.1:<port>/` (main.js:889), sends
   `Sec-Fetch-Site: same-origin` and passes. There are no `<form>`s, no `EventSource`
   and no `WebSocket` in the app.
 - The MCP bridge (electron/mcp/openfoam-mcp.mjs:178) uses Node `fetch`, which sends no
   `Sec-Fetch-*` headers at all → allowed, as intended.
 - `warmUpWsl()` (main.js:553-575) hits `/api/wsl?action=version`,
   `/api/foam-index?action=build` and `?action=corpus&build=1` with Node's `http.get`
   from the MAIN process → no header → allowed.
 - The splash is a `data:` URL but makes no requests (main.js:169-197), and
   `waitForServer` polls `/`, which the matcher does not cover.
 - The middleware IS present in the packaged build
   (electron/resources/standalone/.next/server/middleware-manifest.json carries the
   `/api/:path*` matcher), so the check is live in the packaged app too.

SUSPECT — src/middleware.ts:1 — `middleware.ts` is the deprecated file convention in
this Next.js
This project is on Next 16.3.3, where `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
says the convention is **deprecated and renamed to `proxy.js`** ("All functionality
remains the same — only the file and export names have changed"). It works today — the
built manifest proves it — but a brand-new file was written against the deprecated
name, so this will warn now and break on the next Next major.
suggested correction: `npx @next/codemod@canary middleware-to-proxy .`, or rename to
`src/proxy.ts` with `export function proxy(...)`.

electron/main.js — the new handlers cannot kill a server that should live. I traced
every path: `killServerSync` returns immediately unless `serverProcess` is still set,
and `killServer()` nulls it in its `finally`, so a normal quit reaches
`process.on('exit')` with nothing to do; a second instance never spawns a server
(`gotSingleInstanceLock` gates `startServer()` at main.js:859), so its own exit handler
cannot touch the first instance's server. One real problem and two smaller ones:

MEDIUM — electron/main.js:317-319 + 869-874 — an early server crash now shows the user
TWO dialogs, the second less informative than the first
scenario: the server dies during startup (port already bound, a corrupt standalone
bundle). The `serverProcess.on('exit')` handler (main.js:446-472) shows the good dialog
— "The backend server stopped unexpectedly (exit code 1) … It said: <last 12 lines>" —
and calls `app.quit()`. `showErrorBox` is modal and blocks the main process, so by the
time the user clicks OK the pending 60 ms poll fires, `attempt()` sees the new
`serverFailure` and rejects, and `loadApp`'s catch (main.js:869) shows a SECOND modal:
"Startup failed: The backend server stopped before it was ready (exit code 1)."
why the change causes it: before, `waitForServer` had no `serverFailure` check, so it
just kept polling and `app.quit()` tore the process down long before the 60 s timeout —
the second dialog was unreachable. The new short-circuit makes it reachable, and the
`quitting` guard does not stop it: `quitting` is only set inside `killServer()`, which
in this path runs AFTER both dialogs.
suggested correction: have `loadApp`'s catch return silently when `quitting` is already
true (or when the failure came from `serverFailure`, which the exit handler has already
reported), so exactly one dialog owns the message.

LOW — electron/main.js:449-452 — `serverFailure` is recorded even for a deliberate
shutdown
scenario: normal quit → `killServer()` → the server exits → the handler sets
`serverFailure = 'The backend server stopped before it was ready (signal SIGTERM)'`
BEFORE the `if (quitting) return` two lines below, and nothing ever clears it.
why it matters: harmless today because the server is started exactly once, but it makes
`serverFailure` permanently wrong as a state flag — anything added later that restarts
the server would have `waitForServer` reject on the first `attempt()` with a stale
message about a shutdown the user asked for.
suggested correction: move the `if (quitting) return;` above the assignment.

SUSPECT — electron/main.js:989-998 — an uncaught exception now takes the app down
silently
scenario: any uncaught throw in the main process — an EPIPE while logging, a bug in an
`ipcMain.on` callback — now runs `killServerSync()` and `process.exit(1)` with no user
message. Every other fatal path in this file shows `dialog.showErrorBox` first; here
the window simply vanishes mid-session, and in the packaged app there is no console to
read the `console.error`. Marked SUSPECT because Node's default handler also exits, so
the app may have died before too — the certain change is that the exit is now the app's
own and can therefore be made to say something.
suggested correction: `dialog.showErrorBox(APP_TITLE, …logFilePath())` before
`process.exit(1)`, guarded by `app.isReady()`.
