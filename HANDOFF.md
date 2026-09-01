# Handoff — where the work stands

Written for whoever (or whichever session) picks this up next.

Last updated: 2026-08-31, at the v1.4 release.

---

## 0. Orientation

**`README.md` is the description of the project** — what the app is, what each
tab does, the file-by-file layout table, the build commands. Read it and do not
re-derive any of it; nothing here repeats it.

The one thing it does not spell out is the runtime chain, which is what makes
the traps in §5 make sense:

> The portable `.exe` is an Electron shell. `electron/main.js` binds port 0 to
> get a free one, spawns the **bundled `node.exe`** with `windowsHide: true`
> running the Next.js **standalone server** from `resources/standalone`, waits
> for it to answer, then points a `BrowserWindow` at `http://127.0.0.1:<port>`
> (and kills the process tree with `taskkill /F /T` on quit). The UI is therefore an ordinary web page talking
> to REST endpoints under `src/app/api/**`, and every one of those endpoints
> reaches OpenFOAM by shelling out to `wsl.exe` through `src/lib/wsl.ts`. Three
> processes deep, three boundaries where things break: renderer → node server →
> WSL.

---

## 1. Working agreement with the user

These are standing instructions, not one-offs:

- **Rebuild the `.exe` after every change.** Not only when asked. Use the fast
  path in §4 — the user explicitly asked for a rebuild with no duplicated steps,
  so never wipe caches to "start clean".
- **Copy the fresh exe over `Working/OpenFOAMStudio-v1.4-portable.exe`.** That is
  the binary the user actually launches. Approved on 2026-08-31; earlier
  binaries stay attached to their GitHub releases if one is ever needed.
- **Wait for an explicit go-ahead before cutting a new version.** Version bump,
  commit, tag and release are the user's call, never automatic.
- **Nothing is committed without being asked.** Changes live in the working tree
  until the user says otherwise.
- **Never run anything destructive against the user's real cases** (`cavity`,
  `nozzleFlow2D`, `shockTube` in the WSL run dir). Test in `claude_test` (§3).
- **The user writes in Italian**; the repo, its comments and this file are in
  English. Keep both as they are.

## 2. State of the work

Shipped in **v1.4**, verified in both the dev server and the packaged app:

- `src/components/openfoam/mesh-viewer.tsx`
  - **Vertex labels are sized in screen space.** They were sprites in world
    units scaled once per fit, so zooming blew them up until they covered the
    model. Now `sizeAttenuation: false` plus `updateLabelScale()`, which inverts
    the projection (`scaleY = 2 · LABEL_PIXEL_HEIGHT / (viewportHeight · f)`,
    `f = projectionMatrix[5]`) to pin every label to 16 CSS px at any zoom and on
    any model size. Measured 16.00 px across a 200× range of camera distance.
    The pill is also smaller and crisper (canvas supersampled 4×, mipmaps).
  - Turning the labels on no longer re-fits the view — that call only existed to
    rescale the sprites, and it threw away the user's camera.
  - **`OrbitControls` → `TrackballControls`.** Orbit pins the up vector and
    clamps the polar angle, which is the rotation limit the user hit. Trackball
    carries the up vector with the camera (ParaView-style free rotation).
    `rotateSpeed 3.0` matches Orbit's old feel; `panSpeed 0.8` keeps a right-drag
    1:1 with the pointer. Verified: the polar angle sweeps 13°–169° and
    `camera.up.y` reaches −0.77, i.e. it goes over the pole.
  - Three things the swap required, all commented in place: Trackball's A/S/D
    shortcuts are bound on `window` (disabled — they would fire while typing in
    the editor); it caches the canvas rect instead of reading it per gesture (so
    it is refreshed on resize and on pointerdown, capture phase on the parent);
    and it only emits `change` past 1e-3 world units, which on a centimetre-scale
    case means a slow drag looks frozen — hence the rAF loop that runs only
    during a gesture plus a 600 ms damping tail. **Rendering is otherwise still
    on demand and an idle viewer must stay at zero CPU.**
- `electron/scripts/prepare-resources.js` — incremental mirror, see §4.

- **New Case wizard** — `src/lib/case-templates.ts` (new) + `case-wizard.tsx`.
  The wizard produced OpenFOAM ≤10 cases unconditionally (`application
  simpleFoam;`, `transportProperties`, `turbulenceProperties`) and wrote an
  EMPTY blockMeshDict, so on the installed 13/14 nothing it made could run. Now
  the layout is chosen from the detected version, the mesh is a parametric box
  that also defines the patch list every boundary condition is generated
  against, RAS models pull in their own 0/ fields with computed inlet values,
  the summary step preflights the case, and creating over an existing case asks
  first. Proven by generating a case and running `blockMesh` + `foamRun` to
  completion on **both** 13 and 14. Note the trap found there: 14 accepts named
  dimension sets (`[velocity]`), 13 does not — the generator writes the numeric
  form for every version.
- **FOAMy copilot** — `api/chat/route.ts`, `lib/wsl.ts`, `lib/llm/*`,
  `chat-popup.tsx`. The whole-file rewrite policy is right, but it was resting
  on a context that lied: files were cut at 8 KB with no marker at all, so the
  model rewrote files whose end it had never seen. Files now carry their size
  and an explicit TRUNCATED marker, the context has a budget and lists what did
  not fit, the system prompt forbids rewriting a truncated file, a reply cut off
  at the token limit is flagged and its apply buttons withheld, "Apply all" no
  longer skips the shrink guard that single applies use, and files the user
  applied are re-sent so the model stops quoting the pre-change version.
- **Startup** — `electron/main.js`. The window is created immediately with an
  inline splash instead of after the server answers; the server is spawned
  before `whenReady` so it boots in parallel with Electron; the readiness poll
  went 300 ms → 60 ms; and a throwaway request warms the WSL layer while the
  page is still loading. Every `[main]` line is timestamped — run the exe from a
  terminal to see the breakdown. Measured after the change: window on screen at
  **173 ms**, server answering at 4.0 s, page loaded at 6.2 s.

  **The elephant is not in this code.** Between the portable stub starting and
  the first Electron process there are **~28 seconds**, on every launch: the
  NSIS portable template does `RMDir /r $INSTDIR` and re-extracts all 348 MB
  from LZMA into TEMP each time — see
  `node_modules/app-builder-lib/templates/nsis/portable.nsi`. `unpackDirName`
  does not help (the delete is unconditional). Only a distribution change can
  fix it: `compression: store` (≈350 MB exe, extraction becomes a plain copy),
  or shipping a zipped `win-unpacked` / an NSIS installer (no per-launch
  extraction at all, ~1.5 s to the window). **Asked on 2026-08-31; the user
  chose to keep the single 87 MB portable exe and live with the 28 s.** Do not
  re-propose changing the distribution format unless they raise it.
- **A transient WSL failure no longer changes the selected OpenFOAM version**
  (`lib/wsl.ts`). The disk-cache validator discarded every cached path when the
  probe threw, so a cold start could silently re-detect and switch version — the
  run directory changes with it and the user's cases appear to vanish. It now
  keeps the cached paths when WSL is merely unreachable, and an explicit version
  choice is persisted so auto-detection cannot override it.
- **Rename / move in the File Editor** — `renamePath()` in `lib/wsl.ts`, a
  `rename` action on `api/cases/[name]`, and a pencil on every row of the tree
  plus a button in the editor header. The dialog edits the full relative path,
  so renaming and moving are one operation; the destination is refused if it
  already exists (`mv` would otherwise overwrite it, or move the source INSIDE
  it), and both paths go through `validateRelativePath` so neither can escape
  the case. Note for anything similar: the WSL helper script reports errors on
  stdout and exits 0 on purpose — a non-zero exit makes `runInWslScript` throw
  the raw base64 command line, and that is what the user would see instead of
  "already exists: 0/p".

All of the above shipped in **v1.4** (bumped, committed, tagged, released).

## 3. `claude_test`

A scratch case the user told me to create, at
`~/OpenFOAM/tommasoferrara-14/run/claude_test` in WSL: a copy of the
`incompressibleFluid/TJunction` tutorial with `blockMesh` already run. 3D,
6.300 triangles, 4 patches, 20 blockMeshDict vertices — it exercises the mesh
viewer far better than the 2D cases. Free to break; re-create it with a plain
`cp -r` from `/opt/openfoam14/tutorials/` if it gets wrecked.

## 4. Build, fast path

```
npm run electron:build                          # full, ~2.5 min
node scripts/build-electron.js --skip-build     # re-package only, skips next build
```

Then copy `dist-electron/OpenFOAMStudio-v1.4-portable.exe` over
`Working/OpenFOAMStudio-v1.4-portable.exe`.

Nothing in this path re-does work, and it must stay that way:

- `prepare-resources.js` **mirrors** `.next/standalone` into
  `electron/resources/standalone` — copying only files whose size or mtime
  differ, restoring the mtime after each copy (otherwise every file looks newer
  than its source and the next run copies all ~1300 again), and deleting entries
  that no longer exist on the source side. That deletion is what stops stale
  hashed chunks from `.next/static` piling up inside the exe; it used to be
  handled by wiping the whole tree, which is the duplicated work that was
  removed. A normal rebuild reports something like
  `201 copied, 1143 unchanged, 2 removed`.
- **Four caches must never be deleted**: `.next/cache` (~167 MB, what makes
  `next build` incremental), `node_modules`, `electron/resources/bin/node.exe`
  (else a 70 MB Node download), and `AppData/Local/electron-builder/Cache`
  (Electron 31.7.7 + nsis).
- Stop `npm run dev` before building — dev and `next build` share `.next`. The
  exe also cannot be overwritten while the app is running, and the shell's own
  cwd locks a folder against renaming.

Verify a build by running the packaged server directly, never by launching the
GUI on the user's desktop:

```
cd dist-electron/win-unpacked/resources
PORT=3117 HOSTNAME=127.0.0.1 ./bin/node.exe standalone/server.js
curl http://127.0.0.1:3117/api/wsl?action=ping
```

Also grep the packed bundle under `win-unpacked/resources/standalone/.next` for
a string you just added, to prove the exe really carries the new code.

## 5. Traps that have already cost time

- **The three packaged-app-only traps are documented in the README** ("Three
  traps to know about") — native modals, `windowsHide: true`, and the port that
  changes every launch. The rule they share: never validate focus-, process- or
  persistence-related work from the dev server alone. If a fourth one turns up,
  add it there, not here.
- **The in-app Browser pane lies in several ways**: its console buffer survives
  navigation, it does not run `requestAnimationFrame` while hidden (so anything
  animated or damped cannot be judged by eye — drive `controls.update()` from
  `javascript_tool` and read numbers instead), Radix ignores synthetic events,
  and a pane left idle silently stops delivering clicks until the tab is closed
  and reopened.
- **A version bump touches six places at once**: `artifactName` ×2 in
  `electron/electron-builder.yml` plus its header comment, `version` in
  `package.json` and `electron/package.json`, the two top-level fields of
  `package-lock.json` (dependencies share that version string — never
  blanket-replace), `scripts/build-electron.js`, the README, and the folder name.
- **Declined by the user, do not re-propose**: auto-hiding `empty`/`wedge`
  patches in the mesh viewer, even though they are 91–99.95% of their cases.

## 6. Files that are not ours

`AGENTS.md` and `CLAUDE.md` in this folder are generated by `next dev` (the
Next.js agent-rules block) and are gitignored — they carry no project state, and
anything written there is overwritten on the next dev run. `Working/.claude/
launch.json`, one level up, is the Browser pane's dev-server config; it lives
outside the repo on purpose.
