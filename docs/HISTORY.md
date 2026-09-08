# HISTORY — rolling project context

This file records recent project state, decisions already implemented and
historical context. It is informative only: `docs/RULES.md` is the sole source
of project rules. Keep this file at or below **500 lines**. Add new entries at
the top, then compact older detail into links to Git history, release notes or
audits.

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
