# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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

## 2026-09-09 — v5.2.2: switcher, agent case changes, honest charts

- Released `v5.2.2`; notes in `docs/releases/v5.2.2.md`.
- RULES 2 of *Validation, builds and publication* gained a clause at the user's
  request: only the current version's pair may remain in `dist-electron/` and
  `Working/`, older artifacts are deleted in the same change. The stale `v5.1.0`
  pair was removed under it.
- **Switcher chips.** `page.tsx` reconciles the open-case chips against
  `/api/cases?action=list` on a new `case-list-changed` event (dispatched by the
  Dashboard after a delete or rename) and on `foam-version-changed`. It covers
  every route to a vanished case rather than one patch per route.
  `handleSelectCase('')` — how the Dashboard clears the selection after deleting
  the open case — used to add a nameless chip; it now returns early. Verified in
  the app: a deleted case's chip goes, and switching OF 13 -> 14 dropped
  `nozzle_test`, which exists only under 13.
- **Agents and the open case.** The rebuilt system prompt named the new case,
  but the conversation is full of the old one and history wins, so both agents
  kept working on it. `buildCaseNotice` in `agent-prompt.ts` announces the
  switch in the app's own `<openfoam-studio>` channel, exactly as the mode
  change is announced; `claude-cli.ts` and `codex-cli.ts` track the last
  announced case per session, and both routes pass it. FOAMy's `/api/chat` adds
  the same statement when the session's previous case differs. Unit-tested; not
  exercised against a live subscription agent.
- **Monitor residuals.** The axis was pinned to `[1e-8, 1]` with
  `allowDataOverflow`, so anything outside was clipped, and zero residuals — what
  OpenFOAM writes for a field it did not solve — went to minus infinity. New
  pure `residualLogDomain()` in `residuals.ts` reads whole decades from the data;
  non-positive samples become gaps; the X axis spans `dataMin..dataMax` instead
  of forcing 0. Measured on the local `cavity` log: the axis went from a fixed
  1e-8..1 to 1e-7..1e-3, and X now starts at 10.56 rather than 0. The local
  `combustor` log carries 339 zero residuals.
- **Post-Process.** `logUsable` required EVERY sample to be positive, so one
  zero disabled the button for a whole dataset — measured: `combustor` disabled
  before, enabled after, with its 339 points drawn as gaps. The chart gained
  pan, wheel zoom (Shift/Alt for one axis), double-click fit, a corner resize
  handle and Reset view; the ResponsiveContainer is keyed on the frame because
  recharts otherwise keeps the dragged size until some other resize event.
- **Export dialog.** The window and shape travel into it and can be dragged on
  the preview, which is the file. Found and fixed while verifying: its rebuild
  observer watched childList/attributes only, and recharts rewrites tick text
  in place, so a changed axis window left the preview — and the saved file —
  showing the previous framing.
- **ParaView filter picker.** `setFilterChoice(undefined)` turned the Radix
  Select uncontrolled, so it kept displaying the deleted filter and re-picking
  it fired no change. It resets to `''` now. Verified end to end against
  ParaView 6.2.0: Clip added, deleted, added again.

## 2026-09-09 — v5.2.1 and a two-release download window

- Released `v5.2.1` with the ParaView detection and startup work below; notes in
  `docs/releases/v5.2.1.md`. Direct publication flow: the existing pair was
  renamed to the new version's names rather than rebuilt.
- At the user's request, `RULES.md` gained *Validation, builds and publication*
  7: GitHub offers only the two most recent releases as downloads, and every
  publication deletes the older entries and their assets by itself. `v5.1.0` and
  `v5.0.0` were removed under it; their tags, commits, source archives and
  release notes remain. `v5.2.1` is the current download and `v5.2.0` the
  rollback one.

## 2026-09-09 — ParaView: detection without a cold start, startup that reports itself

- Measured on the reference machine, and the cause of both reported problems:
  `pvpython.exe --version` takes **107 s on a first run** and 3.5 s once Windows
  has the files cached; a pvpython *script* takes ~100 s cold and 0.7 s warm.
  Detection probed every candidate by executing it with a 15 s timeout, so
  before ParaView had been launched once nothing was ever found — including a
  path the user had pasted correctly. The user's guess that "it needs a first
  launch of ParaView" was right.
- Detection no longer executes anything in the normal case. It reads the
  installation LAYOUT instead: pvpython.exe beside paraview.exe/pvbatch.exe, or
  a `share/paraview-X.Y` / `lib/paraview-X.Y` folder, with the version taken
  from those folder names (`ParaView-6.2.0` beats `paraview-6.2`, which carries
  no patch level). Executing `--version` is now the fallback for a lone
  pvpython outside a ParaView tree, sequential and with a 150 s timeout.
  Measured after the change: auto-detect 6 ms, every form of pasted path 1-19 ms.
- Sources are searched in cost order and any of them can end the search: custom
  path, `OFSTUDIO_PARAVIEW_PATH`, standard install folders, PATH, then the
  registry. The custom path is therefore what answers whenever it holds a
  ParaView, which is what the Dashboard needs to save it — it refuses to save a
  path whose source is not `Custom path`, and the fallback scan used to win that
  race. Pasted paths now also accept quotes, `%VARIABLES%`, forward slashes,
  trailing separators, a `bin` folder, an install root, `paraview.exe`, and a
  path one level too deep such as `share`.
- Standard folders now include `ProgramData`, the drive roots, the profile,
  Desktop and Downloads, for portable unzipped installs. Registry hives are
  queried in parallel, the tree walk checks `bin/pvpython.exe` first and prunes
  folders that cannot hold it, and concurrent callers share one scan. A failed
  scan is cached for 30 s only, so installing ParaView no longer requires an
  app restart.
- The workbench start reports real phases — `locating`, `launching`,
  `interpreter`, `engine`, `reading`, `rendering` — the last four emitted by the
  worker itself around `from paraview.simple import *`, which is the minutes-long
  part of a cold start. The tab shows the phase, the elapsed seconds, a note
  after 20 s and a Cancel button, replacing four labels animated on a 1150 ms
  timer that finished long before the engine did.
- Cancelling used to queue behind the start it was cancelling; it now aborts the
  starting worker directly (3 ms, measured) and the pending start rejects. Two
  starts for the same case join one engine instead of queueing and restarting.
  The engine reports its own exact version, which replaces the folder-derived
  one in the session and the Dashboard.
- Every workbench request is bounded by an AbortController, and the tab heals
  itself: becoming visible again restarts a session that failed while hidden,
  and re-requests a render when the state arrived without a picture — which is
  what the user was doing by hand when they switched tab and came back. A render
  while the pane is hidden reuses the last measured size instead of a 1000x700
  guess. Neither panel can spin forever on a config bridge that never answers.
- Verified end to end against ParaView 6.2.0 and the WSL `test` case: ready in
  21 s with live phases, exact version, JPEG render, follow-up command, clean
  stop. `npm run check` passes (175 tests); the built artifacts contain the new
  code and no longer contain the old.

## 2026-09-08 — v5.2.0

- Released `v5.2.0`: the theme that survives a restart, the agent mode-change
  channel below, and the Dashboard settings spacing. Notes in
  `docs/releases/v5.2.0.md`; the paired artifacts carry the new names.

## 2026-09-08 — theme persistence, settings spacing, detached runs

- The light/dark choice is stored as `ui-theme` in the userData config file and
  seeded into next-themes' localStorage key by `electron/preload.js`, over a new
  synchronous `foamy-config:get-sync` channel, before the page's own scripts
  run. localStorage alone could never hold it: the port, and therefore the
  origin, changes at every launch.
- Measured, because the user reported background runs dying with the app: a
  command started with a trailing `&` is `nohup setsid`-detached inside WSL and
  SURVIVES the `taskkill /F /T` that quitting runs on the server tree; a
  foreground one dies with the `wsl.exe` relay that streams its output. Proved
  end to end through the UI, with a `sleep` started each way. The run in
  question had simply been a foreground one. The engine therefore already did
  what was asked, and the detach button, its shortcut, the tooltips and the
  close warning added around it were reverted at the user's request: the
  terminal is back to its single Enter button with no hover text. Do not add
  them back — the user types the `&` deliberately.
- Dashboard settings: version buttons and ParaView's Auto-detect/Save path pair
  moved from `gap-2` to `gap-3`.
- README gained the user's Post-Process and ParaView captures.

## 2026-09-08 — the publication flow names the artifacts it renames

- Validation rule 4 always said the direct flow reuses and renames the existing
  pair rather than rebuilding. It now says which pair: the one in `Working/`
  and its copy in `dist-electron/`, both carrying the new version's names once
  the release is out.

## 2026-09-08 — disposable cases are a naming convention

- User decision 5 no longer names two fixed cases. The default working case is
  `test`, and any case whose name ends in `_test` is disposable, created or
  copied from the tutorials at the agent's discretion. `claude_test` and
  `cavity_test` still qualify; they are simply no longer the whole list.

## 2026-09-08 — builds are no longer asked for

- At the user's request, RULES 2 of "Validation, builds and publication" was
  reversed: it used to say "build Electron only when the user asks", and now
  every change to the source ends with a build whose artifacts replace the pair
  in `Working/`. RULES 4 gained a clause naming rule 2 as what keeps the
  publication artifacts current.
- First build under the new rule reproduced `v5.1.0` from the agent-channel fix
  below, 87.0 MB portable and 133.0 MB folder zip, and both copies in `Working/`
  now match `dist-electron/` by SHA-256.
- Noticed in passing, not changed: the packaged standalone carries the whole
  `tests/` directory, which nothing in the app reads.
- Follow-up the same day: user decision 2 now orders the pair — the local commit
  follows the successful build — and decision 3 spells out that neither of those
  automatic steps is a licence to push, tag or release. Decision 3 already
  forbade all of that; only the wording grew.

## 2026-09-08 — the app now has its own voice in the agent conversation

- Reported by the user: after switching a conversation to No limits, the agent
  told them the bracketed mode announcement in their message was "a classic
  prompt injection pattern", then decided unrestricted mode had been on since
  the first turn and apologised for its earlier, correct, guarded answers.
- Two causes. The announcement was prepended to the user's own turn as
  `[The user has just switched …]`, which is precisely the shape of an injected
  fake system message, so a careful agent distrusts it and blames the user. And
  the system prompt is rebuilt and re-applied on every message — on `--resume`
  for Claude Code, on `thread/resume` for Codex — so after a switch the whole
  conversation looks as if it had always run under the new mode.
- Fix in `src/lib/agent-prompt.ts`: the app speaks inside `<openfoam-studio>`
  tags, `sanitizeUserMessage()` rewrites those tags (and `<system-reminder>`)
  out of user text so the channel cannot be forged, and both system prompts now
  say that the instructions describe only the CURRENT setting, that earlier
  answers under the other mode were right at the time, and that the mode is a
  shield button the user can press rather than a fact about the world. Guarded
  mode also learns to name No limits instead of calling things impossible, and
  that the Commands-tab Terminal is the user's own shell.
- `claude-cli.ts` and `codex-cli.ts` both send the notice and sanitise the
  message; Codex previously announced nothing at all. Covered by
  `tests/agent-prompt.test.ts`.
- Left alone: `buildSystemPrompt` ends with `.filter(Boolean)`, which also drops
  the `''` paragraph breaks, so the prompt reaches the agent as one dense block.
  Pre-existing, cosmetic, not touched here.

## 2026-09-08 — GitHub release retention

- Removed the obsolete GitHub releases and binary assets from `v1` through
  `v4.0.0`. Their Git tags, commits, source archives and repository release
  notes remain available.
- Retained `v5.1.0` as the current download and `v5.0.0` as the near-term
  rollback download.

## 2026-09-08 — v5.1.0: installation-grounded AI

- Released `v5.1.0` from commit `10cf290`; release notes are in
  `docs/releases/v5.1.0.md`.
- FOAMy, Claude and Codex share one installation-aware vocabulary, command,
  help and tutorial corpus. The identity includes WSL distro, OpenFOAM version,
  resolved paths and installed-binary metadata, so a switch or in-place update
  invalidates every related cache together.
- The local reference installation reported OpenFOAM 14, 1,513 runtime names,
  1,333 keyed types, 151 applications, 233 commands and 20,030 tutorial chunks
  from 5,056 files. These are observations, not a hard-coded contract.
- Guarded agent writes validate known names and dictionary syntax before writing;
  guarded command options and required values come from the installed binary's
  `-help`. v9-v10 lookup reports uncertainty instead of false absence when
  `foamToC` is unavailable.
- FOAMy fingerprints `0/`, `system/` and `constant/` and reloads bounded disk
  context after agent, script or terminal edits. The three AI panels display
  knowledge version, freshness and coverage.
- Tutorial ranking remains local BM25 plus the Italian CFD glossary; paths and
  exact identifiers now receive strong evidence boosts. At most two excerpts and
  1,500 characters enter a FOAMy prompt. There is no bundled vector database or
  embedding model.

## 2026-09-08 — policy/documentation split

- `RULES.md` was intentionally reduced to fixed user-controlled directives,
  safety boundaries and major traps. It no longer carries version status,
  release workflow history, module inventories or detailed feature behavior.
- This rolling `HISTORY.md` now carries project context. Recent release notes,
  Git history and the audit remain the detailed historical record.
- An explicit push/version/release request now uses the direct-publication
  policy: version and names are updated, existing assets are used or renamed,
  then commit/tag/push/release proceeds without an automatic rebuild or broad
  verification. A missing requested asset requires user direction to build.
- Post-build follow-up verification is discretionary: the agent selects the
  smallest check justified by the changed surface and build output, or reports
  success without extra checks when none is warranted.

## 2026-09-08 — v5.0.0: quantitative post-processing

- Released `v5.0.0`; see `docs/releases/v5.0.0.md`.
- Added the Post-Process tab for function-object datasets, residuals, charting,
  exports and installation-derived function templates. Fixed case/file refresh,
  installation-change propagation and modern OpenFOAM solver detection.

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
