# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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
