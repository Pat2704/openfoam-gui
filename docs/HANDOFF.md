# Handoff — where the work stands

Written for whoever (or whichever session) picks this up next.

Last updated: 2026-09-03, after cutting v2.3.1.

---

## Where things stand right now (read this first)

**v2.3.1 is released.** Everything is committed and pushed to `main`, the tag is
published, both artifacts are attached, GitHub reports v2.2.0 as the latest
release, and the repository license is MIT. The working tree is clean and
`main` is level with `origin/main`; nothing is half-finished waiting for you.

**The `v2.3.1` tag builds exactly the artifacts that are attached.** It was put
on the build commit, not moved onto it afterwards — `git diff v2.3.1 HEAD` was
empty at the moment of tagging. Keep doing it in that order and the check stays
a one-liner.

| | |
|---|---|
| release commit | `02302fc` — tagged `v2.3.1`, what the attached artifacts were built from |
| tags | …`v2.2.1` at `d0baf7f`, `v2.3.0` at `1d01a85`, `v2.3.1` at `02302fc` |
| latest release | https://github.com/Pat2704/openfoam-gui/releases/tag/v2.3.1 — both artifacts attached |
| in `Working/` | the checkout, `OpenFOAMStudio-source/`, the two artifacts `OpenFOAMStudio-v2.3.1-{portable.exe,folder.zip}`, and `OpenCFD-trademark-request.md` (§2l). Release notes live in the repo, `docs/releases/` (§4b) |

**The `v2.1.0` tag builds the artifacts attached to the release.** It was
force-moved on 2026-09-02, with the user's explicit approval, off `bcc851d` —
which still named the files `OpenFOAMStudio-v2-…` (§5, the filename trap) — onto
`6ece51d`. Verified the way that move always has to be verified: the only
difference between `1939f13`, the commit the attached artifacts were actually
built from, and the tagged commit is this file, and this file is no longer
packaged (§5, the tracing trap), so the tagged tree builds the same binaries.
That is also why a later HANDOFF-only commit does not invalidate the tag — but
anything else does, and a tag that does not build the shipped binaries is worse
than no tag.

**The tag matches what was published.** It was moved on 2026-09-02, at the
user's request, from the first v2 commit to the last one, so the tagged tree is
the tree the released .exe and .zip were built from — the startup diagnostics
(§2i) and the `/mnt/` guard (§2j) included. Verified before moving it: the only
difference between the build commit and the tag is this file. If you ever move a
published tag again, re-check that same way; a tag that does not build the
shipped binaries is worse than no tag.

**What is open:** nothing in the code. Two things sit outside it: the trade mark
request to OpenCFD is unanswered (§2l), and the repository's social preview image has yet to be
uploaded — the user is doing that one, and it can only be done from Settings. The one unexplained thing is the
folder build that lost `resources/standalone` (§2i, §2j) — the user reports
having launched the app successfully from that same folder beforehand, which
rules out the truncated-unpack theory, and no cause was ever proven. The startup
log added in §2i is what will catch it if it happens again.

**Where the recent work lives:** §2f is the Claude agent, §2g–2j are the four
rounds of fixes that followed it, and §2m is the 2026-09-03 round, newest last. §4 is the build path — it now
produces TWO artifacts and both ship — and §4b is how a release is named and
published. §5 is the trap list, and it is the section
most worth reading before touching startup, packaging or the Browser pane.

---

## 0. Orientation

**`README.md` is the description of the project** — what the app is, what each
tab does, the file-by-file layout table, the build commands. Read it and do not
re-derive any of it; nothing here repeats it.

The one thing it does not spell out is the runtime chain, which is what makes
the traps in §5 make sense:

> The portable `.exe` is an Electron shell. `electron/main.js` binds port 0 to
> get a free one, spawns the **bundled `node.exe`** with `windowsHide: true`
> running the Next.js **standalone server** from `resources/standalone`, waits
> for it to answer, then points a `BrowserWindow` at `http://127.0.0.1:<port>`
> (and kills the process tree with `taskkill /F /T` on quit). The UI is therefore an ordinary web page talking
> to REST endpoints under `src/app/api/**`, and every one of those endpoints
> reaches OpenFOAM by shelling out to `wsl.exe` through `src/lib/wsl.ts`. Three
> processes deep, three boundaries where things break: renderer → node server →
> WSL.

---

## 1. Working agreement with the user

These are standing instructions, not one-offs:

- **Rebuild the `.exe` after every change.** Not only when asked. Use the fast
  path in §4 — the user explicitly asked for a rebuild with no duplicated steps,
  so never wipe caches to "start clean".
- **Copy BOTH fresh artifacts over `Working/`** — `OpenFOAMStudio-v<version>-portable.exe`
  and `OpenFOAMStudio-v<version>-folder.zip`, and DELETE the previous version's
  pair while you are there. Those are what the user launches, and the
  pair is deliberate: the .exe for a single file, the folder for a startup that
  does not spend 29 seconds unpacking itself. Approved on 2026-08-31 for the
  exe, extended to the zip on 2026-09-02. Earlier binaries stay attached to
  their GitHub releases if one is ever needed. §4 has the details.
- **Commit every change to the working tree, without being asked.** Agreed with
  the user on 2026-09-03, replacing the earlier rule that nothing was committed
  unless asked. If you edited a file — code, docs, this file — the work is not
  finished until it is committed, in commits that are coherent on their own with
  a message that says what changed and why. Nothing is left sitting uncommitted
  for the user to find. This does NOT extend one step further: a commit is local,
  and it stays local.
- **NEVER push, tag or touch GitHub unless the user asks in that message.**
  Not a `git push`, not a tag, not a release, not replacing a release asset —
  however small and obviously wanted the change is. One authorisation covers one
  action, not the rest of the session. Finish the work, build, commit, then stop
  and say what is ready to push. **Push and a new version are the ONE thing the
  user still commands explicitly** — that is the whole point of committing
  freely: the history moves on its own, what leaves this machine does not.
  When a release IS asked for, the doc commits that close it out (this file,
  the release notes) go with it; that is settled and the user asked on
  2026-09-03 not to be consulted about it again. Do not re-open it.
- **Wait for an explicit go-ahead before cutting a new version.** Version bump,
  tag and release are the user's call, never automatic. The version bump is the
  exception to the rule above: do not bump `package.json` on your own initiative
  just because you changed something. Clarified on 2026-09-03: **the bump happens
  when the user says to push, not before.** Work accumulates on the current
  version number and the number changes as part of publishing it — so a series
  of sessions can commit freely without each one inventing a version.
- **Never run anything destructive against the user's real cases** (`cavity`,
  `nozzleFlow2D`, `shockTube` in the WSL run dir). Test in `claude_test` (§3).
- **No `Co-Authored-By` trailers.** The user asked on 2026-09-02 to be the only
  author on the repository. The commits made before that still carry them, and
  they are not worth rewriting published history for — but do not add any more.
- **The user writes in Italian**; the repo, its comments and this file are in
  English. Keep both as they are.

## 2. State of the work

Shipped in **v1.4**, verified in both the dev server and the packaged app:

- `src/components/openfoam/mesh-viewer.tsx`
  - **Vertex labels are sized in screen space.** They were sprites in world
    units scaled once per fit, so zooming blew them up until they covered the
    model. Now `sizeAttenuation: false` plus `updateLabelScale()`, which inverts
    the projection (`scaleY = 2 · LABEL_PIXEL_HEIGHT / (viewportHeight · f)`,
    `f = projectionMatrix[5]`) to pin every label to 16 CSS px at any zoom and on
    any model size. Measured 16.00 px across a 200× range of camera distance.
    The pill is also smaller and crisper (canvas supersampled 4×, mipmaps).
  - Turning the labels on no longer re-fits the view — that call only existed to
    rescale the sprites, and it threw away the user's camera.
  - **`OrbitControls` → `TrackballControls`.** Orbit pins the up vector and
    clamps the polar angle, which is the rotation limit the user hit. Trackball
    carries the up vector with the camera (ParaView-style free rotation).
    `rotateSpeed 3.0` matches Orbit's old feel; `panSpeed 0.8` keeps a right-drag
    1:1 with the pointer. Verified: the polar angle sweeps 13°–169° and
    `camera.up.y` reaches −0.77, i.e. it goes over the pole.
  - Three things the swap required, all commented in place: Trackball's A/S/D
    shortcuts are bound on `window` (disabled — they would fire while typing in
    the editor); it caches the canvas rect instead of reading it per gesture (so
    it is refreshed on resize and on pointerdown, capture phase on the parent);
    and it only emits `change` past 1e-3 world units, which on a centimetre-scale
    case means a slow drag looks frozen — hence the rAF loop that runs only
    during a gesture plus a 600 ms damping tail. **Rendering is otherwise still
    on demand and an idle viewer must stay at zero CPU.**
- `electron/scripts/prepare-resources.js` — incremental mirror, see §4.

- **New Case wizard** — `src/lib/case-templates.ts` (new) + `case-wizard.tsx`.
  The wizard produced OpenFOAM ≤10 cases unconditionally (`application
  simpleFoam;`, `transportProperties`, `turbulenceProperties`) and wrote an
  EMPTY blockMeshDict, so on the installed 13/14 nothing it made could run. Now
  the layout is chosen from the detected version, the mesh is a parametric box
  that also defines the patch list every boundary condition is generated
  against, RAS models pull in their own 0/ fields with computed inlet values,
  the summary step preflights the case, and creating over an existing case asks
  first. Proven by generating a case and running `blockMesh` + `foamRun` to
  completion on **both** 13 and 14. Note the trap found there: 14 accepts named
  dimension sets (`[velocity]`), 13 does not — the generator writes the numeric
  form for every version.
- **FOAMy copilot** — `api/chat/route.ts`, `lib/wsl.ts`, `lib/llm/*`,
  `chat-popup.tsx`. The whole-file rewrite policy is right, but it was resting
  on a context that lied: files were cut at 8 KB with no marker at all, so the
  model rewrote files whose end it had never seen. Files now carry their size
  and an explicit TRUNCATED marker, the context has a budget and lists what did
  not fit, the system prompt forbids rewriting a truncated file, a reply cut off
  at the token limit is flagged and its apply buttons withheld, "Apply all" no
  longer skips the shrink guard that single applies use, and files the user
  applied are re-sent so the model stops quoting the pre-change version.
- **Startup** — `electron/main.js`. The window is created immediately with an
  inline splash instead of after the server answers; the server is spawned
  before `whenReady` so it boots in parallel with Electron; the readiness poll
  went 300 ms → 60 ms; and a throwaway request warms the WSL layer while the
  page is still loading. Every `[main]` line is timestamped — run the exe from a
  terminal to see the breakdown. Measured after the change: window on screen at
  **173 ms**, server answering at 4.0 s, page loaded at 6.2 s.

  **The elephant is not in this code.** Between the portable stub starting and
  the first Electron process there are **~28 seconds**, on every launch: the
  NSIS portable template does `RMDir /r $INSTDIR` and re-extracts all 348 MB
  from LZMA into TEMP each time — see
  `node_modules/app-builder-lib/templates/nsis/portable.nsi`. `unpackDirName`
  does not help (the delete is unconditional). Only a distribution change can
  fix it: `compression: store` (≈350 MB exe, extraction becomes a plain copy),
  or shipping a zipped `win-unpacked` / an NSIS installer (no per-launch
  extraction at all, ~1.5 s to the window). **Asked on 2026-08-31; the user
  chose to keep the single 87 MB portable exe and live with the 28 s.** They
  raised it again on 2026-09-02 and the answer is now §4: both artifacts ship,
  and the folder build is the fast one. `compression: store` was measured and
  rejected — see the note in electron-builder.yml before trying it.
- **A transient WSL failure no longer changes the selected OpenFOAM version**
  (`lib/wsl.ts`). The disk-cache validator discarded every cached path when the
  probe threw, so a cold start could silently re-detect and switch version — the
  run directory changes with it and the user's cases appear to vanish. It now
  keeps the cached paths when WSL is merely unreachable, and an explicit version
  choice is persisted so auto-detection cannot override it.
- **Rename / move in the File Editor** — `renamePath()` in `lib/wsl.ts`, a
  `rename` action on `api/cases/[name]`, and a pencil on every row of the tree
  plus a button in the editor header. The dialog edits the full relative path,
  so renaming and moving are one operation; the destination is refused if it
  already exists (`mv` would otherwise overwrite it, or move the source INSIDE
  it), and both paths go through `validateRelativePath` so neither can escape
  the case. Note for anything similar: the WSL helper script reports errors on
  stdout and exits 0 on purpose — a non-zero exit makes `runInWslScript` throw
  the raw base64 command line, and that is what the user would see instead of
  "already exists: 0/p".

All of the above shipped in **v1.4** (bumped, committed, tagged, released).

## 2b. After v1.4

- **The app icon lost its "OF" lettering** (`electron/build/icon.ico`, commit
  9f21238). Each frame was repaired on its own — not re-rendered, not rescaled
  from another size — by masking the lettering on its red channel (background
  and streamlines are teal, red 13-60; the letters are white, red 245+) and
  filling each row by interpolating between its nearest untouched pixels. The
  scripts are throwaway, but that method is the one to reuse if the artwork
  needs another edit.
- **The v1.4 release asset still carries the old icon**: the release was
  published before the change, and the user chose on 2026-08-31 to leave it
  alone rather than replace the asset or cut a 1.4.1. The new icon ships with
  the next version. `Working/OpenFOAMStudio-v2-portable.exe` is up to date.

## 2c. Phase 1 of the knowledge work — shipped in v2

The feasibility analysis (option A + E) is implemented. Everything below is in
the working tree and verified against the live installation.

- **`src/lib/foam-index.ts`** builds the installed version's own vocabulary in
  ONE WSL call: `foamToC -all` plus its convenience flags, plus `-help` for all
  151 executables. Measured on OpenFOAM 14: **8.4 s**, 1.513 selectable names,
  145 scalar BCs, 96 vector BCs, 19 solver modules, 153 functionObjects, 151
  applications. Cached in `~/.wslgui-foam-index.json`, invalidated when the
  selected bashrc changes.
- **It must not block.** `runInWslScriptAsync()` was added to `wsl.ts` for this:
  everything else in that file is `execFileSync`, which for an eight-second call
  would freeze every other request in the server. Verified: a concurrent request
  answered in 153 ms during a build.
- **`/api/foam-index`** — `status`, `build`, `slice`, `bc`, `app`, and POST
  `validate` / `suggest`.
- **The copilot gets slices, not the index.** `topicsFor()` routes on the words
  in the question; a boundary-condition question attaches 1.255 tokens (measured
  in the server log), against ~98k for the whole index. The system prompt says
  those lists are authoritative and that names outside them do not exist here.
- **Nothing is applied unchecked.** `validateDictText()` checks `type` inside
  `boundaryField`, `model` inside RAS/LES and `solver` in controlDict against
  the RIGHT namespace — `distributionSizeGroup` exists on 14 but as a field
  source, so it is still an error in a boundaryField. The chat shows the unknown
  names inside the proposed file and asks again on Apply; the wizard folds them
  into its preflight.
- **Suggestions are word-based, not edit-distance.** The failure that matters is
  a rename between versions, where the distance is large but the words survive:
  `atmBoundaryLayerInletVelocity → atmosphericBoundaryLayerVelocity` is 10 edits
  apart. Scored on shared camelCase words first, distance as the tiebreak;
  typos (`noSlipTYPO → noSlip`) still resolve.
- **The wizard's hardcoded BC list is gone** — it now shows the 187 the install
  offers, and no longer offers `atmBoundaryLayerInletVelocity`, which does not
  exist on 14. The short built-in list survives only as the fallback for the
  seconds before the index answers, and for 9/10 where `foamToC` does not exist.
- **The index is built at startup**, fired by the same warm-up in
  `electron/main.js` that wakes WSL, so it is ready before the first question.
- Found and fixed in passing: the floating FOAMy launcher sat exactly on top of
  the wizard's **Next** button (measured 1194-1250 px against 1172-1254 px on a
  1280-wide window), so clicking Next opened the chat.

**Verified end to end with a real model** (Groq `openai/gpt-oss-20b`, on a key
the user lent for the test and has since revoked — it was passed per-request and
never written into the app's config). Same question, same model, twice:

| | without the slice | with it |
|---|---|---|
| ABL inlet velocity type | wandered ("fixedValue? fixedGradient? OpenFOAM 14, maybe 1.4?") and answered `fixedValue` | `atmosphericBoundaryLayerVelocity` |
| steady incompressible run | `application simpleFoam;` + `simpleFoam` — neither exists on 14 | `solver incompressibleFluid;` + `foamRun`, and it says the list has no simpleFoam |

Then the whole chain: asked for a complete `0/U`, the model returned an apply
block using `atmosphericBoundaryLayerVelocity, zeroGradient, noSlip, empty`, and
the validator confirmed all four against the installation. 925-2090 prompt
tokens per question.

Found during that test and fixed: Groq's gpt-oss models put their thinking in a
separate `reasoning` field, and when the output budget runs out inside it
`content` comes back EMPTY with finish_reason "stop" — which surfaced as
"Groq: empty or malformed response". `groq.ts` now says what actually happened.

Phases 2-4 of the analysis (retrieval over the tutorials, then a local model)
are not started.

## 2d. Phases A, B and C — shipped in v2

- **A — dictionary keys** (`foam-index.ts`, index format 2). `foamToC` says a
  name exists; this says what goes inside it. Three greps over the sources give
  `TypeName("x")` → class → base classes → the keys each reads, and the graph is
  walked upwards, which is the whole point: `nutkWallFunction` declares NO keys
  of its own and inherits **Cmu, E, kappa** from its parent. A fourth grep picks
  up the member-initialiser idiom (`Cmu_("Cmu", this->typeDict(type), 0.09)`),
  which is how every turbulence model declares its coefficients — without it
  `kEpsilon` came back empty. Result: **1.333 of 1.513 types have keys**;
  kEpsilon → C1 C2 C3 Cmu sigmaEps sigmak, SpalartAllmaras → Cb1 Cb2 Cs Cv1 Cw2
  Cw3 kappa sigmaNut. Keys are attached to the prompt only for types the
  question actually names. Build cost went 8.4 s → 10.5 s.
  These keys are used to TELL the model, never to tell the user a key is wrong:
  the extraction is a best effort (macro-generated families are missed), and a
  gap here would be indistinguishable from a real error there.
- **B — syntax check** (`checkDictSyntax`). Every proposed file is parsed by
  `foamDictionary` on a copy in /tmp before it can be applied, and the parser's
  own sentence is what the user sees: *"ill defined primitiveEntry starting at
  keyword 'type' on line 7 and ending at line 10"*. Shown in the chat block, in
  the confirm dialog, and in the wizard preflight. Caveat found while testing: a
  MISSING FINAL BRACE is tolerated by the parser, so this catches bad entries,
  not every malformed file.
  **The trap that cost the most here: any OpenFOAM binary aborts (exit 134,
  `fileName::stripInvalid`) when the working directory is the Windows-mounted
  path, because this user's home has a space in it.** Every WSL script that runs
  an OpenFOAM binary must `cd` to a Linux-side directory first — the index build
  already did, the syntax check did not, and every file came back "broken".
- **C — examples from the tutorials** (`foam-examples.ts`). When a question
  names a type, one real use is pulled from the installed tutorials: the
  SMALLEST file that mentions it, ±6/12 lines around the match, polyMesh and
  logs excluded. A question about `nutkWallFunction` gets
  `fluid/roomHeating/0/nut`, which is eight lines and shows the exact shape.
  Grep on purpose, not embeddings: a type name is a literal string, so exact
  matching is the correct tool rather than a weaker one.

Measured end to end on one question mentioning two types: examples 671 chars +
ground truth 325 tokens, whole request assembled in 936 ms.

`foamToC` does NOT expose linear solvers, smoothers or numerical schemes (GAMG,
symGaussSeidel, limitedLinear are all absent) — those tables only register when
a solver loads its libraries. The validator therefore abstains on fvSolution and
fvSchemes rather than guessing. The `TypeName` grep DOES see most of them, so a
softer existence check there is possible later; `limitedLinear` and its
macro-generated family would be false positives, so it was not switched on.

## 2e. Phase D — the example selector, shipped in v2

`src/lib/foam-retrieval.ts`. Ranks the whole tutorial corpus against the
question and keeps the best TWO chunks, capped at 1.500 characters: a better
choice at the same prompt cost, not a bigger payload. 20.030 chunks from 5.494
files, indexed in ~34 s and cached in `~/.wslgui-foam-corpus.json` (9,7 MB).
Built at startup after the index; until it is ready the copilot falls back to
the grep path from phase C.

**It is BM25, not embeddings, and that was a deliberate substitution.** Local
embeddings mean a 130 MB model plus onnxruntime's native binaries inside a Next
standalone bundle inside an asar — against an exe the user chose to keep at
87 MB, and against an app that needs no network today. The trade was measured
rather than assumed, and the measurement found something better than either
option:

- With technical wording the lexical selector is already right: `kEpsilon steady
  SIMPLE` → `incompressibleFluid/cylinder/system/fvSolution`, `blockMeshDict
  simpleGrading hex` → a real blockMeshDict.
- **In Italian it collapsed.** "come impongo una portata volumetrica
  all'ingresso" returned thermal-baffle files; "parete con funzione di parete"
  returned nothing. The corpus is English and identifiers; the user writes
  Italian, and no lexical scorer bridges that.
- A fixed IT→OpenFOAM glossary (~65 terms, in the module) fixed it: the same
  questions now return `0/U` of a duct case, `0/nut` files, and real
  blockMeshDicts. That is the cheap half of what a multilingual embedding model
  would buy.

So the remaining case for embeddings is phrasing the glossary does not
anticipate. If the logs show that happening on real questions, there is now
evidence for spending the 130 MB; until then there is not.

**Grounding helps a frontier model exactly as much as a small one** — the
question the user asked before funding this. gpt-4.1, without the slice:
`atmBoundaryLayerInletVelocity` (the 13 name) and `application simpleFoam;`
(does not exist on 14). With it: `atmosphericBoundaryLayerVelocity` and
`solver incompressibleFluid;` + `foamRun`. Same failures as gpt-oss-20b, so this
is not a capability gap that a bigger model closes. Test cost $0,011 on a key
the user lent and has revoked; it was passed per-request and never written into
the app's config.

## 2f. The Claude agent, inside the app — shipped in v2

The app now carries a SECOND assistant, next to FOAMy and deliberately unlike
it. FOAMy proposes a file and the user clicks Apply; Claude reads the case,
writes the files and runs OpenFOAM itself. Both stay.

**This replaced an earlier design, and the reason matters.** The first version
exposed the app over MCP so that Claude Code, running in a TERMINAL, could
drive it — the user pasted a `claude mcp add …` line from a panel in the
Dashboard settings. The user rejected it on 2026-09-01: the conversation lived
in a terminal instead of in the app. The direction is now inverted. The app
launches Claude Code itself, headless, and the chat is a panel. The setup panel
and the rendezvous file are gone; the tool server and its policy survived
unchanged, because those were never the part that was wrong.

**It runs on the user's SUBSCRIPTION, not an API key** — their explicit choice,
and the reason the API path was not reused: FOAMy already offers four providers
and a key, so a second key-based chat would be redundant and would bill for what
the plan already covers. `total_cost_usd` in the result event is therefore
informational, not a charge.

- **`src/lib/claude-cli.ts`** finds the binary, authenticates, and drives it.
  The Claude Code that ships with the desktop app lives under a VERSION-NAMED
  directory (`%APPDATA%\Claude\claude-code\2.1.247\claude.exe`), so the path
  changes with every update — the newest is picked, with a standalone install,
  `PATH` and `OFSTUDIO_CLAUDE_PATH` as fallbacks.
- **The launch flags are the design**, and three of them are load-bearing:
  `--tools ""` turns every built-in tool off; `--mcp-config` supplies ours;
  `--strict-mcp-config` is what stops the session inheriting the user's
  **claude.ai connectors** — without it a probe run came up holding eleven
  Google Drive tools. `--setting-sources ''` does the same for their settings
  files. Verified after the fact: `system/init` reports exactly the nine
  `mcp__openfoam__*` tools and nothing else.
- **One long-lived child per conversation**, spoken to over
  `--input-format stream-json`, so a turn is one round trip rather than a cold
  start. Model and effort are LAUNCH flags, so changing either restarts the
  process with `--resume <uuid>` — which is why session persistence is left on
  and why the app generates the session UUID itself.
- **`--effort` is the "reasoning" control** the user asked for (low → max), and
  it is sent only for models that accept it: Haiku 4.5 predates it and returns
  an error. `--model` takes aliases (`opus`/`sonnet`/`haiku`) rather than pinned
  ids, so the list does not go stale when a model is superseded.
- **Sign-in is driven from the panel.** `claude auth login --claudeai` opens the
  browser itself and prints the URL; when the browser is already signed in it
  completes on its own, otherwise it waits on stdin for the code, which the
  panel can send. No terminal at any point.
- **`src/lib/agent-policy.ts`** is the old `/api/mcp` route's policy, moved into
  a lib and unchanged in substance: addressed by case name through the UI's own
  validators, execution limited to the 156 commands this installation ships,
  every call logged. `/api/agent/tools` is now the thin HTTP surface;
  `/api/agent` is status, sign-in and the SSE conversation.
- **`src/components/claude-panel.tsx`** is laid out like Claude Desktop rather
  than like a chat widget: assistant text plain on the page, only the user's
  turn in a bubble, thinking and tool calls as collapsible rows in the flow, and
  the model and reasoning pickers INSIDE the composer. The Claude burst is drawn
  as SVG, not shipped as an asset.

Verified end to end against the live installation, in the dev server and from
the UI: a turn that read `claude_test/system/controlDict`; a turn that wrote
`controlDict`, validated it, ran `checkMesh` to exit 0 and then REFUSED to
delete `0.orig`, telling the user to do it in the app; and `foam_lookup`
rejecting `atmBoundaryLayerInletVelocity` with the OpenFOAM 14 name. The six
boundaries hold as before — `rm`, `mv`, `blockMesh; rm -rf /`, `../../escaped.txt`,
a `../../../etc` case name and an absolute write path are all refused.

**THE BINARY IS NOT WHERE IT LOOKS LIKE IT IS, AND THE TEST CONTEXT LIES.**
On this machine an ordinary process cannot see `%APPDATA%\Claude` at all:
`readdirSync` returns ENOENT, and a listing of `%APPDATA%` comes back with 77
entries instead of 79 — `Claude` and `gltest` simply are not in it. Confirmed
from three independent contexts: an agent shell sees them, a process launched
by Explorer does not, and a process created through WMI does not either. A
bounded walk of `AppData` (4 deep), `Program Files`, `Program Files (x86)` and
`.local` from the real session found NO reachable claude binary at all, while
`~/.claude/.credentials.json` does exist there.

The consequence for testing is the part worth remembering: **an agent shell may
run inside a sandbox with a different filesystem view, and anything it launches
inherits that view.** Every "the app finds Claude Code" result in this session
came from launching the app out of that shell, and every one of them was a
false positive — the user was right each time they said it still failed. To
test something that depends on the real filesystem, launch it the way the user
does: `explorer.exe <path>`, or `Invoke-CimMethod Win32_Process Create`. Then
read the answer out of the app's own HTTP API rather than the GUI.

So detection cannot rest on a guessed location. The panel now takes a PATH the
user can set (stored as `claude-agent-path`, sent with every request, tried
first and never answered from cache), the search covers the npm global install
and several other roots, and the "not found" screen tells the user to install
the CLI (`npm install -g @anthropic-ai/claude-code`, which lands in
`%APPDATA%
pm` — on PATH and readable by any process) instead of being a dead
end. Verified in the real session view: a bad path reports "there is no file at
that path", a reachable executable is accepted with `source: 'the path you
set'`.

**npm's shims cannot be spawned, and the PATH lookup finding them is not
enough.** `npm install -g @anthropic-ai/claude-code` puts `claude`,
`claude.cmd` and `claude.ps1` in `%APPDATA%
pm`, and `where claude` finds
them — but from Node, on this machine, they fail with ENOENT, **EINVAL** and
UNKNOWN respectively. The EINVAL is the fix for CVE-2024-27980: Node refuses to
spawn a `.cmd`/`.bat` without `shell: true`. The real binary is beside them at
`node_modules/@anthropic-ai/claude-code/bin/claude.exe`, so `resolveShim()`
treats a shim as a POINTER to the executable rather than as the executable, and
that npm path is now a first-class candidate. A `.cmd` is still runnable as a
last resort, through a shell with the path quoted — this user's profile has a
space in it. Verified end to end on the app launched FROM EXPLORER: detected as
`npm global install` 2.1.258, already signed in, and a turn that read
`controlDict` and ran `checkMesh` to exit 0.

**The server cannot be trusted to find claude.exe from its own environment.**
The panel reported "Claude Code was not found" on the packaged app while it sat
in the normal place, and the diagnostics said the search had found NO candidate
at all — not a slow probe, but a search looking somewhere else. It was never
reproduced: the same build, launched here as both `win-unpacked` and the
portable .exe, found it every time, which points at the environment the server
inherits on a particular launch (%APPDATA% differs, for instance, when the app
runs with different privileges). So the dependency was removed rather than
theorised about: `locateClaudeCode()` in `electron/main.js` resolves the path
with `app.getPath('appData')` — which asks Windows for the running user's
roaming folder instead of reading the variable — and passes it as
`OFSTUDIO_CLAUDE_PATH`. The server's own search stays as the fallback. Verified
on the portable build: `source: OFSTUDIO_CLAUDE_PATH`, and a full agent turn
through it. If it ever fails again, the panel now lists the paths tried WITH
the APPDATA / USERPROFILE / homedir the server saw, which settles it in one
look.

**Two things about testing the packaged app that cost time here:** it takes a
single-instance lock, so a second copy exits immediately and silently (a launch
that "does nothing" is usually this); and the portable stub DETACHES, so the
`[main]` log never reaches a terminal that launched it — find the server port
from the process tree instead (`node.exe` under `%TEMP%\...
esourcesin`).

**A failed search for the binary used to be permanent.** `findClaude()` cached
`null` on failure and returned it forever, so ONE slow probe — the first
`claude --version` runs moments after the portable stub has extracted 348 MB
into TEMP, with Defender scanning a binary it has never seen — left the app
insisting Claude Code was not installed for the rest of the run, with a "Look
again" button that re-read the same cached no. Now only a SUCCESS is cached, the
probe waits 60 s instead of 15, "Look again" sends `?refresh=1` which forces a
fresh search, and the reason each candidate failed is kept and shown in the
panel instead of being swallowed by `catch {}`. The panel also stops treating a
failed status REQUEST as a missing installation — they were the same branch, so
any 500 announced that Claude Code was not installed.

**Four traps found while building this, all fixed, all worth knowing:**

- **`Math.cos` output in JSX breaks hydration.** The Claude mark's rays were
  computed inline, and server and client serialise the same float differently
  (`9.74833395016046` against `…0160461`) — React reported a mismatch on every
  load. The geometry is now computed once at module scope with `.toFixed(3)`.
  Anything generated into an attribute needs the same treatment.
- **Two floating panels need ONE stacking order, and it cannot live in a
  className.** Both windows and both launchers were `z-[100]`, so DOM order
  decided: opening FOAMy left the Claude launcher sitting on top of its window,
  and the window you had just opened could sit behind the one you had not
  touched. `src/lib/floating-order.ts` now owns it — the two launchers share
  one constant depth, and a window takes the next value when it opens and on
  `onMouseDownCapture` (capture, so a control that stops the event still raises
  the window). Measured: launchers 100/100, FOAMy opened 101, Claude opened
  after 102, clicking FOAMy 103.
- **The whole app's toasts were invisible, in two independent ways, and had
  been from the start.** Ten components call sonner's `toast()`, and (a)
  sonner's `<Toaster />` was never mounted anywhere — the layout mounts the
  Radix one from `components/ui/toaster.tsx`, which is driven by a different
  `useToast()` hook — and (b) sonner does not inject its own stylesheet and
  nobody imported `sonner/dist/styles.css`, so even once mounted the toast was
  created at `opacity: 0`, translated 73 px down, and removed a few seconds
  later: present in the DOM, measurable, and never drawn. Both are fixed in
  `src/components/ui/sonner.tsx`, which must stay a CLIENT component. Measured
  afterwards: `data-mounted` false → true, `opacity` 0 → **1**, at (900, 623)
  on a 1280×720 viewport.
  Two lessons: this is why the Claude panel's sign-in failure looked like a
  dead button, so a message the user MUST see now also renders inside the panel;
  and a toast cannot be judged from a Browser-pane screenshot at all — the
  animation is over or not yet started at every moment you can capture, so
  measure `opacity` from a MutationObserver instead of looking.
- **The sign-in button existed only while signed OUT**, which is exactly when
  nobody is looking at it. Once signed in the panel never said who you were, and
  the only account control was a 9 px "Sign out" in the footer — the user
  reported it as "I cannot sign in, there are no buttons for it" while being
  signed in the whole time. There is now a persistent account control in the
  panel header (identity, plan, the Claude Code version found, and Sign in /
  Sign out), with a dot on the icon when signed out. State that only exists in
  one branch of a state machine is state the user cannot find.
- **A floating launcher can be placed off screen and never recover.** The
  position is set in a `useEffect` from `window.innerWidth`, which can still be
  0 — the button then sits at `x=-86`, present in the DOM and invisible. Both
  panels now refuse to place below a 100 px viewport, retry on a frame, and
  re-park on resize; dragging still writes `style.transform` directly. Measured
  afterwards on a 1280×720 viewport: FOAMy at (1194, 634), Claude at (1194,
  564), and ZERO overlap with any control of the New Case wizard — the Next
  button ends at x=1190, which is the collision §2f's predecessor had.
- **`execFileSync` in a route blocks the whole server**, the same lesson
  `wsl.ts` already carries. Probing the binary and the auth status is two
  process launches on every panel open, so both are `promisify(execFile)` now,
  with the install cached, the in-flight probe shared, and auth cached 15 s.
- **The desktop app does not leave credentials the CLI can read.** It injects
  them into the processes IT spawns (`CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH`,
  `ANTHROPIC_BASE_URL`), so a CLI launched by anything else reports
  `Not logged in` until `claude auth login` is run once on its own. That is why
  the panel has a sign-in step at all, and why `childEnv()` STRIPS every
  inherited `CLAUDE_CODE_*`, `CLAUDECODE` and `ANTHROPIC_*` variable: during
  development this app can itself be started from a Claude Code session, and an
  inherited `ANTHROPIC_API_KEY` would quietly bill the API for what the user
  asked to run on their subscription.

## 2g. The three changes of 2026-09-02

- **An UNRESTRICTED switch in the Claude panel.** Off by default, asked about
  before it goes on, remembered afterwards. On, `run_openfoam` stops being an
  allowlist and becomes a shell in the case directory: any command, pipes,
  redirects, chaining. The design point worth keeping: the mode travels in the
  tool server's ENVIRONMENT (`OFSTUDIO_AGENT_MODE`), never in tool arguments, so
  the model cannot grant it to itself — everything the model writes arrives as
  `args`. It is therefore a launch property of the agent process, and flipping
  the switch restarts that process with `--resume`, exactly like model and
  effort. The activity log tags those calls `[unrestricted]`. Verified with the
  same request in both modes: guarded refused `ls -la | wc -l` and fell back to
  `list_case_files`; unrestricted ran it and answered 9.

- **The icon lost the three dashes behind the trailing edge**
  (`electron/build/icon.ico`), so the artwork is symmetric. The method is the
  reusable part: each frame repaired ON ITS OWN, the dashes identified by
  geometry rather than coordinates — a short bright run, inside the airfoil's
  row band, starting at the trailing edge — and the removed pixels refilled by
  interpolating their nearest untouched neighbours above and below. Two attempts
  had to be thrown away first: filtering on brightness alone erased the right
  half of every streamline, and a global trailing-edge test missed the topmost
  dash because it starts in the same column as the tip, several rows higher.
  ALWAYS diff the result against the original frame by frame — that is what
  caught both. The 16 and 24 px frames are deliberately untouched: the dashes
  measure 62 against a background of 65 there, already dissolved, and touching
  them only damages streamlines.

- **The splash has a real percentage bar**, driven from the startup milestones
  in `electron/main.js` (30% waiting for the server, 72% server ready, 80%
  loading the interface, 97% dom-ready). It creeps between milestones but never
  past the next one, so a stall reads as a stall rather than as progress. Both
  the value and the label are monotonic, and that rule is load-bearing: the
  server is spawned BEFORE Electron is ready, so "waiting for the server" is
  reported before the window exists, and without it the first update from
  `createWindow()` rewound the text to "starting the server". Every phase is
  logged, which is how that bug was found — measured after the fix: window at
  130 ms, server at 789 ms, page loaded at 4.1 s.

  **What it cannot do is appear instantly on double-click.** About 28 seconds
  pass between the double-click and the first line of our code, while the NSIS
  portable stub deletes and re-extracts 348 MB into TEMP; no window can exist
  before the app has started. Only a distribution change removes that (an
  installer, or a zipped `win-unpacked`). Raised with the user on 2026-09-02 and
  left with them to decide.

## 2h. The 2026-09-02 round of fixes

- **A replaced child process must not touch the session it no longer owns.**
  Changing the model, the effort or the guarded/unrestricted switch stops the
  agent process and starts a new one immediately — and the OLD process's `exit`
  event arrives AFTER the new one is already running. Its handler nulled
  `session.child` and, seeing `busy`, reported "Claude Code stopped unexpectedly
  (exit 0)" — or "(exit null)", when the exit came from `kill()`, which is the
  bare `null` the user kept having to resend past. Both the `exit` and `error`
  handlers now begin with `if (session.child !== child) return;`. Reproduced
  before the fix (turn 1 at effort low, turn 2 at effort high → error) and
  verified after (ALPHA → BETA → GAMMA clean, then six consecutive turns clean).

  **This also explains "it says it already did that".** The turn failed in the
  UI while Claude Code had actually done the work, so on the user's resend the
  model said — correctly, from its side — that it had already done it. One bug,
  two symptoms.

- **Every dialog in the app was hidden behind the chat panels.** `alert-dialog`
  and `dialog` were at `z-50` while the floating panels start at 100, so any
  confirmation raised while FOAMy or Claude was open appeared underneath it —
  including FOAMy's "apply anyway?" and the dashboard's delete prompts. Both are
  now `z-[1000]`, under sonner's toasts at 2000. The guarded/unrestricted toggle
  no longer confirms at all: the user asked for a single click.

- **`compression: store` is not the answer to the 29-second portable startup**,
  and the numbers are in `electron/electron-builder.yml` so nobody tries it
  again: 29.3 s compressed against 26.2 s uncompressed, for 263 MB more .exe.
  The cost is the per-launch COPY into TEMP, not the decompression — only not
  extracting at all removes it (installer, or the win-unpacked folder: window at
  130 ms, interface at ~4 s).

## 2i. A startup that could not be diagnosed, and the half-unpacked folder

The user's folder build died on launch with "the backend server stopped
unexpectedly (exit code 1)". It was not reproducible here across four scenarios
(fresh extract, normal close and relaunch, second instance while the first ran,
extraction into a normal folder launched from Explorer), so the answer came from
looking at THEIR copy instead of guessing: `Desktop\OpenFOAMStudio-v2-folder`
held **75 files out of 1,700** and `resources/standalone` was empty. The
extraction had stopped after four per cent and never resumed. The .zip itself
was intact — 1,700 entries, `server.js` present, longest path 127 characters, so
no MAX_PATH involvement.

So the app was right to fail. What was wrong was that it could not say why, and
three things now fix that:

- **`checkInstallation()` runs before anything is spawned** and names the files
  that are missing — the server, the bundled node — and says that an unzip did
  not finish. Verified by emptying `resources/standalone` on a good copy.
- **A startup log**, truncated per run, at `%APPDATA%\openfoam-studio\startup.log`
  (the app's *package* name, not the product name). This matters because the
  portable stub DETACHES stdout: launching the .exe from a terminal shows
  nothing at all, so before this there was no way to inspect a failed start
  after the fact.
- **The server's last 12 lines go into the failure dialog**, instead of an exit
  code on its own.

One trap found while testing the fix: `app.quit()` before Electron is ready is
deferred far enough that the window still opens and sits on the splash behind
the message the user just dismissed. The installation check uses `app.exit(1)`.

Another, for whoever tests this next: the single-instance lock makes a stale
instance from an earlier test swallow the launch you are trying to observe
("Another instance is already running"), and the run looks like a pass. Kill
every `OpenFOAMStudio*` process before each attempt.

## 2j. Unrestricted mode stops at the Windows disk

Unrestricted mode runs its shell **in WSL**, and WSL mounts the Windows drives
at `/mnt/<letter>`. So "no limits" quietly included the user's documents and the
application's own program files — one `rm -rf /mnt/c/...` away. That is not what
anyone means by "let the agent work on my cases", so `checkUnrestrictedCommand()`
in `src/lib/agent-policy.ts` refuses any command mentioning `/mnt/`, the tool
description says so, and the unrestricted system prompt says so.

Verified on the packaged app: the model declines on its own from the tool
description, and when forced to call the tool anyway the POLICY refuses — which
is the half that matters, since the model's judgement is not a control. A plain
`ls -1 | head -3` still runs, so the mode is otherwise intact.

Two limits stated in the code and worth repeating: this reads the command as
text, so it stops an accident rather than a determined bypass (a path built in a
shell variable would pass); and everything inside WSL remains destroyable, which
is the whole point of the mode.

**What prompted it was a false alarm, and the transcripts are why it stayed
false.** The user's folder build lost `resources/standalone` and asked whether
the agent — which they had used in unrestricted mode to delete a case — could
have done it. Claude Code keeps per-session transcripts under
`~/.claude/projects/<encoded cwd>/`, and for this agent the cwd is
`%TEMP%\openfoam-studio-agent`, so every command it has ever run is on disk and
greppable. All 36 of them stayed inside `/home/.../run` and `/opt/openfoam14`;
none mentioned `/mnt/`. The three case deletions in that session were each
asked for explicitly, and `cavity` was re-copied from the tutorials at the
user's request immediately afterwards. **Read those transcripts before
attributing anything to the agent** — the answer took two minutes and would
otherwise have been a guess.

The disappearance of `resources/standalone` remains UNEXPLAINED. The timestamps
looked like a truncated unpack (folder created 14:47:24, last file 14:47:34,
against ~40 s for a full extraction here), but the user reports launching the
app successfully from that folder, which cannot happen without `server.js`, and
their machine extracts faster. Their account beats the inference. If it recurs,
`%APPDATA%\openfoam-studio\startup.log` (§2i) now says what was missing and
whether the app had been starting from there before.

## 2k. The MIT license, and the attribution that was missing

The user asked on 2026-09-02 for the project to be open source **with their name
on it**. Both halves are satisfied by an ordinary MIT license: the clause that
requires the copyright notice to survive in every copy IS the attribution, so no
custom or badgeware clause was needed — and any such clause would have cost the
project the "open source" label it was asked for.

`LICENSE` carries `Copyright (c) 2026 Tommaso Ferrara`. The name was then put
everywhere it has to be visible without reading the repo: `author` and
`license` in both package.json files (electron's said `"license": "private"`),
`copyright:` in `electron-builder.yml` — which is what fills LegalCopyright and
CompanyName in the .exe's Windows properties — the README, and a line in the
app's own footer.

**The find worth keeping: the packaged app shipped no dependency license text at
all.** Next compiles three.js, Radix, Recharts and the rest into its own
bundles, so their package directories, and the LICENSE files inside them, never
reach `resources/standalone` — `find` over the whole shipped tree returned zero.
Those licenses are all MIT/ISC/Apache-2.0 and every one of them requires its
notice to travel with the binary, so `THIRD-PARTY-NOTICES.md` is not a courtesy,
it is the only place that attribution exists. It is shipped through a new
`extraFiles` block, which puts it and `LICENSE.txt` NEXT TO the executable
rather than under `resources/` where nobody would find them. Verified on the
build: both are there, beside Electron's and Chromium's own.

Two things stated in the README because they will otherwise be asked:
**OpenFOAM's GPL does not reach this app** — it runs OpenFOAM as a separate
process through `wsl.exe`, links nothing and redistributes no part of it; and
**OPENFOAM is a registered trademark of OpenCFD Ltd**, so the disclaimer of
endorsement is there, and the product name is worth a look at their trademark
policy before the project gets any real visibility.

**Why this cannot be folded back into `v2.0.0`.** Those binaries were published
with no license file, which means all rights reserved — a different legal state,
not a detail. Re-tagging would also break the rule at the top of this file, that
the tag must build the shipped binaries. It goes out as a new version. It went out as
**v2.1.0** on 2026-09-02: bumped, rebuilt, both artifacts copied to `Working/`,
release notes in `Working/RELEASE-NOTES-v2.1.md`, tagged, pushed, and published
with both artifacts attached. GitHub now shows the repository as MIT.

One thing was checked before any of this and is settled: `.env` is tracked from
the very first commit, and it holds exactly one line, `NEXT_TELEMETRY_DISABLED=1`
— confirmed by the user on 2026-09-02. There is no key in the history to rotate.
Keep it that way: that file is committed AND copied into the .exe.

---

## 2l. The trade mark, and why the .exe is not signed

Two questions the user raised on 2026-09-02, once the project went open source.

**The product name probably needs OpenCFD's permission, and a request is
PENDING.** The OpenCFD trade mark policy has a clause saying third parties must
not incorporate the trade marks into the names of their goods or services
without a specific written agreement or licence. "OpenFOAM Studio" is exactly
that. Their guidelines reinforce it: for an extension to OpenFOAM they
explicitly discourage both `somethingFoam` names and "OpenFOAM Something" names,
and point instead at a distinct name of the project's own with OpenFOAM only as
a description. Two smaller things are also off: the policy forbids changing the
capitalisation of the mark (so `OpenFOAMStudio` closed up, and `openfoam-gui`
lowercase, are non-conforming forms), and the guidelines say project URLs should
not carry the name — though that passage sits in the section about software
DERIVED from the OpenFOAM source, which this app is not.

A request for written permission was sent to OpenCFD on 2026-09-02 through the
enquiries form on openfoam.com. The text is kept in
`Working/OpenCFD-trademark-request.md`. **No answer yet.** Two things to know
before following it up: the letter deliberately does NOT offer to rename — the
user cut that paragraph on the grounds that conceding before an objection gives
the position away — so if the answer is no, the rename is a second conversation
and the guidelines' preferred form is the place to start. And the strong
argument in the letter is factual, not apologetic: the app contains no OpenFOAM
code, redistributes none, and runs the user's own installation as a separate
process.

**What was already fixed.** The policy prescribes two statements VERBATIM — an
Acknowledgement of ownership and a Disclaimer of endorsement — and a paraphrase
does not satisfy it. Both are quoted exactly in the README and in
`THIRD-PARTY-NOTICES.md`, and the first reference carries `OPENFOAM®`. Also
worth remembering: the policy forbids describing oneself as an "OpenFOAM
developer" unless commissioned by OpenCFD — the permitted phrasing is a
developer USING OpenFOAM technology.

**Code signing was researched and dropped on cost.** Do not redo this research:

- The warning has two halves. Unsigned → "unknown publisher". Signed but new →
  SmartScreen still warns until reputation accumulates. **EV certificates stopped
  bypassing SmartScreen in 2024**, so paying more buys nothing here.
- **SignPath Foundation** is free for OSS and the project now qualifies on
  licence — but it signs only artifacts it can verify came from an AUTOMATED
  build of the repository, and this project builds locally on the user's
  machine. It would need a CI pipeline first. Its certificate is also issued to
  SignPath Foundation, so THEY would be the publisher, not the user.
- **Certum Open Source Code Signing**, $58, cloud HSM, no CI needed, publisher
  string `Open Source Developer, Tommaso Ferrara`. Validity is ONE YEAR — and
  from 2026-03-01 the industry ceiling is 460 days, so multi-year certificates
  no longer exist. Timestamped signatures stay valid after expiry, so the
  recurring cost buys the ability to publish NEW builds, not to keep old ones
  working.
- The user decided the recurring cost was not worth it. The README already tells
  users to click through SmartScreen. **Do not re-propose signing** unless they
  raise it.

---

## 2m. The 2026-09-03 round — shipped in v2.2.0

Five things the user asked for, in one session, released the same day as
v2.2.0.

- **The mesh toolbar resets on every reload.** The vertex numbers were read from
  `system/blockMeshDict` once and then kept in the scene, and the toggle reused
  whatever was already there — so after editing the dictionary and re-meshing,
  Reload replaced the geometry and left the numbers describing the vertices the
  case USED to have. Unfixable from the UI, too: pressing Vertices again only
  hid and re-showed the same stale sprites. Reload now disposes them instead of
  hiding them, which makes the next press re-read the file, and it puts
  wireframe and the axes back off with them. Switching case goes through the
  same helper. Measured before and after: wireframe/axes/vertices all on with
  20 labels, then all off with the count cleared.

- **The axes are a corner triad now** — three solid arrows with X, Y and Z on
  them, in a 96 px square at the bottom left, instead of an AxesHelper standing
  at the case origin and rescaled to the model on every fit. It has its own
  scene and an orthographic camera, and it takes the main camera's direction AND
  its up vector, so it follows a trackball roll rather than only the orbit.
  Two things worth keeping: solid geometry because a helper's lines are one
  pixel wide however the material is configured, and MeshBasicMaterial because
  that scene has no lights and wants none. **Every render now goes through one
  `drawFrame()`** — the on-demand path, the immediate path and the rAF loop that
  runs during a gesture — because a viewport or scissor left set on the renderer
  clips whatever is drawn next.

- **The command list is read from the installation** (`src/lib/foam-commands.ts`,
  `/api/commands?action=catalog`). This was asked as a question — are the
  commands in the sidebar the real ones? — and the answer was no. The sidebar
  rendered a hand-written table of 103 commands filtered by a hand-written
  `minVersion`; checked against the two installs on this machine, **56 of those
  103 do not exist there** (foamCalc, yPlusRAS, patchAverage and the rest of the
  pre-v5 post-processing utilities; cfMesh, which is a separate product; solver
  module names that were simply wrong — compressibleFluid, LagrangianDPM) while
  **108 installed executables were missing from it**.
  It now comes from `$FOAM_APPBIN`, the shell utilities in `$WM_PROJECT_DIR/bin`
  and `foamToC -solvers`: 233 entries on 14. Descriptions are the Description
  block of each command's own source header, and the categories are OpenFOAM's
  own directory taxonomy (`utilities/mesh/generation` → Mesh Generation), so
  neither can drift from the version being described. One WSL call, ~2 s, cached
  in `~/.wslgui-foam-commands.json` and invalidated with the bashrc. The static
  table in `openfoam-data.ts` survives as the fallback for those two seconds and
  for a machine with no WSL.
  **The find worth keeping: `bin/` holds a tombstone script for every superseded
  solver.** `simpleFoam` DOES exist on 13 and 14 — as a script whose whole job is
  to say it "has been superseded and replaced by the more general
  incompressibleFluid solver module". 37 of them. They are kept, struck through,
  in a Superseded category: typing simpleFoam is exactly the question that
  script answers. Solver modules are controlDict values rather than
  executables, so clicking one inserts `foamRun -solver <name>`.

- **A question about a command is answered installation → `-help` → web, and the
  answer says which** (`src/lib/foam-help.ts`, `src/lib/web-search.ts`). Both
  copilots knew which NAMES exist here — that is what §2c built — but nothing
  about the detail underneath one, so "what does this option do" was answered
  from memory, which for OpenFOAM means from v9/v10 and from ESI. Three tiers:
  the index and the catalogue; then the command's own `-help`, run in WSL and
  cached for the life of the process; then a web search, and only when the first
  two found nothing at all. Every finding carries its source, and both system
  prompts require the reply to carry that through — including saying when it is
  answering from its own training instead.
  FOAMy gets the findings attached to the message. The agent gets `foam_help` as
  a tenth tool. **The guarded prompt used to say the agent had "no web access",
  and that is no longer true**; it now names the one tool that reaches outside
  the machine and when it does.
  Measured on the PACKAGED build: `snappyHexMesh` and `checkMesh` resolve from
  index + `-help` with no web call, and that `-help` is what carries
  "-overwrite: Deprecated option, this is now default behaviour". `setExprFields`,
  which this Foundation build does not have, falls through to the web in ~3 s
  and returns three sources plus the installation's own "does not exist here,
  the closest names are…".
  Two limits that are deliberate and are in the code: **the web query is built
  from OpenFOAM identifiers, never from the user's sentence** — better results,
  and their question stays theirs — and **ESI's doc.openfoam.com is ranked below
  openfoam.org, cfd.direct and CFD Online and flagged as a different fork**,
  because it dominates the results for almost every OpenFOAM term while
  documenting syntax that is frequently invalid here. `/api/foam-index?action=help&name=X`
  exposes the chain so the tiers can be checked without going through a model.

- **`-overwrite` is gone from the quick command and from eight reference
  entries.** The user flagged `snappyHexMesh -overwrite`; checking it against the
  installs showed the flag is deprecated on 13 AND 14 — "Deprecated option, this
  is now default behaviour" in each binary's own `-help` — and that the same is
  true of createPatch, refineMesh, splitMeshRegions, collapseEdges,
  renumberMesh and autoPatch. Overwriting is the default now; `-noOverwrite` is
  the opt-out, and that is what the reference lists.

## 2n. The boundary-condition check — shipped in v2.2.1

Reported on the `combustor` case: **Validate BC invented thirteen errors per
field on a case that meshes and solves.** The fields address six of their nine
patches as `"splitter.*"`, and the scanner read a key as `[\w.]+` — so it saw
the name `splitter.`, matched nothing, flagged the entry, and flagged the six
patches it covers as missing.

**The survey is the fix**, and it is kept in the comment above
`stripFoamComments` in `wsl.ts`. What a boundaryField key can be:

| | |
|---|---|
| `"splitter.*"` | a quoted regular expression, anchored to the WHOLE patch name — `"wall"` must not match `outerWalls` |
| `splitter.*` | the same unquoted. OpenFOAM reads it literally and it matches nothing; resolved as a pattern here, because "no such patch" would be true and useless |
| `wall` / `walls` | a patch group. snappyHexMesh writes `inGroups` over SIX LINES and the old single-line regex never matched it; and a patch belongs to the group of its own type even when the boundary file lists none |
| `#include`, `#includeEtc` | directives standing where a key stands, previously parsed as a patch called "#include". Reported as not checked |
| `$internalField` | a macro used as a whole entry |
| `//`, `/* */` | comments — a commented-out block was read as real, and a brace inside one threw the brace counting for the rest of the file |
| `value uniform 0;` | a keyword with no block, where the old scanner desynchronised and misread everything after it |

Coverage follows **the order OpenFOAM itself uses**: exact name, then group,
then pattern, with the LAST pattern winning. That is why `splitterRear` keeps
the `fixedValue` of its own entry while its five neighbours take `noSlip` from
the pattern — the panel shows what the solver will do, not the first match
found.

Two more found while testing on the real case, both worth knowing:

- **A binary field cannot be scanned as text at all.** `format binary;` puts
  half a megabyte of raw bytes — braces and quotes included — between one patch
  entry and the next, and `0/thickness` lost every patch after the first blob.
  Those files go to `foamDictionary`, the OpenFOAM parser itself, in ONE WSL
  call for the whole case: `-keywords` for the key list, then one `-value` per
  key. Asking for the sub-dictionary itself would bring the 691 KB of data with
  it.
- **A multi-region case has one mesh per region.** The fallback search
  concatenated every region boundary file, so each region patches made every
  other region look as though its patches were missing. It now reports the case
  as multi-region and skips the patch check instead of producing nonsense.

Verified BOTH WAYS, which is the part that matters: `combustor` went from 13
false errors per field to **108 checks across 12 fields with zero errors**
(5.4 s, confirmed again on the packaged build), while a deliberately broken
field still reports a non-existent patch name, a pattern matching nothing, and
three patches left with no condition. The check did not simply get quieter.

The panel also stopped printing every note in red: "via the pattern",
on a patch a pattern covers correctly, is information — colouring it like an
error made a healthy case look broken at a glance.

## 2o. The Commands terminal — shipped in v2.3.0

Three things the user asked for, plus two bugs found underneath them.

- **Foreground output STREAMS now.** `executeCommandAsync` had always taken an
  `onLog` callback and nobody passed one, so a foreground command was invisible
  until it finished. `/api/commands` takes `stream: true` and answers
  newline-delimited JSON (`{t:"out",d}` / `{t:"end",…}` / `{t:"error",…}`); the
  panel reads the body with a ReadableStream reader and appends as it arrives.
- **The flush is on an 80 ms TIMER, not requestAnimationFrame.** rAF was the
  first attempt and is the trap the mesh viewer already documents (§5): it does
  not run while the window is hidden or occluded, so a minimised app buffered
  the whole run and painted it at the end — exactly what streaming exists to
  remove.
- **Colour is per LINE, not per block.** The block used to go entirely red on a
  non-zero exit — the banner as red as the error. It is neutral now, and
  `lineClass()` colours what it recognises: FOAM FATAL ERROR / FOAM Warning,
  the `Time = ` clock, the run `End`, the startup banner dimmed. Only the left
  border reflects the exit status. Above 3000 lines the per-line spans are
  dropped for plain text.
- **A background command no longer invents a log.** It used to get
  ` > log.<command> 2>&1` bolted on when it had no redirect, so `foamRun &`
  created a file the user had not named. It gets exactly what was written now,
  and the terminal SAYS the output is going nowhere so they can add one. The
  app's own background launches (Allrun, the `foamRun > log &` quick command)
  write their redirect explicitly and are unaffected.

**Two bugs found while testing the background path, both worth keeping:**

- **The worker wrote its PID AFTER sourcing the OpenFOAM bashrc.** That source
  costs ~2.6 s (measured), but the launcher polled for the pidfile only 2.0 s
  (20 × 0.1 s) — so the PID was never captured in time and a launched command
  was reported as failed to start. The worker writes the PID FIRST now, before
  the source; `exec` preserves it. Captured in ~0.2 s after that.
- **A replacement string is not literal text.** `String.replace` gives four
  sequences special meaning in the REPLACEMENT argument: a doubled dollar
  collapses to one, and a dollar followed by `&`, by a backtick, or by a single
  quote splices in the match, everything BEFORE it, and everything AFTER it.
  Both halves of that bit this project on
  2026-09-03 — first turning a scripted `echo $$` into `echo $` in wsl.ts (writing a
  dollar sign instead of the pid), then TRIPLING this very file when the
  paragraph describing it was inserted with `.replace()`. Use
  `.split(a).join(b)`, or an Edit, whenever the replacement text can contain a
  dollar sign — which includes any text about shell code.

The dead 8 s `setTimeout`/`verifyPid` block that `proc.on('close')` always beat
is gone; the close handler reports the captured PID directly.

**A background command SURVIVES closing the app, and it does not need the app
to keep WSL warm.** Measured properly after an earlier note here got it wrong:
launch `sleep 850 &` through the packaged server, `taskkill /F /T` the server
tree exactly as `killServer()` does, then touch WSL not at all for 120 s — the
process is still running and the distro was never restarted (uptime 390 s).
What keeps it alive is `wslhost.exe`, which belongs to the WSL service and not
to the app, so the taskkill never reaches it. The earlier wrong conclusion came
from a test that force-killed `wslhost` too; kill that and the detached process
dies even though the distro stays up — worth knowing, but NOT what closing the
app does. The real enders are `wsl --shutdown`, a Windows restart or
hibernation, or a genuinely long idle.

**A FOREGROUND command does die with the app**, and that was verified the same
way: `sleep 300` with no `&`, then the faithful taskkill, and it was gone while
the distro stayed up (uptime 43 s, no restart). It runs inside the `wsl.exe`
session the server opened, and that `wsl.exe` is a child of the server, so `/T`
reaches it. The background one has been moved into its own session by
`nohup setsid -f` before the app lets go. That is the whole difference.

## 2p. When the agent may run something — shipped in v2.3.1

Reported: asking the agent a plain question would set `foamRun` going. The
cause was an OMISSION, not a bad rule — both system prompts described what the
tools are and what the guard rails refuse, and neither said anything about
**when** to run. So "is this case ready?" and "run this case" arrived looking
much the same. The guarded prompt even ended with *"Long solves should be
started with background: true"*, which reads as encouragement rather than as
the method it was meant to be.

Both prompts now OPEN with the distinction, before anything else:

- reading is free and should be done freely — that is how it answers from the
  real case instead of from memory;
- `run_openfoam` changes the case on disk and can run for hours, so it is
  called only when the run itself was asked for;
- a question gets an answer, and when reading genuinely cannot settle it the
  agent says what it WOULD run and stops — offering is the answer;
- an instruction to run is an imperative, in whatever language the user writes
  in, and an ambiguous message is treated as a question;
- one go-ahead covers the run it was given for and nothing after it.

The unrestricted prompt carries the same block plus one line: it widens WHAT
may be run, not WHEN.

**Verified with three real agent turns against the live installation**, which
is the only way to test a prompt change — and in BOTH directions, because the
failure mode of this kind of fix is an agent that has gone inert:

| turn | mode | result |
|---|---|---|
| "is claude_test ready to run?" | guarded | `run_openfoam` **0 times** — case_info, list_case_files, read_case_file ×4, validate_case_files, then it reported what it found and ASKED whether to fix it |
| "run checkMesh and tell me the result" | guarded | `run_openfoam` **once**, with exactly `{command: "checkMesh"}` |
| "how many cells, which patches?" | unrestricted | `run_openfoam` **0 times** — read two files and answered |

About $0.05 per turn on the subscription. `/api/agent?action=status` says
whether the CLI is reachable and signed in, which is what to check before
blaming a prompt — and remember §2f: a detection result obtained from an agent
shell may be a false positive against what the user's own launch sees.

## 2q. The full audit of 2026-09-03/04 — UNCOMMITTED, awaiting review

The user asked for an exhaustive audit and repair pass over the whole project.
**Everything from it is sitting in the working tree, uncommitted**, because they
asked to inspect it before anything is committed — which suspends, for this round
only, the standing rule in §1 about committing every change.

`docs/audit-2026-09-03.md` is the full account: what was wrong, why, and how each
was verified. Do not re-derive it from the diff. The supporting evidence is in
`docs/frontend-audit.md`, `docs/frontend-audit-2.md` and
`docs/regression-review.md` — raw findings, not all of which were acted on, and
some of which were investigated and REFUTED. Read the audit doc first; the others
are working notes.

The five that matter most, because they change what this app is safe to do:

1. **The agent's guarded mode had a complete shell escape.** `Allrun` is an
   allowed command and `normalizeCommand()` runs it as `bash ./Allrun`, and the
   agent could also WRITE that file — so two permitted calls gave it arbitrary
   shell. §2f's claim that "`rm -rf` is not expressible" was false. It may now run
   those scripts but not write them.
2. **Command ARGUMENTS were never checked**, only `argv[0]`. Every OpenFOAM
   utility honours `-case <dir>`, so an allowlisted executable could be aimed at
   the Windows disk. `-case`, absolute paths and `..` are now refused in
   arguments. Deliberate consequence: `mapFields ../otherCase` is refused too —
   that is the confinement working, not a bug.
3. **`/api/agent/tools` was unauthenticated outside Electron.** An empty expected
   token skipped the check rather than failing it, and only `main.js` sets the
   variable. It fails closed now, and `src/lib/agent-token.ts` mints one when the
   environment does not supply it, so `npm run dev` is not a hole.
4. **Any web page could drive the API.** `<img src="…/api/wsl?action=killAll">`
   was enough to kill every solver. `src/middleware.ts` refuses `/api/*` when the
   browser labels the request cross-origin, and lets header-less non-browser
   callers (the MCP bridge, the §4 health check) through on purpose.
5. **A failed `cd` did not stop the command.** `cd <case> && <cmd>` where `<cmd>`
   starts with `foamSource()` groups as `(cd && source); command`, so a command
   aimed at a renamed case ran in the shell's default directory instead. In
   unrestricted mode that is the difference between an error and a loss.

**There are tests now** — there were none. `npm test`, 81 of them, on
`node --test` with Node's own TypeScript support: no framework, no build step,
no new dependency. They cover the input validators and the case generator. Two
real bugs were found *by writing them*. `npm run check` runs them alongside
typecheck and lint.

Everything was verified against the PACKAGED server, not the dev one (§4, and the
README's three traps) — including a real 5000-line log proving the `?tail=`
default is 100 again and not 1. What was NOT verified is the Electron
main-process work: server lifecycle, the signal handlers, `isAppUrl` and the
atomic config write are exercised only by launching the GUI, which a session
cannot do. That is the first thing to try by hand.

## 3. `claude_test`

A scratch case the user told me to create, at
`~/OpenFOAM/tommasoferrara-14/run/claude_test` in WSL: a copy of the
`incompressibleFluid/TJunction` tutorial with `blockMesh` already run. 3D,
6.300 triangles, 4 patches, 20 blockMeshDict vertices — it exercises the mesh
viewer far better than the 2D cases. Free to break; re-create it with a plain
`cp -r` from `/opt/openfoam14/tutorials/` if it gets wrecked.

## 4. Build, fast path

```
npm run electron:build                          # full, ~2.5 min
node scripts/build-electron.js --skip-build     # re-package only, skips next build
```

**TWO artifacts come out, and they go together everywhere:**

| | |
|---|---|
| `OpenFOAMStudio-v<version>-portable.exe` | one file, nothing to install. ~29 s to the window: the portable stub re-extracts the whole app into TEMP on every launch. |
| `OpenFOAMStudio-v<version>-folder.zip` | the same app as a folder. Unzip once, run `OpenFOAMStudio.exe` inside it, and nothing is ever extracted again — **window in ~130 ms**, interface at ~4 s. |

They are not alternatives and never ship apart: copy BOTH over `Working/`, and
attach BOTH to every release. `scripts/build-electron.js` fails the build if
either is missing, so this cannot be forgotten by accident. The user asked for
the pair on 2026-09-02, after the measurement below showed that the portable
format's startup cost cannot be fixed from inside the app.

The zip's launch is also the honest answer to "why is startup slow": it is the
same code, and the only difference is that nothing is unpacked at launch.

Nothing in this path re-does work, and it must stay that way:

- `prepare-resources.js` **mirrors** `.next/standalone` into
  `electron/resources/standalone` — copying only files whose size or mtime
  differ, restoring the mtime after each copy (otherwise every file looks newer
  than its source and the next run copies all ~1300 again), and deleting entries
  that no longer exist on the source side. That deletion is what stops stale
  hashed chunks from `.next/static` piling up inside the exe; it used to be
  handled by wiping the whole tree, which is the duplicated work that was
  removed. A normal rebuild reports something like
  `201 copied, 1143 unchanged, 2 removed`.
- **Four caches must never be deleted**: `.next/cache` (~167 MB, what makes
  `next build` incremental), `node_modules`, `electron/resources/bin/node.exe`
  (else a 70 MB Node download), and `AppData/Local/electron-builder/Cache`
  (Electron 31.7.7 + nsis).
- Stop `npm run dev` before building — dev and `next build` share `.next`. The
  exe also cannot be overwritten while the app is running, and the shell's own
  cwd locks a folder against renaming.

Verify a build by running the packaged server directly, never by launching the
GUI on the user's desktop:

```
cd dist-electron/win-unpacked/resources
PORT=3117 HOSTNAME=127.0.0.1 ./bin/node.exe standalone/server.js
curl http://127.0.0.1:3117/api/wsl?action=ping
```

Also grep the packed bundle under `win-unpacked/resources/standalone/.next` for
a string you just added, to prove the exe really carries the new code.

## 4b. Names, and how a release goes out

**The version in `package.json` is the only place a version is typed.
Everything else quotes it.** Agreed with the user on 2026-09-02, after finding
the same version written five different ways — tags with one, two and three
components, three shapes of release title, artifact names that had stopped
matching their tag, and notes files that matched nothing.

| | |
|---|---|
| `package.json` | `X.Y.Z` — semver, always three components, because npm accepts nothing else. Every one- or two-component name in this project was a hand-made divergence from it. |
| tag | `vX.Y.Z` |
| release title | `OpenFOAM Studio vX.Y.Z — <what changed>` — the product name because titles travel out of context, and a subtitle that says what is NEW. The v1 line used `Standalone (WSL2)` five times, which distinguishes nothing. |
| artifacts | `OpenFOAMStudio-vX.Y.Z-{portable.exe,folder.zip}`, generated from `${version}` |
| release notes | `docs/releases/vX.Y.Z.md`, in the repo |

Publishing, in order:

```
npm run electron:build
npm run release:check vX.Y.Z          # or with the tag already on HEAD
gh release create vX.Y.Z dist-electron/OpenFOAMStudio-vX.Y.Z-portable.exe   dist-electron/OpenFOAMStudio-vX.Y.Z-folder.zip   --title "OpenFOAM Studio vX.Y.Z — <what changed>"   --notes-file docs/releases/vX.Y.Z.md
```

`scripts/check-release.js` is the guard: it compares the tag against
`package.json`, checks the three version fields agree with each other, and
refuses if either artifact or the notes file is missing. It exists because the
drift it catches already happened once — see the filename trap in §5.

**The old tags were left alone.** `v1` … `v1.4` predate the three-component
rule and are published URLs; rewriting them would break links for the sake of
tidiness. Their TITLES were realigned on 2026-09-02, which is safe because a
title is not an address, and `docs/releases/README.md` carries the mapping from
the canonical filenames to the tags as they were actually published.

---

## 5. Traps that have already cost time

- **The three packaged-app-only traps are documented in the README** ("Three
  traps to know about") — native modals, `windowsHide: true`, and the port that
  changes every launch. The rule they share: never validate focus-, process- or
  persistence-related work from the dev server alone. If a fourth one turns up,
  add it there, not here.
- **The in-app Browser pane lies in several ways**: its console buffer survives
  navigation, it does not run `requestAnimationFrame` while hidden (so anything
  animated or damped cannot be judged by eye — drive `controls.update()` from
  `javascript_tool` and read numbers instead), Radix ignores synthetic events,
  and a pane left idle silently stops delivering clicks until the tab is closed
  and reopened.
- **Next's file tracer will copy the WHOLE project into `.next/standalone`,
  and the .exe triples in size.** `src/lib/claude-cli.ts` hunts for an
  executable across several directories, so it is full of paths the tracer
  cannot resolve statically; when that happens the tracer stops reasoning and
  takes the entire tracing root. The standalone went 26 MB → 533 MB, carrying
  `screenshots/`, `electron/` (with the 70 MB bundled node.exe) and
  `dist-electron/` — the previous .exe packed inside the new one, 87 MB → 268 MB.
  It also COMPOUNDS: `electron/resources/standalone` is inside the root, so the
  next build copies the previous copy; one more build reached **1.7 GB**.
  The fix is the `outputFileTracingExcludes` list in `next.config.ts`
  (`dist-electron`, `electron`, `screenshots`) — swapping `join(process.cwd(),…)`
  for `resolve(…)` did NOT help, which is worth knowing before trying it again.
  The same list is also what keeps DEVELOPMENT files out of a user's copy: the
  tracer sweeps up whatever sits in the root, so `HANDOFF.md`, `AGENTS.md`,
  `CLAUDE.md`, the eslint/postcss/tsconfig files and `components.json` were all
  riding inside the .exe until 2026-09-02. They are excluded by name now.
  `LICENSE`, `README.md` and `THIRD-PARTY-NOTICES.md` deliberately stay — they
  belong with the binary. Two useful consequences: `prepare-resources.js`
  deletes what the exclusion removed on the next build (it reported
  `9 removed`), and HANDOFF is no longer packaged, so editing THIS file no
  longer changes the artifacts. Anything excluded here must be proven not to be
  a runtime dependency: verify with the packaged-server run below, not by
  reasoning about it. That run answered `{"running":true,...}` after the change.

  **Check the reported size on every build**: `build-electron.js` prints it, and
  87 MB is the number. A build whose log ends
  `SUCCESS: server.js at .next\standalone\electron\resources\standalone\server.js`
  — a NESTED path — has already been swallowed.
- **A version bump is three fields plus three strings**, because the artifact
  names derive themselves: `version` in `package.json` and in
  `electron/package.json`, and the two top-level fields of `package-lock.json` —
  lines 3 and 9 only; the same string further down belongs to dependencies, and
  a blanket replace corrupts the lock. Written by hand: the README's two
  download filenames in the Install table AND its `Expand-Archive` line, plus
  the version placeholder in `.github/ISSUE_TEMPLATE/bug_report.yml` and the
  manifest example in the comment at the top of `electron-builder.yml`.
  Everything else derives itself, and `npm run release:check` refuses the
  release if any of it disagrees — it reads the README for a stale filename
  now, which it did not do before 2026-09-03.
  `electron/package-lock.json` carries the same two fields and is NOT on the
  list: it is gitignored and electron-builder regenerates it from
  `electron/package.json` on every build, so it corrects itself. release:check
  reports a stale one as a nuisance rather than a blocker, and tolerates its
  absence on a fresh clone.
  The source folder used to carry the version too — it was
  `Working/OpenFOAMStudio_v2.1-source` for about an hour — and it does not any
  more, on purpose: it is a checkout, not an artifact, git already knows the
  version, and renaming it every release also meant editing
  `Working/.claude/launch.json`, which names it in its `--prefix`. Two manual
  steps removed. It is plain `Working/OpenFOAMStudio-source` now.
  The README's badges and its top download link are deliberately
  version-agnostic — they read `/releases/latest` and the shields API — so they
  are NOT on this list. Leave them alone; "updating" them is how they would
  start going stale.
- **The filenames carry the FULL version, and they are generated — keep it
  that way.** `artifactName` in `electron-builder.yml` uses `${version}`, and
  `scripts/build-electron.js` reads the same field out of
  `electron/package.json` to know what to check for. Neither may be
  hard-coded again. **This is written from the mistake**: they used to say
  `OpenFOAMStudio-v2-…`, carrying the major only, and it was reasoned about as
  a feature — "a minor bump does not touch the filenames". So v2.1.0 was
  published with files named exactly like the v2.0.0 files already attached to
  the previous release, and the release notes went as far as explaining to the
  user how to tell two identically named downloads apart. The user caught it.
  A filename is how someone tells two downloads apart; it carries the whole
  version or it is wrong.
- **Declined by the user, do not re-propose**: auto-hiding `empty`/`wedge`
  patches in the mesh viewer, even though they are 91–99.95% of their cases.

## 5b. The screenshots

`screenshots/` holds eight PNGs and an .mp4 screen recording. An `.mkv`
duplicate of that recording, 11 MB and referenced by nothing, was removed on
2026-09-02. Every file in the directory is referenced by the README; keep it
that way, and check for orphans after any change.

**The set is complete.** The two features that distinguish the project had no
picture until 2026-09-02: the Claude panel went in as `claude-agent.png`, and
the Mesh tab as `mesh.png` — the boundary mesh of the T-junction in
`claude_test`, which is the case that shows the viewer off far better than the
2D ones (§3).

**Screenshots cannot be produced from a session, so any future one is the
user's to take.** The Browser pane caps out
around 800 px wide, below the existing images, and a pane capture cannot be
written to a file at all. An image pasted into the conversation cannot be
written to a file either — only one already saved on disk can be picked up, so
look in `Pictures/Screenshots/`, or have the user commit it from the GitHub web
UI and pull it, which is how `mesh.png` arrived. There is also no ffmpeg on the
machine, so the .mp4 cannot be turned into a GIF here.

---

## 5c. How the repository presents itself

Done on 2026-09-02, when the project became something a stranger might land on.
GitHub's community score went 42% to 100%. What is there and why:

- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, and
  `.github/` with two issue forms, a chooser config and a PR template.
- **The bug form is the load-bearing one.** It requires which download was used,
  the app version, the OpenFOAM version, the WSL distribution and
  `startup.log` — the four things every past bug needed and none of which a
  reporter would think to send unprompted. If a class of bug turns out to need
  something else, add the field there rather than asking each time.
- `SECURITY.md` points at GitHub's **private vulnerability reporting**, which is
  enabled on the repo, so no personal email is published. It puts the agent's
  unrestricted mode and `validateRelativePath` explicitly in scope, and states
  the known limit of the `/mnt/` check (§2j) so nobody reports it as news.
- The chooser sends OpenFOAM questions to CFD Online, keeping issues about
  the app.
- Wiki and Projects are OFF — they were empty tabs, which reads as abandonment.
  Issues and Discussions are on, and the chooser links to Discussions.
- The README opens with badges that read `/releases/latest` and the shields API,
  so they follow each release on their own (§5). Images sit beside the bullets
  they illustrate rather than in a gallery nobody opened.
- `HANDOFF.md` moved to `docs/` so the root reads as a project. It is excluded
  from the packaged app along with the rest of `docs/` (§5, the tracing trap).

---

## 6. Files that are not ours

`AGENTS.md` and `CLAUDE.md` in this folder are generated by `next dev` (the
Next.js agent-rules block) and are gitignored — they carry no project state, and
anything written there is overwritten on the next dev run.
**The block itself tells you to commit it** ("committing it with your work keeps
the tree clean"). Do not: both names are in `.gitignore`, `git status` is clean
with them present, and `next dev` only rewrites them when the current block is
MISSING, so nothing is churning. Checked on 2026-09-03 — this is the answer, not
an oversight. `Working/.claude/
launch.json`, one level up, is the Browser pane's dev-server config; it lives
outside the repo on purpose. It hard-codes the source folder's name as its
`npm --prefix`, so renaming that folder silently stops the dev server — nothing
in the repo can catch it for you. A version bump no longer renames it (§5).
