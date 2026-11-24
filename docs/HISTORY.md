# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

## 2026-11-24 — Multi-region cases (foamMultiRun, chtMultiRegionFoam)

- Released `v5.10.0` (`docs/releases/v5.10.0.md`): the `564da41` pair, renamed
  without rebuilding (embedded 5.9.4); the v5.9.3 release entry was removed.

- Found on Lab06-surfaceFilm/combustor2D-film (v14, regionSolvers film +
  multicomponentFluid). `src/lib/case-regions.ts` finds regions as OpenFOAM and
  paraFoam do: regionSolvers, constant/regionProperties (9–10),
  constant/*/polyMesh; `?action=regions` on the case API.
- Processes: a fixed name list (no foamMultiRun, no 9–10 solvers) in three
  copies → `FOAM_PIDS_SH`: exe under `*/platforms/*/bin/*` (find over /proc,
  6 ms), mpirun `-parallel`, `wslgui_bg_`. Monitor showed the run idle; Kill
  could not stop it.
- Logs: region-prefixed solves (`fluid smoothSolver: …`) and 9–10's "Solving for
  fluid region X" give `fluid/Ux` (Monitor, Post-Process, agent digest); the
  digest awk accepts indented Time/deltaT/ExecutionTime/End. getLastSimTime
  matched `ExecutionTime =`/`ClockTime =` (moved to residuals.ts).
- Per region: BC validation (0/<r> vs constant/<r>/polyMesh), checkMesh
  (`-region`, one report), mesh surface (surfaceMeshTriangulate -region with
  `-libs lib<module>Solver.so`: film's filmWall is unknown without it), case
  summary, agent mesh/field digests, preflight (regionSolvers instead of
  `solver`, a region mesh is a mesh), Dashboard counts.
- ParaView: the plain `<case>.OpenFOAM` marker (VTK's reader lists
  `/fluid/internalMesh`…; the `{region}` markers show nothing in it).
  Post-Process: `postProcessing/<region>/<fn>` datasets, a Region selector
  (`-region`, the region's `-solver`). Commands: foamMultiRun, `-region`,
  `-allRegions`. Checked on a temporary copy, since removed.
- File Editor preflight on that case: 14 "not verified" → 1 (checkMesh not
  run). Large ASCII initial fields are read with nonuniform lists emptied
  (`CONDENSE_NONUNIFORM_AWK`); BC validation resolves `#includeEtc` through
  foamEtcFile (setConstraintTypes); a `type` below a patch entry is a model,
  not a BC; TypeName-declared names (parcel models) are known; installation
  libs are not custom code; per-region fvSchemes/fvSolution/fields warnings.

## 2026-11-17 — File Editor: faster on large cases, remembers each case

- Released `v5.9.4` (`docs/releases/v5.9.4.md`): the `f9adc81` pair, renamed
  without rebuilding (embedded 5.9.3); the v5.9.2 release entry was removed.
- `getCaseInfo`/`listDirectory` forked `basename` per entry (and `grep` per
  folder): 1.5 s on Lab05 combustor2D-spray (~1,400 entries) vs 27 ms with
  `${item##*/}`, same output on four cases. The API routes use the new async
  variants and `statFile` is async, so the 4 s polls no longer block the server
  (info + ls + stat in parallel: ~230 ms each).
- The tree is a `React.memo` `FileTree` with ref-backed stable callbacks:
  typing with 65 folders open went from 290 ms to 24 ms median per keystroke
  (dev build); `loadFile` still sees unsaved edits.
- `caseMemory` (module-level, per session) keeps the open file, caret, scroll
  (recorded on scroll: a hidden textarea reads 0), open folders, tree and file
  cache; returning to a case reopens the file from disk, quietly.

## 2026-11-14 — Etc tab: browse $FOAM_ETC

- Released as `v5.9.3` (the `b37a736` pair renamed, embedded 5.9.2).
- New `etc` section (`FOAM_SECTIONS` in `src/lib/wsl.ts`: `$FOAM_ETC`, else
  `$WM_PROJECT_DIR/etc`) in the same `OpenFoamBrowser`, as a tab before
  Applications. Ctrl+8 is Etc, Ctrl+9 Applications; Src has no digit now. Tab
  labels appear from 1180 px (the labelled row is 1135 px wide).

## 2026-11-10 — File Editor: shell scripts no longer read as one comment

- Released as `v5.9.2` (the `2310f48` pair renamed, embedded 5.9.1).
- `cd ${0%/*}` at the top of every Allrun opened an OpenFOAM `/* … */` comment
  that never closed. `syntaxFor` (`src/lib/editor-highlight.ts`) reads Allrun,
  Allclean & co., `*.sh` and `#!` files with shell rules: `#` at a word start,
  '…'/"…" strings, `$1` not a number. Checked in the dev server on
  `assignment1/combustorSimple` (opened only); dictionaries unchanged.

## 2026-11-06 — TEMP leftovers and stale browser caches removed at start

- Released as `v5.9.1` (the `44d0ce3` pair renamed, embedded 5.9.0).
- Found on the user's machine: six portable extractions in `%TEMP%` (2.1 GB,
  left when the stub is ended before it can delete them), ~150
  `openfoam-studio-paraview-session-*` folders (the server is `taskkill`ed on
  quit, so the worker never removes its folder; the warm-up made one per
  launch), 20 content-addressed Claude prompt files, and a 260 MB Chromium HTTP
  cache whose entries are keyed by a port that changes every launch.
- `electron/housekeeping.js` (now in the asar `files` list) lists them before
  the server is spawned and deletes them in the background; prompt files go at
  once, as their names are reused. Folders whose `OpenFOAMStudio.exe` or
  `resources/bin/node.exe` cannot be opened for writing are running and are
  kept, as are portable folders under 10 min old (Windows renames a folder with
  a running .exe in it: a rename is no in-use test). `main.js` also empties the
  HTTP and V8 code caches at start. It uses `original-fs`: Electron's `fs`
  cannot delete `app.asar`. Covered by `tests/housekeeping.test.ts`.

## 2026-11-06 — File Editor: fold arrows in the text, number colour

- Released as `v5.9.0` (the `ff35265` pair renamed, embedded 5.8.2).
- The fold arrow sits right after each foldable `{` (`BraceBlock.openChar`),
  and a folded block's `▸ ⋯ N lines` opens it; the gutter keeps only numbers.
  To be clickable the layer now lies OVER the textarea, pointer-events none
  but for the arrows, clipped to the textarea's client area; it is aria-hidden
  and the arrows are out of the tab order (toolbar Fold/Unfold all remain).
- Numbers (`1`, `-0.5`, `1e-05`) get their own colour, chosen and saved like
  the comment one (`editor-number-color`); digits in names (`U_0`, `p2`,
  `k:0`), strings and comments are left alone.
- Checked in the dev server on a disposable cavity: fold and unfold by the
  arrow and by the marker, caret and double-click selection through the layer,
  the number colour applied and saved.

## 2026-11-05 — File Editor find/replace and folding; analysis buttons hide their request

- Find/replace (`src/lib/editor-search.ts`): case, whole word, regex (`$1`;
  plain replacements literal). Folding (`src/lib/editor-folding.ts`): the
  textarea shows a projection without folded lines, edits map back using the
  caret; tested for every keystroke position. Mesh/Results show a label only,
  answer in the conversation's language (English when empty), checked live in
  both languages. The main tab bar overflowed below ~1070 px and a focus slid
  the clipped root sideways; under 1120 px the tabs now show icons only.

## 2026-11-05 — Agent tables, ParaView legend, editor layer (in brief)

- Agent panels render GitHub tables (`src/lib/markdown-table.ts`). ParaView
  ends `apply_display` in `HideUnusedScalarBars`. The File Editor's layer
  behind the textarea (`editor-highlight-layer.tsx`, `editor-highlight.ts`)
  draws comments and indent guides; colours in the FOAMy store.

## 2026-11-05 — Agent: Mesh and Results analysis buttons, streaming digests (in brief)

- **Mesh**/**Results** send a prepared request (`src/lib/agent-analysis.ts`)
  using `analyze_log`, `read_log_excerpt`, `analyze_fields`,
  `postprocess_summary`, `mesh_summary`: bash+awk in `case-digest.ts` streams
  logs, fields (root and processors) and polyMesh headers in WSL, run async by
  `case-analysis.ts`. POSIX awk, no `sqrt` (busybox). `read_case_file` caps at
  256 KB. Tested under gawk, mawk and busybox.

## 2026-10-20 — v5.8.2: containers open closed; OpenFOAM search in /home (in brief)

- Containers start closed; the installation scan also globs `/home/*` and
  `/root`; OpenFOAM settings → **Search folders** (`validateFoamSearchFolder`,
  saved per distro in `~/.wslgui-foam-search.json`). Notes in
  `docs/releases/v5.8.2.md`.

## 2026-10-07 — v5.8.1: Monitor residual plot opens on the solver log

- Released `v5.8.1` at the user's request (notes `docs/releases/v5.8.1.md`): the
  pair built for `7650ff6`, renamed without rebuilding (embedded 5.8.0). GitHub
  keeps v5.8.1 and v5.8.0; the v5.7.0 release entry was removed, tag kept.
- Monitor already had the Post-Process residual correction: on `cavity_test`
  (v14) all 10,000 Initial and 10,000 Final values match `log.foamRun`.
- Fixed beside it: Show Chart with no log chosen took the first log, usually
  `blockMesh`, and said "No residuals found"; it now takes the first log with
  residuals, and Refresh re-reads the plotted log. Two unused pre-correction
  parsers removed; the log selects no longer say `foamRun (v13)`.

## 2026-10-06 — v5.8.0: containers, folders of the run directory that group cases

- Released `v5.8.0` at the user's request (notes `docs/releases/v5.8.0.md`): the
  pair built for `92f383c`, renamed without rebuilding (embedded 5.7.0). GitHub
  keeps v5.8.0 and v5.7.0; the v5.6.2 release entry was removed, tag kept.
- At the user's request, marked explicitly (no detection): the app writes
  `.ofstudio-container` into the folder. One level; run-folder cases unchanged.
- A case is addressed by a reference, `case` or `container/case`
  (`src/lib/case-name.ts`). `validateCaseName` accepts both; `getCasePath`
  checks the disk — the first segment must be a container, a single name must
  not be one (so "delete case" cannot take a container), with a 15 s cache and
  a fresh check on create, clone, move, delete.
- Dashboard: tree list, Container button, a location select on create, clone,
  tutorial copy and rename (which moves), container rename and delete (empty
  only). An existing folder becomes a container unless it is a case with files
  of its own (its 0/, system/, constant/ would be listed as cases); the folders
  it holds become its cases, after a confirmation that names them. A case moves
  between containers and the run folder by its Move button or by dragging.
- Checked in the packaged window on `ui_grp_test`: create, copy a tutorial in,
  edit, blockMesh, solver, mesh, residuals, ParaView, move, delete. Not checked:
  agents on a nested case, a real mouse drag. Known: `b` also matches `x/b`.

## 2026-10-04 — v5.7.0: WSL injection closed, Electron 44, Node 22

- Released `v5.7.0` (notes `docs/releases/v5.7.0.md`): the pair built for
  `4142eb6`, renamed without rebuilding (embedded 5.6.2); v5.6.1 entry removed.

## 2026-10-04 — External review: WSL command injection closed, Host check

- A remote code review (no app run) listed six findings; verified here on the
  app. **Injection confirmed**: `wsl -- bash -c` hands the line to the distro's
  default shell inside double quotes first, so `$(…)`, backticks and `$NAME`
  were expanded even inside shellQuote()'s single quotes. Writing
  `probe_$(id -u).txt` through `/api/cases` created `probe_1000.txt`; the
  guarded agent's `write_case_file` took the same path.
- Fix at the root: every bash spawn in `src/lib/wsl.ts` (7) builds its arguments
  with `wslBashArgs` (`wsl --exec`), which parses the command once. Paths with
  `# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

, backticks or `"` now read, write, list and delete literally; inline
  `$VAR` works. Validators unchanged. Checked in dev: file operations,
  foreground and background commands, logs, validateBC.
- `src/proxy.ts` also refuses any `Host` that is not 127.0.0.1/localhost (DNS
  rebinding); all callers use those. `evil.example` gets 403, the app 200.
- Residual axis decades come from `Number('1e-4')`, not `Math.pow` (inexact on
  some V8); one Windows-path ParaView test skips off Windows. The three
  failures were Linux/Node 22 only: on Windows all tests passed before too.
- `next` and `eslint-config-next` 16.3.3 → 16.3.8 through npm (GHSA-vcvr-r3jv-pc5j;
  `next/og` is unused). `npm run check`: 363 pass, 2 skipped.
- Bundled Node 20.20.2 → 22.23.3 at the user's request (checksum pinned; a
  node.exe of another version is now replaced). Packaged pass as above.
- Electron 31.7.7 → 44.5.1 (Chromium 152); breaking changes 32–44 checked against
  `main.js`/`preload.js`, none applied. Same pass plus hardware WebGL (D3D11),
  preload and safeStorage decryption. Exe 90 → 121 MB. Not checked: native
  focus freeze, agents. No CI; `wsl.ts` 4,7k lines; sync WSL calls block.
- The user found Claude slower: each new conversation (or model/effort/mode/case
  change) waited ~2.4 s more on Electron 42-44 than 31, outside the app; the
  inline 7 KB `--append-system-prompt` stalled claude.exe's start. It is now a
  file (`systemPromptArgs`): first reply ready in ~1 s, packaged, via Explorer.

## 2026-10-03 — v5.6.2: residuals, chart controls and ParaView editing

- Released `v5.6.2` (notes `docs/releases/v5.6.2.md`); phases 1–4 stay reverted.
  Pair from `7d23f73` renamed without rebuilding (embedded 5.6.1); v5.6.0 removed.

## 2026-10-03 — Visible dropdowns and freely editable ParaView numbers

- Select popups now sit above the dialog/overlay (1100 versus 1000). The export
  size menu had opened underneath them; previous accessibility-only checks
  missed the covered menu. Verify visible options and real mouse clicks.
- ParaView scalar, XYZ and video fields keep text drafts, including empty,
  sign and incomplete exponent; blur/Enter confirms, Escape cancels. Select
  the full value on focus. Validate finite numbers, bounds and integer counts
  before committing; preserve legitimate zero values when loading properties.
- Checks: 4 focused tests, typecheck/lint, popup hit testing and mouse selection,
  complete deletion/replacement and worker Apply/reselection pass. Video edits
  also preserve empty drafts. Case data read only; test pipeline was in memory.

## 2026-10-03 — Chart tooltip names and custom export dimensions

- Post-Process tooltip uses the series name supplied by Recharts; treating it
  as a column key had renamed p and k to Time.
- Export size represents manual dimensions as Custom, with all presets still
  available after dragging the corner or editing width/height.
  Standard restores 1600 × 900 after any manual deformation.
- Tooltip labels and programmatic preset selection passed; the later mouse
  check found the dropdown was covered by the dialog, as recorded above.

## 2026-10-03 — Correct initial/final solver residuals

- At the user's request, add Initial/Final choices to Monitor and Post-Process,
  without maximum. Initial is the first solve's Initial residual; Final is the
  last solve's Final residual, independently per field/timestep. CSV and chart
  exports use the selected kind; missing values stay gaps, including legacy
  logs without a labelled final residual. Later timestep blocks replace old rows.
- Real `myCavity/log.foamRun` revealed last-initial overwrites: pressure at
  t=0.005 incorrectly showed 0.0371368; initial is 1 and final is 6.05335e-7.
  Keep the rollback's File Editor indicators and prepared ParaView startup.
- Checks: 18 residual tests pass; 20,000 initial/final values match the existing
  myCavity log independently. UI confirms both choices, final table/chart,
  Monitor curves and export labels; no case files were changed.

## 2026-10-03 — Restore the pre-phase-1 application

- At the user's request, restore the application to `c7c8c3c`, before phase 1.
  Remove phases 1–4, including Post-Process fixes, numerical views, saved
  analyses/workspaces and advanced analysis. Earlier commits remain in Git.
- Retain only File Editor indexing indicators from `58c3dfc`: initial listing
  and manual refresh animate; background updates and lazy folders stay quiet.
- Retain prepared ParaView engine reuse from `9b6b445`, with warm-up cancellation
  and normal-priority case activation. Test it against the original 3D workbench.
- Archive session-only saved analysis test documents in the ignored agent log;
  preserve unrelated local files and existing cases.
- Checks: typecheck/lint, 348 passing tests (2 opt-in skips), and native ParaView
  6.2 case activation, rendering, cancellation and recovery pass.

## 2026-09-13 — v5.6.1: finished agent answers use the provider's canonical result

- Released `v5.6.1`; notes: `docs/releases/v5.6.1.md`. Direct publication reused
  the pair built from `03a4a83`, renamed without rebuilding; embedded version
  5.6.0. Retention kept v5.6.1/v5.6.0 and removed v5.5.0's release, keeping its tag.
- Completed turns use `done.text`: Claude supplies its canonical result, and
  Codex retains its last completed public agent message. This replaces repeated
  cumulative previews while preserving tool/reasoning cards. Regression tests
  and packaged-server checks confirmed non-empty final results from both agents.
- Stable semantic transcript keys and synchronous terminal replacement fix the
  stale rendering that previously required closing and reopening the panel.
  Earlier preview inference attempts and diagnostic detail remain in Git.

## 2026-09-13 — v5.6.0: long videos confirmed with a measured time; Feature Edges

- Released `v5.6.0` at the user's request with notes in
  `docs/releases/v5.6.0.md`, covering this entry and the video export below.
  Direct publication reused the pair built from commit `55aba4a`, renamed
  without a second build, so its embedded version resource reads 5.5.0.
  GitHub keeps v5.6.0 and v5.5.0; the v5.4.1 release entry was removed, its
  tag kept.
- At the user's request the 18,000-frame cap became a confirmation: only a
  video longer than one hour is refused (`MAX_VIDEO_SECONDS`, a guard against
  an obvious mistake such as a factor of 1000); above 10 minutes of video or
  30 minutes of estimated rendering the Video tab asks first, with the
  duration, the frame count and the render time. Progress also shows the time
  left.
- The render time is measured on the case: the worker renders and encodes
  three frame triples to distinguish rendering, interpolation and step reads.
  Cavity 1080p/4K estimates were 21.5/23.1/18.5 s versus 16.6/19.9/14.9 s actual.
  A 28,501-frame request showed confirmation instead of refusal. Details in Git.
- **Feature Edges** is offered as a display representation, as in ParaView
  using each item's `representations_for` list for display controls and timeline
  snapshots. Verified on v14/ParaView 6.2.0; unsupported Volume refused.
  344 tests, typecheck and lint passed. Evidence: v5.6.0 notes and Git history.

## 2026-09-12 — ParaView: video export with a timeline of views (in brief)

- Video tab: views added "until" a saved time step, cut or smooth camera moves,
  pace per step or per simulated second, optional TemporalInterpolator,
  480p–4K, fixed or per-frame colour range. The plan is pure and tested
  (`src/lib/paraview-video.ts`); the session pvpython renders it (MP4 through
  Media Foundation, OGV fallback), refuses other commands while exporting and
  restores the view after. The legend left behind on recolouring, found then,
  is fixed on 2026-11-05.

## 2026-09-12 — v5.5.0: File Editor fits the window; preflight beside Clean TS (in brief)

- Released `v5.5.0` (notes `docs/releases/v5.5.0.md`; artifacts of `f956e95`
  renamed, embedded 5.4.1). The File Editor fills its tab and the tree and file
  scroll on their own; the preflight starts from a box beside Clean TS and its
  results open in a capped section below (Hide, Show, Close, Run again). Below
  440 px the inputs fold behind a + button. Details in Git.

## 2026-09-12 — larger initial workspaces and wizard-marker exclusion

- The desktop window now opens at up to 1600×1000, bounded by the monitor's
  usable work area, with 1200×900 minimums where the display permits. This
  exposes the complete File Editor surface in the normal initial view.
- Commands gives the terminal all space left above Quick Commands by default;
  dragging the existing handle still sets a manual height and double-clicking
  it restores automatic fitting.
- Case preflight prunes `system/studioWizard.json` from both its bounded file
  inventory and the reported total. It remains wizard metadata, not an
  OpenFOAM dictionary to validate.

## 2026-09-12 — installation-aware case preflight in File Editor

- File Editor now has a full-width Case preflight panel below its tree and
  editor. It expands after a run into category summaries and separate errors,
  warnings and explicitly unverified findings, with explanations, suggested
  actions and direct links to existing files.
- The preflight reads bounded case configuration and initial fields, checks
  core structure, run controls, decomposition and field/mesh patch agreement,
  and uses the selected Foundation OpenFOAM 9–14 installation's own
  `foamDictionary`, executable catalogue and runtime-selection index.
- It never clones a case, starts a solver/mesher/`checkMesh`, loads case code or
  runs `#codeStream`/`#calc`. Parser inputs use a private hidden `/tmp` tree,
  removed on exit, with per-file and whole-pass time bounds; uncertainty is
  reported as unverified instead of being promoted to a blocking error.
- Unsaved editor content blocks the run so the displayed report always matches
  disk. Six focused tests cover direct contradictions and conservative
  downgrades; the full suite, typecheck and lint pass.

## 2026-09-11 — v5.4.1: decomposed cleanup and cumulative agent replies

- Released `v5.4.1` at the user's request with notes in
  `docs/releases/v5.4.1.md`. Direct publication reused the paired artifacts
  built from commit `8c53f18`, renaming them without a second build; therefore
  source-to-artifact equivalence belongs to that pre-version build rather than
  to the version-metadata commit.
- File Editor's Clean TS now reads the same root-plus-`processor*` timestep
  inventory as Monitor instead of inferring it from the visible top-level tree.
  It keeps the initial time, refuses deletion while the case runs, reports
  backend failures and refreshes the tree after a successful cleanup.
- The shared Claude/Codex transcript recognises cumulative snapshots even when
  the provider changes block ID. Adjacent snapshots collapse to the newest;
  around tools, only each new suffix is rendered, preserving event order.
- Both Guarded and No limits prompts keep their paragraph boundaries and are
  provider-neutral. Codex's durable `run_openfoam` description now explains
  both modes without becoming stale after a mode switch; enforcement remains
  server-side. Regression tests cover both snapshot forms and the mode contract.

## 2026-09-11 — v5.4.0: complete case creation and guided surface meshing

- Released `v5.4.0` at the user's request; notes in
  `docs/releases/v5.4.0.md`. Its centrepiece is the complete v13/v14 New Case
  guide and its safe STL/OBJ → `surfaceFeatures` → `snappyHexMesh` workflow,
  together with hash-aware case updates and the wizard/agent fixes below.
- Direct publication reused the paired v5.3.1 artifacts built from commit
  `6d264fa`, renaming them for v5.4.0 without rebuilding; source-to-artifact
  equivalence therefore belongs to that pre-version build, not the version
  metadata commit.

## 2026-09-11 — Wizard lifecycle and agent transcript fixes

- New Case now reconciles the case it remembers with every refreshed case
  list. Deleting or renaming that case from the Dashboard clears its result,
  update target, name and settings instead of leaving a ghost case in the
  still-mounted wizard. The Case name label and input have enough separation
  for the orange focus ring not to cover the label.
- Claude and Codex text, reasoning and tool events now carry their provider
  block IDs into one shared transcript reducer. Replayed authoritative
  snapshots update the original block, while equal text from genuinely
  different blocks stays separate. Four regression tests cover streamed
  replacement, replayed text/tools, equal distinct blocks and legacy events.

## 2026-09-11 — New Case wizard: the complete guide for OpenFOAM 13 and 14

- The detected installation picks the guide (`src/lib/wizard/modules.ts`):
  every solver module on 13/14 (guided forms for ten modules, the others
  seeded from the installation's tutorials and re-targeted onto the wizard's
  patches, `src/lib/wizard/seed.ts`), a shorter guide on 9–12, none otherwise.
  The Mesh step follows a real workflow (geometry, surfaceFeatures, background
  blockMesh, snappyHexMesh) with named box patches and roles.
- Verified in WSL on v13 and v14 (16 guided variants, tutorial-seeded cases, an
  internal snappy mesh) and in the dev server; details in Git (`7ace17d`) and
  `docs/releases/v5.4.0.md`. Limits: isothermalFilm's `filmWall` patch,
  engine/kivaTest/stored-phi tutorials, tutorial zone coordinates.

## 2026-09-10 — New Case wizard: "Update case" and guided snappyHexMesh

- **Update case**: a wizard case carries `system/studioWizard.json` (settings
  plus the SHA-256 of every file written); "Review the update" compares
  recorded, on-disk and new hashes (`src/lib/wizard-state.ts`), never rewrites
  a file edited outside the wizard without asking, and only proposes
  re-meshing.
- **Guided snappyHexMesh** (13/14, when the .cfg files exist): STL/OBJ read in
  the browser, uploaded by `/api/cases/[name]/geometry` (100 MB, realpath
  checked), dictionaries that `#includeEtc` the .cfg. `proxyClientMaxBodySize`
  is 101 MB because proxy.ts truncated bodies past 10 MB. `listCasesBatch` now
  uses the base64 runner. Verified on motorBike (v14 and v13); details in Git.

## 2026-09-10 — v5.3.1: safer case workflows, Post-Process and ParaView

- Released `v5.3.1` at the user's request; notes in
  `docs/releases/v5.3.1.md`. It collects the case, tutorial, editor and mesh
  reliability work plus the Post-Process and ParaView improvements below.
- Direct publication reused the already built and hash-verified v5.3.0 pair
  from commit `89211cb`, renaming it to the v5.3.1 artifact names without a new
  build or source-to-artifact verification. Its embedded Windows version
  resource therefore still reads 5.3.0.

## 2026-09-10 — Post-Process data integrity; ParaView cancellation (in brief)

- Post-Process CSV exports the full parsed table (200,000 rows / 8 MB caps,
  stated when hit) as real CSV; profiles keep 20,000 time names and read the
  latest 200 files; symlinks must stay under `postProcessing`; superseded WSL
  answers are ignored and listing failures reported.
- ParaView startup is cancellable by generation ticket; pipeline and controls
  are keyboard-reachable with accessible names. 220 tests passed then.

## 2026-09-10 — Mesh tab, case lifecycle, honest states (in brief; details in Git)

- BC checks without `polyMesh/boundary` say so (`meshChecked: false`);
  checkMesh is parsed by `src/lib/check-mesh.ts`; `/api/mesh` answers 409 above
  an estimated 500,000 triangles. `deleteAllTimesteps` spares 0 and the earliest
  time; clone/rename/create refuse existing names and remove half-made copies;
  File Editor remounts ask about unsaved edits; unused `CASE_TEMPLATES` gone.

## 2026-09-10 — Runnable wizard cases, tutorial listing, data-loss guards (in brief)

- The wizard lists only incompressibleFluid (11+) and simple/pimple/piso/icoFoam
  (<=10), always with `wallDist { method meshWave; }`. Tutorials are listed at
  any depth (`listTutorialCases`); `copyTutorial` is atomic. "New file" on an
  existing name asks first. Details in Git.
- Still open: per-process Kill unconfirmed (declined); Undo reverts all edits
  without asking; the v11 reading of `nu 1e-05 [m^2/s]` is unverified.

## 2026-09-10 — v5.3.0: Post-Process audit and a warm ParaView start (in brief)

Released `v5.3.0` (`docs/releases/v5.3.0.md`): catalogue audited against
v14/v13 (`89211cb`); ParaView warms up 5 s after detection (cold 107 s, warm <2 s).

## 2026-09-08 – 09-09 in brief

Details are in `docs/releases/v5.0.0.md` through `v5.2.2.md` and in Git. This
period introduced Post-Process; installation-aware agent/command/help data;
the persistent theme; ParaView discovery, startup phases and recovery; honest
residual and Post-Process charts; and synchronized case-switcher chips.

It also records the `<openfoam-studio>` control notices and guarded
detached-run semantics. The temporary detach button was reverted and must not
be restored. The packaged standalone still carries the unused `tests/` folder.

## Earlier history

- Release notes from v1.0.0 on are in `docs/releases/`; the 2026 review is
  `docs/audit-2026-09-03.md`. Git history is the authoritative chronology.

## Stable project context

- OpenFOAM Studio is an Electron shell around a Next standalone server. The
  operational chain is `Electron renderer -> Next server -> wsl.exe -> OpenFOAM`.
- It targets Windows 10/11 with WSL2 and OpenFOAM Foundation v9-v14. OpenFOAM
  is not bundled; ParaView is an optional Windows-side integration.
- FOAMy proposes edits for user approval. Claude and Codex are separate
  subscription-backed in-app agents sharing the same OpenFOAM authority layer.
- The ignored `docs/agent-log/` directory is reserved for progress notes from
  user-authorized subagents.
