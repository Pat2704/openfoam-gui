# RULES — fixed project rules

Last changed only at the user's explicit request: 2026-09-08.

This is the only normative project instruction file. It contains fixed user
decisions, safety boundaries and high-impact traps. Only the user may authorize
an addition, removal or wording change here. Agents must not amend this file on
their own: record context, outcomes and newly discovered issues in
`docs/HISTORY.md` instead.

Both this file and `docs/HISTORY.md` must remain at or below **500 lines**.
When either approaches the limit, compact it in the same change; do not split
its purpose across more instruction files. Read this file fully before changing
the project. Read `README.md` and the relevant recent part of `HISTORY.md` when
the task needs product or historical context.

## User decisions

1. The user writes in Italian. Repository prose, UI copy and code comments are
   in English.
2. Preserve unrelated work in a dirty worktree. Commit each completed change
   locally in coherent commits, without `Co-Authored-By` trailers. The commit
   comes after the build that *Validation, builds and publication* 2 requires
   and after it succeeded, so nothing is committed that has not been built.
3. Never push, tag, publish, replace a release asset or change a version unless
   the user explicitly asks in the current message. Building and committing are
   automatic; going to GitHub never is, and neither a finished build nor a local
   commit is a reason to take that step. Stop there and wait for the user's word.
4. Do not decide the number of subagents alone. Ask the user how many may be
   opened before starting one, then open no more than authorized. Each authorized
   subagent updates its ignored `docs/agent-log/<task>.md` after every step.
5. Never run destructive tests against real WSL cases. The default one to work
   in is the case named `test`. Beyond it, create as many as the work needs, or
   copy them from the shipped tutorials, without asking — as long as the name
   ends in `_test`, as in `cavity_test`. That suffix is what marks a case as
   disposable: only cases named that way, and `test` itself, may be broken,
   overwritten or deleted.
6. The product remains colourful. Do not restore the rejected monochrome
   overhaul, and do not re-propose hiding `empty` or `wedge` mesh patches by
   default.

## Validation, builds and publication

1. Match validation to risk. Use focused checks for focused code changes;
   `npm run check` is useful for broad application changes, not mandatory after
   every edit. Documentation-only changes need only relevant text/reference and
   diff checks.
2. Every change to the source ends with an Electron build, without being asked
   and whatever the change was: run it, then replace the two artifacts in
   `Working/` with the ones just produced in `dist-electron/`, keeping their
   names. The folder beside the checkout must always hold the app as the source
   currently stands. Documentation is not source. Keep the incremental caches;
   never delete `.next/cache`, `node_modules`,
   `electron/resources/bin/node.exe` or the Electron Builder cache to force a
   clean build.
3. After an Electron build, the agent decides whether further verification is
   warranted from the change's blast radius, the build output and any
   packaged-only behavior it could affect. Use the smallest relevant check when
   it is warranted; otherwise report the successful build. Never make a full
   suite, packaged-server launch or source-to-artifact check automatic.
4. An explicit request to push, bump a version or make a release authorizes a
   **direct publication flow**: update the requested semver fields, user-facing
   artifact names, release notes and required file names; commit, tag, push and
   create the release. Do **not** automatically rebuild, package, run tests,
   run `release:check`, or start the packaged server. Use the existing paired
   artifacts — rule 2 is what keeps them current — renaming them to the
   requested release names when needed. If the requested assets are absent, ask
   the user whether to build rather than doing so implicitly.
5. A version bump updates `package.json`, `electron/package.json`, the two
   top-level version fields in `package-lock.json`, README artifact names and
   `Expand-Archive` example, `.github/ISSUE_TEMPLATE/bug_report.yml`,
   `electron/electron-builder.yml`, and `docs/releases/vX.Y.Z.md`. Do not
   blanket-replace dependency versions in lockfiles. Tags use `vX.Y.Z`.
6. Never move a published tag or replace published assets without the user's
   explicit instruction. When direct publication reused or renamed existing
   artifacts, do not claim a fresh source-to-artifact verification.

## Product and safety invariants

1. Support only OpenFOAM Foundation v9-v14. Keep legacy layouts for `<=10` and
   modular layouts for `>=11`; do not imply ESI/OpenCFD release compatibility.
2. Installation-derived data must follow the selected WSL distro and OpenFOAM
   installation. Shared vocabulary, command, help and tutorial caches use the
   installation identity and must invalidate together when it changes.
3. OpenFOAM commands execute through `src/lib/wsl.ts`. Multi-line or
   variable-bearing WSL scripts use the base64 script runner; inline shell
   variable expansion through `wsl.exe` is unreliable.
4. All case names, relative paths and command path arguments use the shared
   validators. No absolute path, traversal, control character, prefix-sibling
   or symlink escape may reach a case operation.
5. Guarded Claude and Codex access only the supplied case tools and installed
   OpenFOAM applications. They may not write runnable `Allrun`, `Allclean`,
   `Allmesh`, `Allwmake` or `Alltest` scripts. Guarded command options are
   checked against the executable's `-help`; agent dictionary writes are
   validated before writing.
6. Unrestricted agent mode remains inside WSL; `/mnt/` is blocked. Treat that
   check as accident prevention, not adversarial sandboxing.
7. Never put credentials in `.env`; it is packaged. Use ignored `.env.local` or
   the app's protected local storage. Do not log or commit secrets.
8. `/api/agent/tools` must fail closed with its per-process token. Browser
   cross-origin API requests stay blocked. External Electron links are HTTP(S)
   only.
9. `foamDictionary` syntax checks run on Linux-side temporary files. Never run
   an OpenFOAM binary with the Windows-mounted project path as working directory.
10. ParaView stays an optional external local integration. Do not embed its Qt
    UI or accept browser-supplied Python, proxy or property names; retain an
    explicit worker/API allowlist and case-local source validation.

## High-impact implementation traps

1. In the packaged app, never use native `window.confirm()` or `alert()`;
   use `confirmDialog()`. Every WSL child process needs `windowsHide: true`.
   The changing localhost port makes browser `localStorage` non-persistent.
2. Next 16 uses `proxy.ts`; keep `agentRules: false` and do not regenerate
   `CLAUDE.md` or duplicate AI routing files. Consult the installed Next docs
   before changing framework conventions.
3. A selected installation or a cached tab must refresh on both OpenFOAM version
   and distro changes. The Dashboard emits `foam-version-changed` for this.
4. Function-object and application catalogues come from the selected
   installation, not hard-coded version lists. Use `find -L` where OpenFOAM
   directory links must be traversed.
5. Post-processing commands are parsed allowlists, never editable shell text;
   `-case` is refused. A time-series restart replaces recomputed rows, whereas
   sampled profiles are separate snapshots.
6. Preserve File Editor dirty buffers, selection and scroll on refresh. A clean
   open buffer may refresh after external writes; a dirty one must offer reload.
7. Mesh rendering stays hardware-accelerated, on-demand and HiDPI-safe. Explicit
   CSS width/height is required when three.js `setSize(..., false)` is used.
8. Treat JavaScript replacement strings as syntax, not literal data: `$&`,
   backticks and dollar signs require safe edit methods. Keep code style and
   comment density consistent with the edited file.
9. Keep README-referenced screenshots free of orphans. Automated sessions do
   not replace a real full-window capture; ask the user for a saved image.

## Documentation roles

- `docs/RULES.md`: this fixed, user-controlled policy.
- `docs/HISTORY.md`: rolling project context and recent history; informative
  only, never a source of authority.
- `README.md`: user-facing product and contributor documentation.
- `docs/releases/`: release-specific notes.
- `docs/audit-2026-09-03.md` and Git history: detailed evidence and archaeology.
