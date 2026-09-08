# RULES — canonical AI project instructions

Last updated: 2026-09-08.

**This is the single canonical file for every project-specific rule an AI must
follow.** The tiny tracked `AGENTS.md` only routes an AI here and must not
contain separate project rules. Other documents may describe the product, public
contribution process, security policy, releases, or historical evidence; when
they reveal a durable AI instruction, record it here as well.

Read this entire file and `README.md` before changing the project. Keep this file
compact: **it must never remain above 500 lines.** If an update would take it
past 500, compact it in the same task before committing. Preserve current
decisions, safety boundaries, commands, and known traps; remove chronology,
repetition, measurements that no longer guide work, and implementation history
already recoverable from Git, `docs/releases/`, or
`docs/audit-2026-09-03.md`. Never solve growth by splitting AI rules into a
second file.

## 1. Current state

- **v4.0.0 is released.** Tag `v4.0.0` and `origin/main` identify its release
  commit; local `main` may contain later committed work waiting for an
  explicitly requested push.
- The release adds the integrated ParaView workbench, reconstructed/decomposed
  cases, 23 filters and interactive 3D guides, plus the shared assistant
  launcher, HiDPI-safe Mesh viewer and independent runtime settings.
- Both release artifacts are attached on GitHub and copied to `Working/`:
  `OpenFOAMStudio-v4.0.0-portable.exe` and
  `OpenFOAMStudio-v4.0.0-folder.zip`.
- The repository is MIT licensed. OpenFOAM is not bundled and is a separate GPL
  program inside WSL.
- A **Post-Process** tab has been added after Mesh and is committed locally,
  waiting for an explicitly requested push. It reads `postProcessing/` and runs
  function objects over times already written; it does not write them into
  `controlDict`.

Open items:

- `Working/OpenCFD-trademark-request.md` has been sent to OpenCFD; no answer is
  recorded yet.

## 2. Working agreement

These are standing user instructions:

1. **Build only after an effective application change.** Changes to runtime
   code, UI, packaged assets, dependencies, build configuration, or anything
   that can alter the installed app require an Electron build. Documentation,
   comments, tests, formatting, or repository housekeeping alone do not. This
   avoids spending minutes rebuilding identical binaries. When a build is
   required, use the incremental path and never wipe caches for a clean start.
2. **Every required build delivers both artifacts.** Copy the fresh portable
   executable and folder zip into `Working/`, and remove the previous version's
   pair there and from `dist-electron/` when a new version is cut.
3. **Commit every completed change locally** in coherent commits. Do not add
   `Co-Authored-By` trailers.
4. **Never push, tag, publish, replace a release asset, or bump the version
   without an explicit request in the current user message.** A local commit is
   authorized; anything leaving the machine is not.
5. Version bumping happens as part of a user-requested publication, not while
   ordinary work accumulates.
6. Never decide the number of subagents alone. Before starting any subagent,
   ask the user in the live conversation how many may be opened, and open at
   most that many. Each subagent must update `docs/agent-log/<task>.md` after
   every step with completed work, findings, next action, and touched files.
   The directory is ignored by Git.
7. Never run destructive tests against the user's real WSL cases. Use only the
   disposable `claude_test` and `cavity_test` cases described in section 6.
8. The user writes in Italian; repository prose, UI copy, and comments remain
   in English.
9. Keep all durable AI instructions in this file. Update it when the user makes
   a standing decision or when a bug reveals a reusable trap. Do not leave the
   only copy of a rule in a chat, code comment, audit note, or release note.
10. Help the user with code and GitHub publication, but treat publication as the
    separately authorized action described above.

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
| `src/lib/postprocess.ts` | function-object output and template parsing (pure) |
| `src/components/openfoam/post-process.tsx` | the Post-Process tab |
| `src/lib/stl.ts` | STL parsing and Mesh API wire format |
| `src/lib/paraview.ts` | ParaView discovery and persistent headless workbench |
| `src/components/openfoam/mesh-viewer.tsx` | three.js viewer |
| `src/components/agent-launcher-provider.tsx` | shared assistant launcher |
| `scripts/build-electron.js` | Next build, resources, Electron packaging |

## 4. Current functionality and boundaries

### OpenFOAM compatibility

- The app supports the OpenFOAM Foundation line v9–v14 and selects legacy
  (`<=10`) or modular (`>=11`) case layouts. ESI releases such as `v2312` are
  unsupported; do not imply compatibility or tailor generated cases to them.
- New Case generates a complete parametric box mesh, synchronized patch fields,
  version-correct dictionaries, numeric dimension sets, and a preflight.
- The installed OpenFOAM vocabulary is built with `foamToC` and source scans,
  cached in WSL, and used to ground FOAMy and validate proposed dictionaries.
- Tutorial retrieval uses BM25 plus an Italian-to-OpenFOAM glossary. This was a
  deliberate lightweight choice over shipping a large embedding runtime.
- The ParaView tab is an optional local integration, not a bundled dependency.
  It uses `paraFoam -touch` and one persistent app-owned `pvpython` worker. Real
  `paraview.simple` proxies own the reader, filters, displays, time and offscreen
  render; the browser presents the pipeline/properties workbench and receives
  rendered frames. Never embed ParaView's Qt UI or accept browser-supplied
  Python, proxy names, or arbitrary property names: every operation is an
  explicit API/worker allowlist.
  Discovery must not hard-code a version or install directory: check the saved
  override, environment, PATH, registry and common roots, with a manual
  folder/executable path as the universal fallback. Detection and path settings
  belong on the Dashboard beside Ubuntu/OpenFOAM; keep the ParaView tab focused
  on the workbench itself.
- The ParaView worker supports pipeline selection/visibility, mesh-region and
  patch selection, reconstructed/decomposed readers and a capability-detected
  catalogue of 23 filters: Slice, Clip, Contour, Threshold, Stream Tracer,
  Glyph, Transform, Reflect, both Warp variants, Shrink, Plot Over Line, Cell
  Centers, Tube, Calculator, Gradient, Temporal Statistics, Integrate Variables,
  both cell/point conversions, Extract Surface, Extract Edges and Connectivity.
  Keep API/worker allowlists explicit. Insert Cell Data to Point Data when a
  point-field filter needs it, and only offer Tube for line-producing inputs to
  avoid native ParaView crashes.
- Slice/Clip planes, Stream Tracer point-cloud spheres/lines and Plot Over Line
  lines use real ParaView guide geometry. Browser drag actions are allowlisted,
  converted through the camera basis and update both the active proxy and guide;
  do not substitute a cosmetic 2D overlay. Preserve numeric property editing as
  an exact alternative and hide inactive guides. Overlay controls must stop
  pointer propagation before the viewport captures the pointer.
- Additional ParaView sources may be opened only from files physically inside
  the active case. List only allowlisted data extensions, validate the relative
  path at the API, resolve it again in the worker, reject symlink/path escapes,
  and use ParaView's own compatible reader. Never expose a general file picker.
- Camera and timestep interaction render at full viewport resolution. Coalesce
  pending motion/time requests and discard stale intermediate timesteps instead
  of reducing image dimensions. The Information panel must report reader-level
  bounds, centre and colour-coded X/Y/Z dimensions independently of filter output.
- Do not key ParaView compatibility to a version number. Inspect property
  domains/capabilities and keep aliases for renamed properties or proxy values
  (for example Point Cloud/Point Source and old/new Threshold ranges). An
  OpenFOAM `0` directory alone is input, not a result timestep: label it mesh
  only and keep non-scalar representations working without `ColorBy(None)`.
- `foamDictionary` syntax checks run on Linux-side temporary files. An OpenFOAM
  binary must never run with the Windows-mounted project path as its working
  directory: the space in the Windows username makes OpenFOAM abort.

### Post-processing

The Post-Process tab reads `postProcessing/` and charts it; it is quantitative
and works without ParaView. Keep the boundaries with the tabs it sits between:
Monitor owns the solver log and its residuals, ParaView owns the 3D fields, and
Commands owns running arbitrary binaries.

- Never hard-code the function-object catalogue. It is read from
  `etc/caseDicts/postProcessing/**`, whose templates declare their own
  arguments as `<placeholder>` entries with the comment that documents them —
  127 on v14, 119 on v13, and identical to what `foamPostProcess -list` reports
  without paying for an OpenFOAM startup. The base-class keys (`type`, `libs`,
  the execute/write controls) are filtered out: they are not parameters.
- The retroactive utility is `foamPostProcess` on v12+ and `postProcess` before
  it. Resolve it with `command -v` at run time; do not key it to a version.
- A time directory means two different things and the file's own first column
  is what decides. `Time` means a restart continuing one series, so slices are
  stitched and a later run's rows replace recomputed ones. Anything else
  (`distance`, `x`) means a complete profile sampled at that instant, so slices
  must NOT be merged and the user picks a time.
- Composed `-func` specifications are validated against the installation's own
  catalogue, restricted to an allowlisted character set, and shell-quoted.
  Values are wrapped in parentheses by shape, not by the template's spelling:
  `start <point>;` shows none and still needs `(0.01 0.05 0.005)`.
- Out of scope for now, deliberately: writing into `controlDict`, decomposed or
  parallel runs, and multi-region cases. Surface and VTK writers are not
  charted here — they belong to the ParaView tab.

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
- Treat the unrestricted `/mnt/` text check as protection against accidents,
  not a complete sandbox against a determined bypass. Any way to reach Windows
  storage without spelling `/mnt/` is a real security finding.
- Never place secrets in `.env`: it is copied into the packaged application.
  Local overrides belong in ignored `.env.local` or `.env.*.local` files, and
  credentials must never be committed, logged, or included in artifacts.
- Security vulnerabilities are reported privately through GitHub's Security
  tab, not in a public issue. Do not publish exploit details without the user's
  explicit instruction.

## 5. Current UI behavior

- Hardware acceleration must remain enabled. The Mesh viewer requires real
  WebGL; disabling GPU acceleration forces the wrong renderer and is not an
  acceptable workaround for unrelated focus or input bugs.
- The shell owns the viewport: header, tabs, and status bar stay fixed while
  main content scrolls. Two-pane workspaces use bounded native scroll areas.
- FOAMy, Claude, and Codex launchers share a saved bottom-right anchor. Multiple
  launchers fan out; a lone launcher stays fixed. Panels always sit above them.
- Tab shortcuts are `Ctrl+0`–`Ctrl+9` and the digit IS the tab index, so
  `Ctrl+0` is the Dashboard and `Ctrl+9` is Src. Adding an eleventh tab breaks
  this and needs a different scheme, not a silently dropped shortcut.
- The Mesh viewer uses TrackballControls for free rotation, renders on demand,
  and must consume zero CPU while idle. Vertex labels stay a fixed visual size.
- Mesh framing accounts for horizontal and vertical field of view. WebGL drawing
  buffers respect device pixel ratio, adapter limits, and a roughly 4K pixel
  budget without changing CSS geometry. A HiDPI canvas using `setSize(...,
  false)` must retain explicit `width: 100%; height: 100%` CSS; otherwise its
  physical buffer size becomes its layout size on scaled laptop displays,
  cropping both the centred mesh and the bottom-corner axes.
- Renderer creation retries without MSAA, reports missing WebGL2 clearly, and
  remeasures after hidden mounts, resize, and context restoration. Teardown must
  call `forceContextLoss()` and dispose label textures.
- Monitor manual refresh waits for an in-flight poll and then performs a fresh
  request; it cannot be swallowed by automatic polling.
- Dashboard OpenFOAM and ParaView gears open independent settings panels. An
  explicit OpenFOAM scan bypasses cached results; empty/error detection is only
  negative-cached briefly and must never erase an already valid client list.
- File Editor refreshes visible and expanded directories without replacing the
  open buffer, dirty state, selection, or expansion state. Navigation away from
  unsaved text requires confirmation.
- The word-wrap control is visual only and exposes `Wrap On` / `Wrap Off` plus
  `aria-pressed`.

## 6. Test case

Two WSL cases are disposable and may be broken or recreated from OpenFOAM 14
tutorials:

- `~/OpenFOAM/tommasoferrara-14/run/claude_test`: TJunction with `blockMesh`
  already run, used for mesh-only and patch tests.
- `~/OpenFOAM/tommasoferrara-14/run/cavity_test`: solved cavity with 20 result
  timesteps and `processor0` through `processor3`, used for filters, fields,
  animation and reconstructed/decomposed reader tests.

Do not use `cavity`, `nozzleFlow2D`, or `shockTube` for destructive testing.

## 7. Validation and build

Run validation in proportion to the change. Application code normally gets the
full check; documentation-only changes need spelling/reference/diff checks but
do not require the application test suite or Electron build unless they alter a
generated or packaged input.

Full application validation:

```powershell
npm run check
```

Build commands:

```powershell
npm run electron:build
node scripts/build-electron.js --skip-build  # packaging only
```

Run the build only under the effective-application-change rule in section 2.
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
  resources. It verifies content even when size/mtime match, uses durable
  atomic copies, preserves mtimes, and deletes stale destination entries.
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
2. **Next 16 differs from older Next versions.** Automatic `AGENTS.md` and
   `CLAUDE.md` generation is disabled with `agentRules: false`; do not re-enable
   it or duplicate rules outside this file. Read the relevant guide under
   `node_modules/next/dist/docs/`, resolved from this project directory, before
   changing APIs, conventions, or file structure. Heed deprecations; do not
   rely on remembered behavior from older Next versions. `proxy.ts` replaced
   the deprecated middleware convention.
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
10. **AI routing files:** repository-root `AGENTS.md` is a tracked pointer to
    this file. Keep it minimal. `CLAUDE.md` and the legacy
    `Working/.claude/launch.json` were removed; Next must not regenerate them.
    Start the development server explicitly with `npm run dev` from
    `OpenFOAMStudio-source`.
11. **Code style:** match the naming, idiom, and comment density of the file
    being edited. Comments should explain why a non-obvious choice exists or
    why an apparent alternative failed, rather than restating the code.
12. **`find` does not follow symlinks.** On this installation
    `etc/caseDicts/postProcessing` IS a symlink to `etc/caseDicts/functions`, so
    `find <path> -type f` reports the link and nothing under it. The
    function-object catalogue came back EMPTY until every find in that path
    became `find -L`. Suspect this for any OpenFOAM tree that lists with `ls`
    but finds nothing.
13. **tailwind-merge keeps a bare utility and a breakpoint variant apart.** A
    `max-w-5xl` passed to a component whose base class is `sm:max-w-lg` does not
    replace it: both survive and the variant wins above 640px. Override the SAME
    variant (`sm:max-w-5xl`). This affects every shadcn component with a
    responsive default.
14. **Startup reports:** when investigating a launch failure, collect
    `%APPDATA%\\openfoam-studio\\startup.log` immediately after reproduction;
    it is truncated on every launch. Always record whether the folder zip or
    portable executable was used, because their startup paths differ.

## 10. Documentation map

- `README.md`: product description, installation, usage, architecture, and the
  packaged-app traps users and contributors need.
- `docs/RULES.md`: the only canonical AI instructions and current operational
  state (this file); keep it at or below 500 lines.
- `docs/audit-2026-09-03.md`: consolidated security, correctness, robustness,
  and frontend audit with verification evidence.
- `docs/releases/`: canonical release history and asset naming.
- Git history: implementation archaeology and details removed from this handoff.
