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

- **v5.0.0 is released.** Tag `v5.0.0` and `origin/main` identify its release
  commit; local `main` may contain later committed work waiting for an
  explicitly requested push. What it contained is in `docs/releases/v5.0.0.md`;
  both artifacts are attached on GitHub and copied to `Working/`.
- The repository is MIT licensed. OpenFOAM is not bundled and is a separate GPL
  program inside WSL.

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

- Supported: the OpenFOAM Foundation line v9–v14, with legacy (`<=10`) or
  modular (`>=11`) case layouts. ESI releases such as `v2312` are not; do not
  imply compatibility or tailor generated cases to them.
- New Case generates a parametric box mesh, synchronized patch fields,
  version-correct dictionaries, dimension sets and a preflight.
- The installed vocabulary comes from `foamToC` and source scans; tutorial retrieval is BM25 plus an Italian glossary, not embeddings. All knowledge caches share an identity made from distro, resolved install paths and installed-binary metadata, so a distro/version/in-place install change invalidates them together.
- The ParaView tab is an optional local integration, not a bundled dependency:
  `paraFoam -touch` and one persistent app-owned `pvpython` worker, whose real
  `paraview.simple` proxies own the reader, filters, displays, time and render;
  the browser presents the workbench and receives frames. Never embed ParaView's
  Qt UI, and never accept browser-supplied Python, proxy or property names —
  every operation goes through an explicit API/worker allowlist.
  Discovery must not hard-code a version or install directory: check the saved
  override, environment, PATH, registry and common roots, with a manual
  folder/executable path as the universal fallback. Detection and path settings
  belong on the Dashboard beside Ubuntu/OpenFOAM; keep the ParaView tab focused
  on the workbench itself.
- The worker supports pipeline and region selection, reconstructed/decomposed
  readers and a capability-detected catalogue of 23 filters, enumerated in its
  own allowlist — keep those allowlists explicit. Insert Cell Data to Point Data
  when a point-field filter needs it, and offer Tube only for line-producing
  inputs, which otherwise crashes ParaView.
- Manipulators use real ParaView guide geometry, never a cosmetic 2D overlay.
  Drags are allowlisted and converted through the camera basis; keep numeric
  property editing as an exact alternative, hide inactive guides, and let
  overlay controls stop pointer propagation before the viewport captures it.
- Additional ParaView sources open only from files inside the active case, by
  allowlisted extension, validated twice, symlinks rejected. No file picker.
- Camera and timestep interaction render at full viewport resolution: coalesce
  pending requests and drop stale timesteps rather than shrinking the image. The
  Information panel reports reader-level bounds independently of filter output.
- Do not key ParaView compatibility to a version number: inspect property
  domains and keep aliases for renamed properties and proxy values. An OpenFOAM
  `0` directory alone is input, not a result time — label it mesh only, and keep
  non-scalar representations working without `ColorBy(None)`.
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
- The Compute panel is TWO editable texts and nothing else to fill in: the whole
  command, flags included, and the `functions { #includeFunc … }` entry for the
  solve. No generated form — a form invents a control per argument and gets some
  wrong — and no side boxes for `-time` or `-fields`, which sat beside a call
  they were not part of. Both are prefilled from the installation: real argument
  names, examples from each template's own `e.g.` note, a patch the case
  actually has, and a leading `name=` so results land in a readable directory
  rather than one named after the whole call with its spaces stripped.
  Placeholders are classified by SHAPE — singular versus plural, field versus
  patch — because the templates use 57 distinct ones and a table of names would
  be wrong on the next version.
- An editable command must not become an editable shell. It is PARSED, not
  passed: the utility name, then only `-func`, `-time`, `-fields`, `-region`,
  `-latestTime`, `-noZero`, each value checked, anything else refused by name.
  `-case` in particular is refused, so a run cannot leave the open case.
- The `#includeFunc` entry is text to copy. Do NOT write it into the user's
  `controlDict`. Both texts are a scratchpad for one visit: closing the panel
  restores the installation's own call.
- What the panel documents is what is PARTICULAR to each function: its
  arguments, the class behind it, the entries its `#includeEtc` hides and can
  be overridden, and how the installed tutorials call it. A general syntax note
  was identical on all 127 and taught nothing after the first read. Nothing
  there is written by hand — the defaults come from following the include chain,
  the examples from the tutorials of the version in use.
- Grid columns that hold code need `min-w-0`. A grid item defaults to
  `min-width: auto` and will not shrink below its content, so one long call in a
  `<code>` widened the dialog and carried its footer off the window.
- The tab also lists the case's solver logs and plots their initial residuals.
  The parser lives in `src/lib/residuals.ts` and is shared with the Monitor;
  keep it there. Residuals are reshaped into the same columns-and-rows table the
  function-object datasets use, so chart, table, CSV and image export stay a
  single path — do not add a second rendering route for them.
- Chart export builds the SVG document ONCE and shows that document as the
  preview, so the preview cannot drift from the file. It has to: recharts draws
  `<Legend>` as an HTML `<div>` over the svg, so serializing the svg node lost
  the legend entirely and the exported figure came out unlabelled. Title, axis
  titles and legend are therefore drawn as real SVG, the font stack is inlined,
  and the background is a `rect` rather than a CSS property. PNG is rasterised
  from the same document through a `data:` URL — a `blob:` URL taints the canvas
  and `toBlob` then throws. Every axis gets a name by default; leaving one blank
  because several series are plotted is what made a figure look unlabelled.
  The chart node is held in STATE through a callback ref and watched with a
  MutationObserver, because Radix mounts dialog content in a LATER commit than
  the one where `open` turns true: a plain ref was null when the effect first
  ran, so nothing was ever built and the preview stayed blank until some other
  change happened to re-run it.
- Out of scope for now, deliberately: writing into `controlDict`, decomposed or
  parallel runs, and multi-region cases. Surface and VTK writers are not
  charted here — they belong to the ParaView tab.

### FOAMy

FOAMy reads bounded case context and proposes whole-file edits to apply. It fingerprints the dictionary tree before every contextual turn and reloads after agent, script or terminal writes. Truncated input and output are marked, unsafe applies are withheld, and API keys stay in the Electron config, encrypted with the Windows account.

### Claude and Codex

Claude and Codex are separate in-app agents but share the same OpenFOAM tool
schemas, prompt, policy, case confinement, and activity model.

- Guarded mode may read and write within the run directory and execute installed
  OpenFOAM applications. It has no general shell, filesystem, web, plugin, MCP,
  or desktop access beyond the supplied tools.
- Guarded agents may run an existing `Allrun`, `Allclean`, `Allmesh`, `Allwmake`, or `Alltest`, but may not write those script names. This closes the write-script/run-script shell escape without breaking tutorial scripts.
- Command arguments are resolved and must remain inside the run directory, so
  sibling-case tools such as `mapFields ../coarse` still work.
- Unrestricted mode enables a WSL shell inside the case, but `/mnt/` remains
  blocked to protect Windows files.
- Reading is free. `run_openfoam` runs only when the user asks; guarded option names and required values are checked against that binary's own `-help`. `write_case_file` automatically refuses known-invalid names or syntax before writing; `validate_case_files` remains the cross-file check. An ambiguous request is a question, never a simulation.
- Claude runs with strict MCP configuration and no inherited tools or settings.
- Codex uses an isolated `%APPDATA%\\openfoam-studio\\codex` home and needs Codex
  CLI 0.153.1+. Its real protocol contract test is opt-in through
  `OFSTUDIO_TEST_CODEX`: normal tests never reach the network or spend a
  subscription.

### Security boundary

- `/api/agent/tools` fails closed and requires the per-process agent token, and
  `src/proxy.ts` blocks browser-labelled cross-origin API requests.
- Selected OpenFOAM bashrc paths must come from the detector's own results.
- Case names and relative paths use the shared validators: no absolute path,
  traversal, NUL, control character or prefix-sibling escape.
- File writes use a sibling temporary file, preserve permissions, and rename
  atomically.
- External links opened by Electron are restricted to HTTP and HTTPS.
- In unrestricted mode a failed `cd` aborts before any command can run.
- The unrestricted `/mnt/` check guards against accidents, not a determined
  bypass: any other route to Windows storage is a real security finding.
- Never put secrets in `.env` — it is copied into the app. Local overrides go in
  ignored `.env.local`; credentials are never committed, logged or shipped.
- Report vulnerabilities privately through GitHub's Security tab, never a public
  issue, and publish no exploit details without the user's instruction.

## 5. Current UI behavior

- Hardware acceleration stays enabled: the Mesh viewer needs real WebGL. It is
  not a workaround for focus or input bugs.
- The shell owns the viewport: header, tabs and status bar stay fixed while the
  content scrolls, and two-pane workspaces use bounded scroll areas.
- FOAMy, Claude and Codex launchers share a saved bottom-right anchor; several fan out, one stays put, panels always sit above them, and every AI surface shows the indexed version, freshness, date and knowledge counts.
- Tab shortcuts are `Ctrl+0`–`Ctrl+9` and the digit IS the tab index, so
  `Ctrl+0` is the Dashboard and `Ctrl+9` is Src. Adding an eleventh tab breaks
  this and needs a different scheme, not a silently dropped shortcut.
- Anything read from the INSTALLATION must follow the selected OpenFOAM. The
  Dashboard raises `foam-version-changed` on both a version and a distro switch;
  a tab that caches installation data has to listen. Post-Process went on
  offering v14's 127 function objects after a switch to v13's 119 purely because
  it never subscribed.
- The Mesh viewer uses TrackballControls for free rotation, renders on demand,
  and must consume zero CPU while idle. Vertex labels stay a fixed visual size.
- Mesh framing accounts for both fields of view, and WebGL drawing buffers
  respect device pixel ratio, adapter limits and a ~4K budget without changing
  CSS geometry. A HiDPI canvas using `setSize(..., false)` must keep explicit
  `width: 100%; height: 100%` CSS, or its buffer size becomes its layout size on
  scaled displays and crops the mesh.
- Renderer creation retries without MSAA, reports missing WebGL2, and remeasures
  after hidden mounts, resize and context restoration; teardown calls
  `forceContextLoss()` and disposes label textures.
- Monitor manual refresh waits for an in-flight poll, then makes a fresh request.
- Dashboard OpenFOAM and ParaView gears open independent settings panels. An
  explicit scan bypasses caches; a failed detection is negative-cached only
  briefly and must never erase an already valid client list.
- File Editor refreshes directories without replacing the open buffer, dirty
  state, selection or expansion, and confirms before leaving unsaved text.
- The editor also watches the OPEN file for writes it did not make — an agent,
  FOAMy, a script, the user's terminal — by polling a `stat` fingerprint. A
  clean buffer is replaced silently, keeping caret and scroll; a dirty one is
  never touched and is offered a reload instead. Its content cache is validated
  against that fingerprint: an unvalidated cache is what made an agent's edits
  invisible until the case was closed and reopened, because reopening the file
  never reached WSL at all.
- The word-wrap control is visual only, exposing `Wrap On`/`Wrap Off` and `aria-pressed`.

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

Full validation is `npm run check`; it includes v9-v14 lookup/command checks and Italian tutorial-retrieval fixtures. The build is `npm run electron:build`, or
`node scripts/build-electron.js --skip-build` to package without rebuilding.

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
   existing base64 script runner. `getCaseSummary` was passing its whole script
   to `runInWsl` instead, and an added `awk` program arrived mangled and
   silently produced nothing — the symptom was an empty patch list, not an
   error.
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
