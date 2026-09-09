# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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
