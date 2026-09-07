# Handoff — current project state

Last updated: 2026-09-07.

This file is intentionally concise. Historical implementation details belong in
Git history, `docs/releases/`, and `docs/audit-2026-09-03.md`; do not copy them
back here. Read this file and `README.md` before changing the project.

## 1. Current state

- **v3.2.0 is released.** Tag `v3.2.0` and `origin/main` identify release
  commit `d833d47`; local `main` may contain later committed work waiting for an
  explicitly requested push.
- The release contains the shared FOAMy/Claude/Codex launcher, GPU- and
  viewport-safe Mesh viewer, reliable Monitor and File Editor refresh, and the
  visible word-wrap state.
- Both release artifacts are attached on GitHub and copied to `Working/`:
  `OpenFOAMStudio-v3.2.0-portable.exe` and
  `OpenFOAMStudio-v3.2.0-folder.zip`.
- The repository is MIT licensed. OpenFOAM is not bundled and is a separate GPL
  program inside WSL.
- The latest full local check passed on 2026-09-07: typecheck, lint, and 103
  tests; the real Codex contract test was correctly skipped because it is
  opt-in.

Open items:

- `Working/OpenCFD-trademark-request.md` has been sent to OpenCFD; no answer is
  recorded yet.
- The GitHub social preview image still has to be uploaded by the user from the
  repository Settings page.
- One old folder build reportedly lost `resources/standalone` after previously
  launching successfully. No cause was proven. Startup diagnostics now record
  enough detail to investigate if it happens again.

## 2. Working agreement

These are standing user instructions:

1. **Rebuild after every project change.** Use the incremental build path; do
   not delete caches to start clean.
2. **Always deliver both artifacts.** Copy the fresh portable executable and
   folder zip into `Working/`, and remove the previous version's pair there and
   from `dist-electron/` when a new version is cut.
3. **Commit every completed change locally** in coherent commits. Do not add
   `Co-Authored-By` trailers.
4. **Never push, tag, publish, replace a release asset, or bump the version
   without an explicit request in the current user message.** A local commit is
   authorized; anything leaving the machine is not.
5. Version bumping happens as part of a user-requested publication, not while
   ordinary work accumulates.
6. At most two subagents may run concurrently, in addition to the main agent.
   Each subagent must update `docs/agent-log/<task>.md` after every step with
   completed work, findings, next action, and touched files. The directory is
   ignored by Git.
7. Never run destructive tests against the user's real WSL cases. Use
   `claude_test`.
8. The user writes in Italian; repository prose, UI copy, and comments remain
   in English.

Interface decisions already made:

- The application is colourful on purpose. Refine its existing orange, green,
  warning, danger, info, and secondary accents; do not flatten it into a neutral
  monochrome design.
- The rejected monochrome overhaul is kept only in
  `stash@{0}: UI overhaul 2026-09-04 — rejected by the user`. Never restore it
  wholesale.
- Do not re-propose automatically hiding `empty` or `wedge` patches in the Mesh
  viewer; the user declined it.

## 3. Runtime architecture

The portable executable is an Electron shell. `electron/main.js`:

1. binds an unused localhost port;
2. starts the bundled `node.exe` with `windowsHide: true`;
3. runs the Next standalone server in `resources/standalone`;
4. opens a `BrowserWindow` at `http://127.0.0.1:<port>`;
5. kills the server process tree when the app quits.

The renderer calls REST routes under `src/app/api/**`. OpenFOAM operations go
through `src/lib/wsl.ts`, which launches `wsl.exe`. The practical chain is:

`Electron renderer -> Next server -> wsl.exe -> OpenFOAM`

Important modules:

| Path | Responsibility |
|---|---|
| `electron/main.js` | lifecycle, window, server, startup diagnostics |
| `electron/preload.js` | renderer/main bridge for FOAMy settings |
| `src/lib/wsl.ts` | all OpenFOAM and WSL process interaction |
| `src/lib/wsl-input.ts` | path, argument, PID, and field-name validation |
| `src/lib/agent-policy.ts` | shared Claude/Codex permissions and activity |
| `electron/mcp/openfoam-tools.json` | shared agent tool schemas |
| `src/lib/claude-cli.ts` | Claude discovery, authentication, streaming |
| `src/lib/codex-cli.ts` | isolated Codex app-server transport |
| `src/lib/case-templates.ts` | version-aware case generation |
| `src/lib/foam-index.ts` | installed OpenFOAM vocabulary and keys |
| `src/lib/foam-retrieval.ts` | tutorial retrieval and Italian glossary |
| `src/lib/stl.ts` | STL parsing and Mesh API wire format |
| `src/components/openfoam/mesh-viewer.tsx` | three.js viewer |
| `src/components/agent-launcher-provider.tsx` | shared assistant launcher |
| `scripts/build-electron.js` | Next build, resources, Electron packaging |

## 4. Current functionality and boundaries

### OpenFOAM compatibility

- The app supports OpenFOAM Foundation v9–v14 and selects legacy (`<=10`) or
  modular (`>=11`) case layouts.
- New Case generates a complete parametric box mesh, synchronized patch fields,
  version-correct dictionaries, numeric dimension sets, and a preflight.
- The installed OpenFOAM vocabulary is built with `foamToC` and source scans,
  cached in WSL, and used to ground FOAMy and validate proposed dictionaries.
- Tutorial retrieval uses BM25 plus an Italian-to-OpenFOAM glossary. This was a
  deliberate lightweight choice over shipping a large embedding runtime.
- `foamDictionary` syntax checks run on Linux-side temporary files. An OpenFOAM
  binary must never run with the Windows-mounted project path as its working
  directory: the space in the Windows username makes OpenFOAM abort.

### FOAMy

FOAMy reads bounded case context and proposes whole-file edits for the user to
apply. Truncated input and truncated model output are marked explicitly, and
unsafe apply actions are withheld. API keys stay in the local Electron config,
encrypted with the Windows user account.

### Claude and Codex

Claude and Codex are separate in-app agents but share the same OpenFOAM tool
schemas, prompt, policy, case confinement, and activity model.

- Guarded mode may read and write within the run directory and execute installed
  OpenFOAM applications. It has no general shell, filesystem, web, plugin, MCP,
  or desktop access beyond the supplied tools.
- Guarded agents may run an existing `Allrun`, `Allclean`, `Allmesh`, `Allwmake`,
  or `Alltest`, but may not write those script names. This closes the
  write-script/run-script shell escape without breaking tutorial scripts.
- Command arguments are resolved and must remain inside the OpenFOAM run
  directory. Legitimate sibling-case tools such as `mapFields ../coarse` remain
  possible.
- Unrestricted mode enables a WSL shell inside the case, but `/mnt/` remains
  blocked to protect Windows files.
- Reading is allowed freely. `run_openfoam` is used only when the user asks for
  a run; a question must not silently start a simulation. Ambiguous requests are
  treated as questions.
- Claude runs with strict MCP configuration and no inherited tools or settings.
- Codex uses an isolated `%APPDATA%\\openfoam-studio\\codex` home and requires
  Codex CLI 0.153.1 or newer.
- The real Codex protocol contract test is opt-in through
  `OFSTUDIO_TEST_CODEX`; normal tests must not reach the network or spend a
  subscription.

### Security boundary

- `/api/agent/tools` fails closed and requires the per-process agent token.
- `src/proxy.ts` blocks browser-labelled cross-origin API requests.
- Selected OpenFOAM bashrc paths must come from the detector's own results.
- Case names and relative paths use the shared validators; no absolute path,
  traversal, NUL, control character, or prefix-sibling escape is accepted.
- File writes use a sibling temporary file, preserve permissions, and rename
  atomically.
- External links opened by Electron are restricted to HTTP and HTTPS.
- In unrestricted mode a failed `cd` aborts before any command can run.

## 5. Current UI behavior

- The shell owns the viewport: header, tabs, and status bar stay fixed while
  main content scrolls. Two-pane workspaces use bounded native scroll areas.
- FOAMy, Claude, and Codex launchers share a saved bottom-right anchor. Multiple
  launchers fan out; a lone launcher stays fixed. Panels always sit above them.
- The Mesh viewer uses TrackballControls for free rotation, renders on demand,
  and must consume zero CPU while idle. Vertex labels stay a fixed visual size.
- Mesh framing accounts for horizontal and vertical field of view. WebGL drawing
  buffers respect device pixel ratio, adapter limits, and a roughly 4K pixel
  budget without changing CSS geometry.
- Renderer creation retries without MSAA, reports missing WebGL2 clearly, and
  remeasures after hidden mounts, resize, and context restoration. Teardown must
  call `forceContextLoss()` and dispose label textures.
- Monitor manual refresh waits for an in-flight poll and then performs a fresh
  request; it cannot be swallowed by automatic polling.
- File Editor refreshes visible and expanded directories without replacing the
  open buffer, dirty state, selection, or expansion state. Navigation away from
  unsaved text requires confirmation.
- The word-wrap control is visual only and exposes `Wrap On` / `Wrap Off` plus
  `aria-pressed`.

## 6. Test case

`~/OpenFOAM/tommasoferrara-14/run/claude_test` is the disposable WSL case. It is
a copy of the `incompressibleFluid/TJunction` tutorial with `blockMesh` already
run: 3D, about 6,300 triangles, four patches, and 20 blockMeshDict vertices.

It may be broken and recreated from the OpenFOAM 14 tutorials. Do not use
`cavity`, `nozzleFlow2D`, or `shockTube` for destructive testing.

## 7. Validation and build

Routine validation:

```powershell
npm run check
```

Build commands:

```powershell
npm run electron:build
node scripts/build-electron.js --skip-build  # packaging only
```

The full build is incremental and normally takes a few minutes. Never delete:

- `.next/cache`;
- `node_modules`;
- `electron/resources/bin/node.exe`;
- the Electron Builder cache under `%LOCALAPPDATA%`.

Stop `npm run dev` before building because development and production builds
share `.next`. The executable cannot be overwritten while it is running.

Every build must produce both:

- `dist-electron/OpenFOAMStudio-v<version>-portable.exe`;
- `dist-electron/OpenFOAMStudio-v<version>-folder.zip`.

The portable executable spends about 29 seconds extracting into TEMP. The
unzipped folder opens its window in roughly 130 ms and reaches the interface in
about four seconds. Both formats intentionally ship.

After building, verify the packaged server directly instead of launching the
GUI from an automated session:

```powershell
cd dist-electron/win-unpacked/resources
$env:PORT = '3117'
$env:HOSTNAME = '127.0.0.1'
./bin/node.exe standalone/server.js
```

From another shell, request `/api/wsl?action=ping`. Also search the packed
`.next` bundle for a string introduced by the change, proving the new source is
inside the artifact.

Packaging expectations:

- A normal portable executable is around 87 MB. A sudden multi-hundred-MB build
  usually means Next traced the project into itself.
- `electron/scripts/prepare-resources.js` mirrors rather than wipes standalone
  resources. It preserves mtimes and deletes stale destination entries.
- `next.config.ts` must continue excluding `dist-electron`, `electron`,
  screenshots, development configuration, and docs from standalone tracing.
- A nested path such as
  `.next/standalone/electron/resources/standalone/server.js` means packaging has
  recursively swallowed an earlier build and is wrong.

## 8. Versioning and publication

`package.json` is the source version and uses three-part semver:

| Item | Form |
|---|---|
| package version | `X.Y.Z` |
| tag | `vX.Y.Z` |
| title | `OpenFOAM Studio vX.Y.Z — <what changed>` |
| artifacts | `OpenFOAMStudio-vX.Y.Z-{portable.exe,folder.zip}` |
| notes | `docs/releases/vX.Y.Z.md` |

A requested version bump updates:

- `package.json`;
- `electron/package.json`;
- the two top-level version fields in `package-lock.json`;
- both README artifact names and the `Expand-Archive` example;
- `.github/ISSUE_TEMPLATE/bug_report.yml`;
- the manifest example in `electron/electron-builder.yml`.

Do not blanket-replace version strings in the lockfile. The Electron lockfile is
ignored and regenerated.

When publication is explicitly requested:

```powershell
npm run electron:build
npm run release:check vX.Y.Z
gh release create vX.Y.Z <portable.exe> <folder.zip> `
  --title "OpenFOAM Studio vX.Y.Z — <what changed>" `
  --notes-file docs/releases/vX.Y.Z.md
```

The tag must identify the exact source used for the attached artifacts. Never
move or replace a published tag/asset without explicit approval and a fresh
source-to-artifact verification.

## 9. Traps worth remembering

1. **Packaged-only behavior:** native `window.confirm()` and `alert()` can lose
   keyboard focus. Use `confirmDialog()` from `confirm-host.tsx`. Every WSL child
   must keep `windowsHide: true`. The server port changes every launch, so
   persistent state cannot live in origin-scoped `localStorage`.
2. **Next 16 differs from older Next versions.** Read the relevant guide under
   `node_modules/next/dist/docs/` before changing conventions. `proxy.ts`
   replaced the deprecated middleware convention.
3. **Shell variables through `wsl.exe`:** inline `$NAME` expansion is unreliable
   in this path. Multi-line scripts and scripts using variables must use the
   existing base64 script runner.
4. **JavaScript replacement strings:** `$&`, backticks, apostrophes, and doubled
   dollar signs have special meaning in `String.replace` replacement text. Use
   an edit or `.split(old).join(new)` for literal shell/document content.
5. **CSS cascade:** the global unlayered `:focus-visible` rule beats Tailwind v4
   layered utilities. Elements needing the local panel ring use
   `.no-focus-ring`; adding specificity inside a layer does not solve it.
6. **Browser-pane testing:** its console survives navigation, hidden panes stop
   `requestAnimationFrame`, Radix ignores synthetic events, and an idle pane may
   stop delivering clicks until reopened. Do not mistake those for app bugs.
7. **Background processes:** an explicitly backgrounded WSL command survives
   closing the app; a foreground command dies with the server process tree.
   `wsl --shutdown`, restart, hibernation, or killing `wslhost.exe` can still end
   detached work.
8. **Boundary validation:** not every file in `0/` is a physical field.
   `isPhysicalFieldFile` excludes exact bookkeeping names/extensions. Never use
   substring exclusions; legitimate fields can contain those words.
9. **Screenshots:** all files under `screenshots/` are referenced by README.
   Keep the set free of orphans. Automated sessions cannot produce the same
   full-window captures; ask the user for a saved image when one is needed.
10. **Generated local files:** repository-root `AGENTS.md` and `CLAUDE.md` are
    generated by `next dev`, ignored by Git, and carry the Next-version warning.
    Deleting them is temporary. `Working/.claude/launch.json` is the Browser
    pane's dev-server configuration and depends on the stable checkout folder
    name `OpenFOAMStudio-source`.

## 10. Documentation map

- `README.md`: product description, installation, usage, architecture, and the
  packaged-app traps users and contributors need.
- `docs/HANDOFF.md`: current operational state and constraints (this file).
- `docs/audit-2026-09-03.md`: consolidated security, correctness, robustness,
  and frontend audit with verification evidence.
- `docs/releases/`: canonical release history and asset naming.
- Git history: implementation archaeology and details removed from this handoff.
