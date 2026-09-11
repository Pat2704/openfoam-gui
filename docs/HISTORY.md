# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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

- **The installation picks the guide; the user does not.** `guideForVersion`
  (`src/lib/wizard/modules.ts`): 13 and 14 get the complete guide, 11–12 the
  shorter modular one (incompressibleFluid), 9–10 the shorter legacy one
  (simpleFoam, pimpleFoam, pisoFoam, icoFoam), an unknown version none (Next
  disabled). The layout toggle is gone; `foam-version-changed` switches the
  guide, and Update case refuses a record made under another guide.
- **Every solver module of the installation**, as the user chose (forms per
  module plus tutorials). Guided forms: incompressibleFluid, isothermalFluid,
  fluid, shockFluid, multicomponentFluid, incompressibleVoF, compressibleVoF,
  incompressibleDriftFlux, solid, solidDisplacement. The rest (multiphaseEuler,
  XiFluid, the two multiphase VoF modules, incompressibleDenseParticleFluid,
  isothermalFilm, film, movingMesh, functions) start from one of the
  installation's tutorials of that module (`src/lib/wizard/seed.ts`): physics
  dictionaries kept and editable, mesh dictionaries dropped, every 0/ field
  re-targeted onto the wizard's patches by role; a physics file still naming a
  tutorial patch is flagged until edited. Modules, RAS/LES models, thermo
  combinations per table and function objects come from foamToC
  (`/api/foam-index?action=wizardCatalog`).
- Physics: steady or transient (adjustTimeStep, maxCo, maxAlphaCo),
  laminar/RAS/LES, thermophysics with presets, species, phases, drift, gravity
  and p_rgh, solid and elastic properties, initial regions by setFields (box,
  sphere, cylinder). Per-patch values (velocity, pressure, temperature, heat
  flux, convection, traction) sit in the Fields step and drive the conditions
  (`src/lib/wizard/boundary.ts`). Also system/functions (#includeFunc),
  decomposeParDict (scotch) and fvConstraints limitPressure. Files use forms
  both 13 and 14 accept, taken from the subagent survey
  (`docs/agent-log/module-spec.md`, ignored), and version-specific ones only
  where they differ (LES `<x>Coeffs` vs `<x>`, driftFlux and plastic sub-dicts,
  combustion vs reaction properties).
- **The Mesh step follows a real workflow.** Box only: domain → cells and
  grading → patches (each face given to a named patch with a role; presets) →
  blockMeshDict. With geometry (13/14): geometry (units, flow inside or around
  it, surface role) → surfaceFeatures → background box and its patches →
  refinement (surface levels, regions as their own patches, box/sphere/cylinder
  regions) → insidePoint → snapping → layers → mesh quality → review. Commands
  run in that order: surfaceTransformPoints for non-metre units, surfaceFeatures
  (only with a feature level), blockMesh, snappyHexMesh, checkMesh, then
  setFields. A .cfg default is shown and written only when changed. Record
  format 2; format-1 records migrate.
- Fixed on the way: ASCII STL solids named `patchN` were lost as regions; a
  symmetry patch over several faces was written as symmetryPlane ("is not
  planar") — the role now writes `symmetry` and a multi-face symmetryPlane is
  refused; an extra condition entry opening a sub-dictionary
  (`contactAngleProperties`) got a stray `;`; the summary's installation check
  called `heRhoThermo` missing (foamToC lists whole combinations; words inside
  templated names now count) and re-ran on every render (177 requests in one
  visit; the file lists are memoised, and tutorial files copied unchanged are
  not checked).
- Verified: typecheck, lint, 317 tests (the usual skip). In WSL, 16 guided
  variants (every form module; laminar, RAS, LES; buoyant; heat-flux and
  convective walls; setFields; 2D and 3D) ran foamRun on v14 and v13. Five
  tutorial-seeded cases with renamed patches ran on v14 (bubbleColumnLaminar,
  damBreak4phaseLaminar in both VoF modules, column after the flagged
  cloudProperties edit, XiFluid 1Dlaminar) and four on v13, which has no
  1Dlaminar. An internal snappy flange meshed (46,581 cells, its regions in
  inlet and outlet groups) and ran on v14. In the dev server on v14 the wizard
  showed the complete guide, the 19 modules and the fluid forms; `wizard_test`
  was created, meshed from the wizard (checkMesh OK, 1200 cells) and foamRun
  ended by itself at iteration 299; an unchanged review found nothing to
  write, and the record is format 2. For multiphaseEuler the forms choice is
  disabled and the tutorial list offers the module's 29 tutorials;
  bubbleColumnLaminar on the wizard's box reached a clean summary (22 files).
  Disposable cases were removed. The Electron build passed and the v5.3.1
  portable executable and folder ZIP in `Working/` were replaced with the new
  build (SHA-256 of each copy checked against `dist-electron/`).
- Limits: isothermalFilm needs the `filmWall` patch type, which the box does
  not write; engine, kivaTest and stored-phi tutorials cannot be re-targeted; a
  tutorial's zones keep its coordinates; a hand-edited phaseProperties can
  still raise a false alarm, because phase systems are in no foamToC table.

## 2026-09-10 — New Case wizard: "Update case" and guided snappyHexMesh

- **Update case.** A case the wizard creates carries `system/studioWizard.json`
  with the settings and the SHA-256 of every file written. The user decided:
  a file in the case (it follows rename and clone, and a clone stays
  updatable), and an update only *proposes* re-meshing. The case reopens from
  the Dashboard's wand button (shown only on cases with the record), from the
  wizard's first step, or straight after Create, where the wizard now stays.
  "Review the update" compares recorded, on-disk and new hashes
  (`planUpdate`/`resolvePlan`, `src/lib/wizard-state.ts`). Untouched files are
  rewritten and obsolete ones removed. A file edited, deleted or already
  present outside the wizard is listed with Compare and "keep" preselected. A
  kept file keeps its old recorded hash, so the next update asks again. A
  changed mesh input marks the mesh stale and offers the mesh steps.
- **Guided snappyHexMesh, 13 and 14 only.** An explicit Mesh-step option (the
  default stays blockMesh only), offered when `foamEtcFile` finds the
  snappyHexMeshDict, surfaceFeaturesDict and meshQualityDict .cfg files
  (`/api/wsl?action=snappySupport`); otherwise it is disabled with "Available
  on OpenFOAM 13 and 14 only; …". STL (ASCII or binary) or OBJ, optionally .gz,
  is read in the browser (`src/lib/geometry.ts`: bounding box, regions, a
  three-ray parity test for insidePoint) and uploaded unchanged to
  `constant/geometry` by a new binary route (`/api/cases/[name]/geometry`:
  100 MB, shared validators, realpath check against symlink escape, SHA-256
  compared). The dictionaries (`src/lib/snappy-templates.ts`) `#includeEtc`
  the .cfg and write only the user's choices: levels, feature level,
  refinement box, `insidePoint`, layers on/off. `system/meshQualityDict` is
  written because the snappy .cfg includes it from the case. Each surface's
  patches get `inGroups (<name>Group)`, and 0/ carries one wall entry for the
  group. Box, insidePoint and refinement box are proposed from the bounding
  box. On request the wizard runs blockMesh → surfaceFeatures → snappyHexMesh →
  checkMesh (streamed, `log.<app>` kept) and opens the Mesh tab, which then
  loads without a click.
- `proxyClientMaxBodySize` is 101 MB: proxy.ts buffers every /api body and
  silently truncates it past 10 MB. The upload route also checks
  Content-Length.
- Fixed in passing: `listCasesBatch` ran its variable-bearing script inline
  through `wsl.exe` and printed no case line, so the Dashboard always showed the
  bare fallback (no file counts, time steps or logs). It now uses the base64
  runner. The wizard also re-reads version, BC list and snappy support on
  `foam-version-changed`.
- Verified: 266 tests (45 new; one pre-existing skip), typecheck, lint. On v14,
  `snappy_test` was created in the dev server with motorBike.obj.gz (331,653
  triangles, 67 regions). Its mesh run gave 64,792 cells; checkMesh reported
  "Failed 1 mesh checks" (3 faces, skewness 10.3), shown as a warning. BC
  validation resolved the 66 body patches through motorBikeGroup, the Mesh tab
  loaded 33,590 triangles and 69 patches, and foamRun ran 3 iterations.
  Updates were checked in the same case. endTime rewrote only controlDict. A
  hand edit to controlDict was a conflict: "keep" left it alone and the next
  review asked again, and "use the wizard's" replaced it. kEpsilon plus level 4
  created epsilon, removed omega, rewrote momentumTransport and
  snappyHexMeshDict, and marked the mesh stale. A clone carried the record. The
  same dictionaries meshed on v13 (64,792 cells; 6 faces with skewness 4.6).
  The "not available" message was checked by answering snappySupport as v12
  in the page. All disposable cases were removed.
- Pre-existing, left alone: switching kOmegaSST to kEpsilon keeps 0/omega in
  the wizard's field list; the clone route answers `caseName: "OK: cloned"`.

## 2026-09-10 — v5.3.1: safer case workflows, Post-Process and ParaView

- Released `v5.3.1` at the user's request; notes in
  `docs/releases/v5.3.1.md`. It collects the case, tutorial, editor and mesh
  reliability work plus the Post-Process and ParaView improvements below.
- Direct publication reused the already built and hash-verified v5.3.0 pair
  from commit `89211cb`, renaming it to the v5.3.1 artifact names without a new
  build or source-to-artifact verification. Its embedded Windows version
  resource therefore still reads 5.3.0.

## 2026-09-10 — Post-Process data integrity; ParaView cancellation and access

- Post-Process CSV now fetches the complete parsed table (up to the existing
  200,000-row/8 MB safety ceilings) instead of copying the 4,000-point chart
  sample, and quotes commas, quotes and line breaks as real CSV. Any remaining
  limit is stated in the toast rather than presented as a complete export.
- Sampled profiles retain up to 20,000 time names and directly load the chosen
  snapshot; the initial view reads the latest 200 files instead of the first
  200. A time-series with more than 200 restart files and a longer time list
  are explicitly marked as limited. Dataset and file symlinks are resolved and
  accepted only when their targets remain under the case's postProcessing tree.
- Post-Process now reports a failed dataset/log listing, serializes WSL reads,
  ignores superseded dataset, catalogue, context and class-reference answers,
  and clears installation-owned state when the OpenFOAM selection changes.
- ParaView startup has cancellable generation tickets. Cancel invalidates an
  in-progress discovery and queued starts, cleans temporary state, immediately
  leaves the loading screen and ignores late state/images. Camera and
  manipulator requests use the same timeout as other workbench operations.
- ParaView's pipeline can be selected by keyboard; icon-only workbench and
  timestep controls and all range inputs now expose accessible names.
- Typecheck, full lint and 220 tests pass (one pre-existing external Codex test
  skipped). A read-only call on the WSL `test` case confirmed the empty
  Post-Process state; the disposable 205-time/symlink WSL integration also
  passed and removed its temporary data. The Electron build passed and the
  v5.3.0 portable executable and folder ZIP were replaced with hash-verified
  artifacts.

## 2026-09-10 — Mesh tab: honest BC check, checkMesh report, viewer on large meshes

From the Mesh audit (`docs/agent-log/mesh-audit.md`, ignored):

- Boundary-condition validation with no `constant/polyMesh/boundary` (before
  blockMesh, or processor-only) now says the patches were not checked
  (`meshChecked: false`, a warning and a neutral toast) instead of "All BCs are
  valid". `parsePolyMeshBoundary` accepts any OpenFOAM word as a patch name, so
  snappyHexMesh names such as `motorBike_frt-fairing:001%1` and their groups
  are no longer lost.
- checkMesh is read by `parseCheckMeshOutput` (`src/lib/check-mesh.ts`) using
  the markers the v13/v14 sources print (" ***" failures, "  *" warnings, the
  "Mesh stats" block, the bounding box) and the LAST verdict; the old parser
  matched none of them. It runs through the script runner with its exit status
  captured, so a run that stopped before judging shows "checkMesh could not
  run" with the reason instead of "Mesh issues detected".
- The marker scripts behind the viewer and `paraFoam -touch` exit 0, so "no
  mesh yet — run blockMesh first" reaches the user instead of the wsl command
  line. Surface extraction is asynchronous (the synchronous call froze every
  other request for up to 120 s), and `/api/mesh` answers 409 with an estimate
  from the boundary file's `nFaces` when the surface would exceed 500,000
  triangles, so the viewer asks before extracting rather than after.
- The STL is still read as one string; streaming it is left for later.
- Verified through the real API: on `test` checkMesh now returns its
  statistics (5616 points, 3875 cells…) and "Mesh OK.", BC validation
  `meshChecked: true`, and the viewer 6300 triangles in about 2 s. On a
  disposable case without a mesh (since removed) the viewer says to run
  blockMesh, checkMesh reports that it could not run with "cannot find file
  …/system/controlDict" as the reason, and BC validation says the patches were
  not checked. A fake boundary of 400,000 wall faces plus a processor patch
  gave a 409 estimating 800,000 triangles. 219 tests, lint and typecheck pass.

## 2026-09-10 — Case lifecycle: timesteps, clone, rename, create, unsaved edits

From the case-lifecycle audit (`docs/agent-log/cases-audit.md`, ignored):

- `deleteAllTimesteps` spares 0 and the earliest time (kivaTest starts at -180
  and has no 0/; its initial conditions used to go), cleans `processor*/<time>`
  by the same rule, and reports a failure instead of "Deleted 0 timesteps".
  The File Editor and Monitor prompts say "all except the initial time".
- `cloneCase` makes the folder with plain `mkdir` and checks every `cp`,
  removing a half-made clone; `renameCase` and `cloneCase` write refusals to
  stderr, so the user reads "a case with this name already exists" instead of
  the raw `wsl … base64` command line.
- `createCase` refuses an existing name unless the caller passes
  `allowExisting` (the wizard, after its Overwrite confirmation, sends
  `overwrite`); the Dashboard checks its list first and its rollback removes
  only the optimistic row. Clone and Rename ignore Enter while in flight.
- Unsaved edits: the File Editor publishes its unsaved file through
  `case-context` (`unsavedFile`), and every route that remounts it — selecting
  another case, a switcher chip, closing the active chip, renaming the open
  case — asks first.
- Verified through the real API on disposable cases (since removed): on a
  case with -180/-170/-160 and processor0/-180/-170, exactly -160, -170 and
  processor0/-170 went; create, clone and rename onto an existing name gave
  readable refusals; a normal clone carried 0/, system/ and constant/. Lint,
  typecheck and 214 tests pass. In the dev server, with an unsaved edit to
  `test` 0/U, clicking the `cavity_test` chip asked "Unsaved changes"; Cancel
  kept `test` open with the buffer intact, and 0/U on disk was untouched.

## 2026-09-10 — Honest states and dead code (in brief; details in Git)

- Failures no longer read as normal states: the file browser, Commands list,
  Monitor residuals and log, File Editor Undo, folder creation and batch delete
  ("Deleted N of M") each say what failed. The wizard's name rule blocks Next
  on the first step, and "Everything checks out" waits for the installation
  check. File Editor "Clean TS" refuses while a process of the case runs
  (`src/lib/case-processes.ts`). Tutorials follow an installation or distro
  change.
- `CASE_TEMPLATES`, `FILE_TEMPLATES` and `STANDALONE_FILE_TEMPLATES` were
  deleted from `src/lib/openfoam-data.ts` (unused, 1378 lines); clipboard
  refusals are reported instead of a success toast.

## 2026-09-10 — Wizard writes only runnable cases; accessibility pass

- From the OpenFOAM audit (Foundation sources and the v13/v14 tutorials,
  read-only): the wizard lists only incompressibleFluid (11+) and simpleFoam,
  pimpleFoam, pisoFoam and icoFoam (<=10), with a pointer to the tutorials. It
  wrote U, a kinematic p and a nu-only properties file for 13 other solvers
  that need T and a thermoType, alpha fields and phaseProperties, or D; it also
  listed sonicFoam (absent on 9-10) and buoyantSimpleFoam (gone on 10).
- fvSchemes always carries `wallDist { method meshWave; }`: kOmegaSST and
  Spalart-Allmaras stop without it on 13/14 (v9-v12 not checked). Legacy
  icoFoam and pisoFoam get a PISO dictionary; icoFoam on v10 gets
  physicalProperties (from its source; no v10 install here). Spalart-Allmaras
  walls get nutUSpaldingWallFunction, because nutkWallFunction leaves nut at 0
  when k is zero; changing the model swaps only the wizard's own default.
- Commands: on <=10 the two run quick commands use `application` from the
  case's controlDict and are hidden if it cannot be read; an unknown version
  keeps foamRun. The legacy path cannot be exercised here.
- Accessibility: file-tree hover-only actions appear on keyboard focus; the
  File Editor's icon-only buttons and selection boxes, the Commands Send
  button and the wizard's remove-condition button have accessible names.
- Verified with 7 new unit tests in `tests/case-templates.test.ts` (211 in
  all, none failing) and in the dev server on v14: the wizard's solver step
  lists incompressibleFluid with the tutorial pointer; switching k-epsilon to
  Spalart-Allmaras turned nut's wall condition into nutUSpaldingWallFunction
  and left inlet/outlet/empty alone; the quick commands still read foamRun.
- Still open from the audits: per-process Kill has no confirmation (declined
  by the user); Undo reverts all edits without asking; folder creation and
  batch delete fail silently; the Monitor log reads "Loading..." forever when
  empty; wizard name errors surface only at the last step and the summary says
  "Everything checks out" while validation is pending; the v11 reading of
  `nu 1e-05 [m^2/s]` is unverified. (The rest of this list was addressed in
  the entries above.)

## 2026-09-10 — Tutorial listing, File Editor and wizard data-loss guards

- Tutorials are listed at any depth (`listTutorialCases` in `wsl.ts`): a
  folder with `system/` is a tutorial; one with its own `Allrun` and a case
  below it is listed too, flagged "Allrun group", because its cases depend on
  each other; anything else is walked through. On v14 this made the tutorials
  under `mesh/`, `multiRegion/` and `legacy/` reachable (11 group folders → 59
  tutorials) and `resources/` shows as empty. v9-v10 group every category by
  solver, which this also covers; not checked locally (only 13 and 14 exist).
- The Tutorial panel ignores out-of-order answers, clears the old list at
  once, shows an error or an empty-folder message, reveals Copy on keyboard
  focus and proposes the tutorial's own name for the copy. `copyTutorial`
  creates the destination with `mkdir` (atomic) and removes a half-made copy.
  WSL calls run synchronously in the server, so a real concurrent race was not
  reproducible; two simultaneous copies gave one success and one "Case already
  exists".
- File Editor: "New file" on an existing name asks before replacing it with an
  empty file (checked on the `test` case: confirmation shown, 0/U untouched);
  a failed read no longer opens the file empty and marked "Saved" (nor caches
  it); the 0/, system/ and constant/ checkboxes show their state in
  multi-select. The wizard re-reads the case list when Create is pressed.
  Per-process Kill confirmation was proposed and declined by the user.

## 2026-09-10 — Tutorial lists scroll separately; app icon repaired

- Dashboard → Tutorial: the category list and a category's tutorials now
  scroll independently. Before, both cards grew to full length and `main`
  scrolled them together. The grid's height is measured by `tutGridRef` so it
  ends at `main`'s bottom (a `calc(100dvh - 17rem)` guess was 92 px off at
  1366×768 and stays only as first-paint fallback); below `md` the cards stack
  with a height cap. Opening another category starts its list at the top.
  Checked in the dev server at 1366×768 (no page overflow, each list scrolls
  alone), at 900×600 (400 px floor, the page scrolls the short remainder) and
  at 700 px wide.
- `electron/build/icon.ico` has no vector source; the 256 px frame was repaired
  as a raster: the dark dash inside the airfoil near the trailing edge and the
  small barb above that edge were removed, and the lower streamline right of
  the airfoil, which faded out between x≈210 and x≈232, was redrawn as a
  continuous 1.65 px line matching its intact segments. Every smaller frame was
  a LANCZOS downsample of that frame and is regenerated the same way; 20, 40
  and 96 px were added for 125/150/250 % display scaling. Windows may show
  the old icon from its icon cache until that cache refreshes.

## 2026-09-10 — v5.3.0: Post-Process audit and a warm ParaView start

- Released `v5.3.0` at the user's request; notes in `docs/releases/v5.3.0.md`.
  It carries the two entries below: the Post-Process catalogue grounded in the
  installed OpenFOAM, and ParaView loaded in the background at startup.
- Direct publication flow: the `v5.2.2` pair built from commit `9d7719f` and
  verified in the packaged server was renamed to the `v5.3.0` names, not
  rebuilt, so the files' embedded version resource still reads 5.2.2; the app
  shows no version of its own. Retention kept `v5.3.0` and `v5.2.2` as GitHub
  downloads and removed the `v5.2.1` release entry; its tag stays.

## 2026-09-10 — ParaView loads in the background before its tab is opened

- Reported by the user: the first ParaView start takes a very long time.
  Measured again: the tree is 11,070 files and 4 GB, 2,215 of them DLLs and
  Python modules, with Defender real-time scanning on. `from paraview.simple
  import *` took 36.6 s with the cache half evicted and 1.4-1.9 s straight
  after; the 107 s cold figure from 2026-09-09 is the post-reboot case. The cost
  is Windows meeting the files for the first time, not the app or ParaView.
- `warmParaView()` in `src/lib/paraview.ts` runs `pvpython` with the engine's
  own render flags (`PARAVIEW_RENDER_ARGS`, now shared with the worker spawn),
  the same import and one offscreen render, below normal priority, with no
  output and a ten-minute ceiling. The render matters: it is 5 s warm against
  1.4 s for the bare import, and that difference is the rendering stack a bare
  import would have left cold. Once per installation per app process; skipped
  when a session is running or starting.
- The Dashboard starts it 5 s after detection finds ParaView, shows "warming up"
  on the ParaView card while it runs, and the ParaView settings carry the
  switch (`paraview-warmup` in the persisted config; on unless set to `off`)
  with the outcome. A workbench start that overlaps the warm-up says so instead
  of the generic cold-start note.
- It hides the cold load rather than shortening it. The other lever is a
  Defender exclusion for the ParaView folder, which is the user's security
  decision and was only described to them, not made.

## 2026-09-10 — Post-Process: the function catalogue audited against OpenFOAM

Audited against the v14/v13 sources, every installed template and 127 real
replays in `cavity_test` (61 failed before the change). The Compute panel now:

- carries `-solver` when the case and installed utility support it, and refuses
  its invalid combination with `-fields`;
- reads template comments, commented options, nesting, placeholders, examples,
  patch/field/direction arguments and sampled lines in OpenFOAM's own idiom;
- searches every etc directory `findConfigFile` uses, including user entries;
- shows class-header descriptions, examples and property tables from the
  installed source, plus output location, times and libraries.

Remaining replay failures are genuine physics/case mismatches or required
placeholders the cavity cannot supply; the panel leaves those holes visible.
The detailed evidence is in commit `89211cb` and the v5.3.0 release history.

## 2026-09-08 – 09-09 in brief

Details are in `docs/releases/v5.0.0.md` through `v5.2.2.md` and in Git.

- Releases: `v5.0.0` (Post-Process tab), `v5.1.0` (one installation-aware
  vocabulary, command, help and tutorial corpus for FOAMy, Claude and Codex,
  invalidated together on any distro, version or path change), `v5.2.0` (theme
  kept as `ui-theme` through the preload's synchronous config channel, because
  the changing port empties localStorage), `v5.2.1` (ParaView detection and
  startup) and `v5.2.2` (switcher, agent case changes, honest charts). GitHub
  keeps only the two most recent releases as downloads; tags, commits and
  notes stay.
- RULES changes made at the user's request in this period: every source change
  ends with an Electron build replacing the pair in `Working/`, then the local
  commit; only the current version's pair may remain; an explicit release
  request uses the direct-publication flow on the existing pair; `test` and any
  `*_test` case are disposable; post-build verification is discretionary.
- Agent conversation: the app speaks inside `<openfoam-studio>` tags, which
  `sanitizeUserMessage()` strips from user text; mode and open-case changes are
  announced there (`buildCaseNotice`), and the prompts say the instructions
  describe only the current setting. Left alone: `buildSystemPrompt`'s
  `.filter(Boolean)` also drops the paragraph breaks.
- Detached runs: a command with a trailing `&` is `nohup setsid`-detached and
  survives quitting the app; a foreground one dies with its `wsl.exe` relay.
  The detach button added around this was reverted at the user's request — do
  not add it back.
- ParaView: detection reads the installation layout instead of executing
  `pvpython --version` (107 s on a cold first run), searching sources in cost
  order with the custom path first; the workbench reports real start phases,
  can be cancelled and heals when its tab becomes visible again. Verified
  against ParaView 6.2.0.
- Charts: residual and Post-Process axes are read from the data
  (`residualLogDomain()`), zero residuals become gaps, and the Post-Process
  chart gained pan, zoom, resize and a preview-accurate export. The case
  switcher reconciles its chips on `case-list-changed` and
  `foam-version-changed`.
- Noticed, not changed: the packaged standalone carries the whole `tests/`
  directory, which nothing in the app reads.

## Earlier history

- Prior release notes from v1.0.0 through v5.0.0 remain in `docs/releases/`.
- The detailed 2026 security, correctness, robustness and frontend review is
  `docs/audit-2026-09-03.md`.
- Git history is the authoritative record of implementation chronology.

## Stable project context

- OpenFOAM Studio is an Electron shell around a Next standalone server. The
  operational chain is `Electron renderer -> Next server -> wsl.exe -> OpenFOAM`.
- It targets Windows 10/11 with WSL2 and OpenFOAM Foundation v9-v14. OpenFOAM
  is not bundled; ParaView is an optional Windows-side integration.
- FOAMy proposes edits for user approval. Claude and Codex are separate
  subscription-backed in-app agents sharing the same OpenFOAM authority layer.
- The ignored `docs/agent-log/` directory is reserved for progress notes from
  user-authorized subagents.
