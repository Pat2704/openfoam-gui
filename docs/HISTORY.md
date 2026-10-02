# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

## 2026-10-02 — Phase 2: curve comparisons and ParaView numerical views

- Post-Process adds a separate comparison of up to six dataset/log curves from
  multiple cases or profile snapshots. Each curve retains its own coordinates,
  gaps and provenance; incompatible independent axes are refused. Long-format
  tables/CSV avoid interpolation and row-index joins; chart export shares the
  same independent grids. Comparisons are snapshots with visible read limits.
- ParaView adds Chart/Table views of the selected pipeline output, with explicit
  points/cells/rows association, composite blocks, coordinates and numeric vector
  components. Plot Over Line can chart sampled fields against arc length, and
  CSV readers expose their table directly. Numerical requests are allowlisted,
  bounded and revision-checked; chart sampling and export limits are explicit.
- Initial/manual-only File Editor indexing indicators remain unchanged. Test
  fixtures are disposable `_test` cases; no real case was modified.
- Checks: `npm run check`, native ParaView 6.2, disposable cases and browser QA.

## 2026-10-01 — Restore residual charts/tables; show File Editor indexing

- Fixed a regression rejecting Foundation's `Time = 0.005s` output; numeric
  parsing accepts seconds, rejects malformed tokens and recovered 2,000 samples
  across five fields from the real `myCavity` log.
  Empty logs now show an explanation instead of an empty chart and negative count.
- File Editor separates tree indexing from file reading, preserving buffers/tree.
  At the user's request, tree spinners now appear only before the initial listing
  or during manual refresh; background updates and lazy folders stay silent.

## 2026-10-01 — Post-Process data integrity and background Compute; ParaView legends

- Post-Process exposes retained/plotted coverage, inventory/log limits, parser
  anomalies and non-finite gaps. Bounded sampling retains extrema and boundaries,
  reporting omissions. Screen/export use straight segments without bridging gaps;
  spatial profiles report sample means without drift.
- Residual events offer first/last/maximum initial values per timestep; first is
  the Post-Process/Monitor default. Restarts replace complete recomputed timesteps.
- Compute uses session-local, installation/case-scoped background jobs, bounded
  output, status recovery and cancellation of token-verified Linux process groups.
  Failed cancellation is retryable; timeouts have a bounded cleanup attempt.
- ParaView reconciles scalar bars across visible displays sharing a LUT, including
  time/video snapshots, preserving shared legends and hiding obsolete ones.
- Checks cover the full suite, job lifecycle, real Foundation v14 Compute/cancel,
  spike/gap data, partial logs and native ParaView 6.2 with a solved test case.

## 2026-09-13 — v5.6.1: finished agent answers use the provider's canonical result

- Released `v5.6.1` at the user's request with notes in
  `docs/releases/v5.6.1.md`, covering this entry. Direct publication reused
  the pair built for commit `03a4a83` (source at 5.6.0), renamed without
  a second build, so its embedded version resource reads 5.6.0. GitHub keeps
  v5.6.1 and v5.6.0; the v5.5.0 release entry was removed, its tag kept.
- Two earlier fixes tried to infer cumulative provider previews from delta and
  item IDs. A real finished answer still contained triangular repetitions such
  as `A`, `A+B`, `A+B+C`: the UI never consumed Claude's canonical result event,
  while the Codex adapter explicitly emitted an empty result at turn completion.
- `done.text` is now the contract for a completed turn. Claude already supplies
  that authoritative result; the Codex adapter retains its last completed public
  agent message and supplies it too. The shared transcript replaces all preview
  text with that single answer while preserving tool and reasoning cards. A
  regression test includes incomplete, cumulative previews and proves that only
  one canonical final text block survives.
- A packaged-server check then observed the same non-empty canonical text in
  both Claude's and Codex's final `done` event.
- The remaining symptom was visual: closing and reopening a panel immediately
  showed the same stored answer correctly. Both panels had keyed their changing
  transcript blocks by array index while `done` removed and reordered previews.
  They now use stable semantic keys, give the canonical final block its own ID,
  and synchronously commit the terminal replacement before the SSE stream closes.

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
  (into a discarded file, flush included) three triples of frames — a far
  frame, the same again, the next one — and `estimateRenderSeconds` combines
  the three costs over the plan: every frame renders and encodes, every change
  of time pays interpolation, every saved step is read once. A first model
  that charged every new time as a full read over-estimated 8×. Measured on
  cavity at 1080p/4K: estimates 21.5/23.1/18.5 s against 16.6/19.9/14.9 s
  actual (held; interpolated; 4K interpolated); a 28,501-frame request showed
  the confirmation instead of being refused.
- **Feature Edges** is offered as a display representation, as in ParaView
  (silhouette and sharp edges). Each pipeline item lists the representations
  its own display offers (`representations_for` against the build's
  available values); the menu, the line-width control and video timeline
  snapshots use that list, and anything else is refused. Verified on v14 with
  ParaView 6.2.0: listed, applied from the menu, captured in a timeline view;
  "Volume" refused. 344 tests, typecheck and lint pass; the case was removed.

## 2026-09-12 — ParaView: video export with a timeline of views

- At the user's request the ParaView workbench has a **Video** tab. The user
  sets a view in the viewport and adds it "until" a saved time step, changes
  the view and adds the next, as often as wanted; each entry keeps a thumbnail
  and can be shown again, replaced with the current view or removed, with a cut
  or a smooth one-second camera move into it. Pace: every saved step lasts N s
  (slow motion whatever the spacing) or 1 simulated second = N s of video;
  optionally fields are interpolated between steps (ParaView's
  TemporalInterpolator, inserted under the reader for the export only).
  Output 480p–4K, 12–60 fps, colour range fixed as captured or rescaled per
  frame; a live estimate of frames and duration (limit revised below).
- The frame plan is pure and tested (`src/lib/paraview-video.ts`); the session's
  own pvpython renders it (`capture_view`, `apply_view`, `export_video` in the
  worker; snapshots are re-validated there). MP4 uses VTK's Media Foundation
  writer that the Windows ParaView ships (no FFMPEG); OGV (Theora) is the
  fallback; `videoFormats` in the state reports what the build has. The
  process answers one request at a time, so while exporting the API refuses
  other workbench commands ("A video export is running…"), the viewport shows
  a lock overlay, progress arrives as protocol lines and Cancel drops a file
  the worker checks between frames. Afterwards the original view, time and
  size are restored. The latest video stays in the session's temp folder and
  can be downloaded (Save as…) or copied to `postProcessing/videos` in the case.
- Verified on a disposable cavity run (v14, ParaView 6.2.0), in the dev server:
  two views (U until 5 s, then p zoomed and rotated with a smooth move) at
  0.8 s per simulated second with interpolation gave 183 frames, 7.6 s, 876 KB
  in 5.4 s; frames decoded in the page show one legend per view and the camera
  mid-move. A 1,200-frame 1080p export ran at about 39 frames/s, blocked
  commands with the message above and cancelled at 716 frames with the view
  restored; a 160-frame export was saved into the case (valid ISO MP4); OGV
  with per-frame colour and no interpolation gave 58 frames. 342 tests (11 new
  for the plan), typecheck and lint pass. The case was removed.
- Found, not changed: after recolouring, the live workbench keeps the previous
  array's legend on screen beside the new one (the export hides it).

## 2026-09-12 — v5.5.0: File Editor fits the window; preflight beside Clean TS

- Released `v5.5.0` at the user's request with notes in
  `docs/releases/v5.5.0.md`. Direct publication reused the paired artifacts
  built from commit `f956e95`, renaming them without a second build, so their
  embedded version resource still reads 5.4.1; source-to-artifact equivalence
  belongs to that pre-version build. GitHub keeps v5.5.0 and v5.4.1; the
  v5.4.0 release entry was removed, its tag kept.
- The File Editor fills its tab exactly at any window size and follows resizes:
  the tree and the open file each scroll inside their own card, so both stay
  on screen and the page itself never scrolls. The fixed `calc(100vh - 300px)`
  tree cap and the 32rem minimum that pushed the page are gone.
- Case preflight is launched from a green box in the tree's toolbar, beside
  Clean TS (with a ✓ or error count after a run). Its results always open in a
  compact section below, capped at min(34%, 17rem) and scrolling inside; tree
  and file keep the rest (12rem floor). At the user's request the section has
  Hide (folds to a one-line bar with the summary) and Close; the green box and
  Show bring the same report back without re-running, and only "Run again"
  checks again. An unsaved buffer opens the section with the "save first" note
  instead of running.
- The work row is measured: below 440 px the new-file/folder inputs fold behind
  a + button and the line-count footer hides; below `xl` the file header shows
  icon-only Rename, Undo and Wrap.
- Checked in the dev server on `test` at 1024×768, 900×520 and 1600×1000, with
  and without results: no page overflow; tree list and text scroll alone. With
  results at 1024×768 the section is 198 px and the text 324 px; hidden, a
  38 px bar; at 1600×1000 the cap holds at 272 px. Hide, Show, Close and the
  green box made no further preflight request.

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

- Dashboard → Tutorial: categories and a category's tutorials scroll
  independently, in a grid measured by `tutGridRef` to end at `main`'s bottom.
- `electron/build/icon.ico` was repaired as a raster (airfoil dash, barb and
  a broken streamline); smaller frames are LANCZOS downsamples, with 20, 40 and
  96 px added for display scaling.

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

- A cold Windows ParaView import/render is dominated by loading its libraries;
  repeated starts are much faster. `warmParaView()` imports and renders once per
  installation/app process, below normal priority with a ten-minute ceiling.
- Dashboard starts it after detection, reports progress and offers the persisted
  `paraview-warmup` switch. Workbench startup acknowledges an overlapping warm-up.
  Defender settings were left to the user. Details are in Git history.

## 2026-09-10 — Post-Process: the function catalogue audited against OpenFOAM

Audited v14/v13 templates and 127 `cavity_test` replays. Compute now resolves
solver/field options, template arguments, etc search paths and class references
from the installation. Remaining failures were physics/case mismatches or required
placeholders. Details: commit `89211cb` and the v5.3.0 release history.

## 2026-09-08 – 09-09 in brief

Details are in `docs/releases/v5.0.0.md` through `v5.2.2.md` and in Git. This
period introduced Post-Process; installation-aware agent/command/help data;
the persistent theme; ParaView discovery, startup phases and recovery; honest
residual and Post-Process charts; and synchronized case-switcher chips.

The same history records the app's `<openfoam-studio>` control notices, guarded
detached-run semantics, and the project rules governing build artifacts and
direct release publication. The temporary detach button was reverted and must
not be restored. The packaged standalone still carries the unused `tests/`
directory; that observation was intentionally left unchanged.

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
