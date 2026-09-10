# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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

## 2026-09-10 — Dead templates removed; clipboard feedback

- `CASE_TEMPLATES`, `FILE_TEMPLATES` and `STANDALONE_FILE_TEMPLATES` (with
  their two types) were deleted from `src/lib/openfoam-data.ts`: nothing
  imported them, they predated `case-templates.ts` and carried none of its
  fixes. The file is now only the built-in command table (1378 lines removed).
- The File Editor's copy button and the OpenFOAM file browser report a
  clipboard refusal instead of a success toast (or silence).
- Lint, typecheck and the 214 tests pass.

## 2026-09-10 — Failures no longer read as normal states

- OpenFOAM file browser: a failed folder read shows the server's reason with
  "Try again" instead of "Directory not found — the section may not be
  available in this installation"; folder and file reads that arrive after a
  newer click are discarded.
- Commands: when the installation's command list never arrives, the subtitle
  says so and offers "Try again" instead of "reading the installation…" for
  ever. Monitor: a failed residual read says so instead of "No residuals found".
- Wizard: an invalid case name is reported under the field and blocks Next on
  the first step, with the rule the summary already applied (`caseNameProblem`).
- File Editor "Clean TS" asks the server for running processes first and
  refuses while one belongs to the case (and when the check fails), as the
  Monitor's button already did. `isProcessForCase` moved from `monitor.tsx` to
  `src/lib/case-processes.ts`, with its own tests.
- Lint, typecheck and 214 tests pass. In the dev server "foo#1" showed the
  name rule under the field and Next stayed on the first step; Applications
  still lists normally. Not exercised at runtime: the failure paths (they need
  WSL to fail) and Clean TS during a real run.

## 2026-09-10 — Honest states: Undo, deletes, Monitor log, wizard check

- File Editor: Undo is disabled on an unmodified file and asks before
  discarding; a folder that cannot be created says why; a batch delete reports
  "Deleted N of M" and names what was left (the `deleteBatch` route now returns
  `failed`), instead of an empty success toast.
- Monitor: the log pane tells loading, an empty log and a failed read apart;
  it used to read "Loading..." for ever in the last two cases. A refresh that
  fails after the log was shown keeps the text on screen.
- Wizard summary: "Everything checks out" appears only after the installation
  check has answered; while it runs the box says so, and if it cannot run
  (index not ready, WSL busy) a neutral note says only the built-in checks
  passed and stale findings from an earlier run are cleared.
- Tutorials follow an installation change: when the tutorial directory changes
  the open category and its list are closed, and a distro switch now reloads
  the tutorial categories as a version switch already did.
- Lint, typecheck and the 211 tests pass. In the dev server the wizard
  summary showed "Checking the files with the installation…" on arrival and
  the green box about 6 s later, once the check answered; an empty log made
  in the `test` case (then removed) read "The log is empty so far.".

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

Audit of the Compute panel, checked against the installed v14 and v13 rather
than from memory: the OpenFOAM sources for `dictArgList`, `readConfigFile` and
`foamPostProcess`, all 127 v14 and 119 v13 templates, and 127 real replays in a
`cavity_test` case. 61 of those 127 calls failed before the change; the ones
that failed for a reason the app owned now do not.

- **`-solver` is what makes half the catalogue work.** `foamPostProcess` builds
  no transport or thermophysical model unless it is given the solver module, so
  `forceCoeffs`, `forces`, `yPlus`, `wallShearStress`, `turbulenceIntensity`,
  `wallHeatTransferCoeff` and `power` all aborted on "No valid model for viscous
  stress calculation" or "Could not find U, p". The command now carries
  `-solver <name>` when the case declares one and the installed utility's own
  `-help` lists the option; the panel explains what it does and what to use
  instead. `-solver` and `-fields` are mutually exclusive in the utility, so a
  line carrying both is refused with that reason.
- **Comment attribution was wrong in the templates' own idiom.** A comment
  ABOVE an entry introduces it (`randomise` gave `field` the help text of
  `magPerturbation`); a commented-out entry is a documented option, not prose
  (`graphCutLayerAverage`'s `distance`, `graphLayerAverage`'s `weightField`,
  `reactionRates`'s `phase` and `writeFields`, `adjustTimeStepToReaction`'s
  `extrapolate` — seven distinct entries across the installation, all of them
  previously either lost or glued into a neighbour's help). Sub-dictionaries are
  no longer flattened, so `populationBalanceSetSizeDistribution` stopped
  offering `Q` and `file` twice, and `field $phi` wiring is no longer a
  parameter.
- **Syntax fixes with a failing run behind each.** A list placeholder keeps its
  brackets (`objects=<objectNames>` was refused as a broken list, not as an
  unfilled hole); a base-interface key with a placeholder IS an argument, which
  is how `writeMesh` asks for `writeControl`; `e.g,` counts as an example;
  `<coordinate>` and `<fieldType>` are not vectors and fields; `patch2` names
  the other patch; a direction is `(1 0 0)`; and a sampled line crosses the mesh
  instead of running from the origin to the origin.
- **The catalogue is as wide as the installation.** Templates come from every
  etc directory `findEtcDirs` searches — `~/.OpenFOAM/<version>`, the site
  directories, then `$WM_PROJECT_DIR/etc` — first found winning, as
  `findConfigFile` resolves them. A user's own function object was listed by
  `-list` and refused by the panel as "not available in this OpenFOAM
  installation".
- **Each function now explains itself from the installed source.** The class
  header behind a template carries the property table, the values each
  enumeration accepts and a complete dictionary example; those are parsed and
  shown, with the file they came from. 119 of the 127 types resolve through an
  index of `Class` lines; the other eight are registered under a family name
  their header does not carry and show nothing rather than another class's
  reference. `foamInfo` was rejected for this: it prompts when a name is
  ambiguous and answers `sets` with a topoSet source.
- The panel also states where the output lands, the times on disk, the libraries
  the entry loads, and warns only on the functions that really do steer a solve
  (`stopAt*`, `adjustTimeStep*`) — `writeObjects` and `removeObjects` share
  their category and replay perfectly well.
- Left alone, verified as genuine case mismatches rather than app defects: the
  remaining failures in `cavity_test` are chemistry, multiphase, lagrangian and
  compressible functions on a laminar incompressible cavity, and the calls whose
  placeholders no case can supply (`<triSurfaceFileName>`, `<phaseName>`,
  `<rhoInf>`, …), which stay visible as holes with the panel saying so.

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
