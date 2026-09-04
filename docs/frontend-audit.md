STATUS: in progress — last file audited: chat-popup.tsx

# OpenFOAM Studio — frontend audit

Read-only analysis. No source file was modified.
Findings are appended per source file as each is finished; severity ordering is
applied in the summary at the end, not within each section.

---

## src/components/openfoam/command-panel.tsx

CRITICAL — src/components/openfoam/command-panel.tsx:424 — terminal transcript grows without any cap
scenario: The user runs `foamRun` (not backgrounded) from the Commands terminal on a case that
prints for hours. Every chunk lands in `updated[i] = { ...updated[i], output: updated[i].output + chunk }`.
Nothing anywhere trims `HistoryEntry.output`, and nothing trims `term.lines`. `MAX_COLOURED_LINES`
(line 92) only switches the RENDERING from per-line `<span>`s to one text node — the string itself
is untouched. After a few hundred MB of solver output the renderer process is holding the whole
log as a JS string, and every 80 ms flush copies it (`output + chunk` allocates a new string of the
full length), so the app first goes quadratic-slow and then dies with an out-of-memory crash.
This is the single worst unbounded-memory site in the frontend.
fix: Cap the retained output in the flush at line 420-427. Keep a constant, e.g.
`const MAX_OUTPUT_CHARS = 2_000_000;` and in the setter do
`const merged = updated[i].output + chunk;`
`const body = merged.length > MAX_OUTPUT_CHARS ? '…[earlier output trimmed]\n' + merged.slice(-MAX_OUTPUT_CHARS) : merged;`
then `updated[i] = { ...updated[i], output: body }`. Apply the same trim to the `finalOutput`
branch at line 498. Optionally also cap `term.lines` to the last ~200 entries in the reducer at
line 404-411.

HIGH — src/components/openfoam/command-panel.tsx:448-481 — the streaming reader is never cancelled, so a running command leaks its whole stream on case switch
scenario: `page.tsx:302` mounts `<CommandPanel key={selectedCase} …>`. The user starts a long
`blockMesh`/`foamRun` in the terminal, then clicks another case in the Dashboard. React unmounts
this CommandPanel, but the `for(;;) await reader.read()` loop in `executeCommand` keeps running:
there is no `AbortController` on the `fetch` at line 436 and no `reader.cancel()` in a cleanup.
The loop keeps decoding and keeps calling `setTerm` on a dead component, so the entire remaining
output of the run is retained in memory (referenced by the closure) until the process exits, and
the HTTP connection to the bundled server stays open. Switch cases a few times during long runs
and you accumulate one orphaned stream per switch.
fix: Create `const ac = new AbortController()` in `executeCommand`, pass `signal: ac.signal` to the
fetch at line 436, store it in a `runAbortRef`, and add
`useEffect(() => () => runAbortRef.current?.abort(), [])` next to the flush cleanup at line 332.
Also break out of the read loop when the ref has been aborted.

MEDIUM — src/components/openfoam/command-panel.tsx:694-708 — a terminal resize drag interrupted by unmount leaves the whole app unselectable
scenario: The user presses the mouse on the terminal resize strip (line 685) and, while still
holding the button, the panel unmounts — clicking a different case in the Dashboard from a
keyboard shortcut, or the panel being re-keyed. `mouseup` then fires on a document that no longer
has the React tree, but the listeners added at 707-708 are attached to `document` and were only
ever removed inside `onUp`. They stay attached for the life of the page, and `document.body.style.cursor`
stays `ns-resize` with `document.body.style.userSelect = 'none'` — the user can no longer select
text anywhere in the app, and every mousemove keeps calling `setTermHeight` on a dead component.
fix: Move the drag to a `useEffect`-managed listener pair keyed off a `resizing` state, or add a
component-unmount cleanup that removes `onMove`/`onUp` and resets `document.body.style.cursor`
and `.userSelect`. Keep refs to the two handlers so the cleanup can remove them.

MEDIUM — src/components/openfoam/command-panel.tsx:278-290 — case-info fetch is not cancelled, so Allrun/Allclean buttons can belong to the wrong case
scenario: `checkScripts()` has no `cancelled` guard (unlike the two effects above it at 195 and
241). The user clicks case A (which has an Allrun) then quickly clicks case B (which does not).
Because the panel is keyed by case it remounts, but if the WSL round-trip for A is slow the panel
for B can still be alive when A's response lands only when the key does not change — and it does
not change when `selectedCase` goes from `''` to a name and back. Result: `hasAllrun` is true for
a case with no Allrun; pressing it runs `./Allrun > log.Allrun 2>&1 &` which fails silently in the
background with no log to look at.
fix: Add the same `let cancelled = false; … return () => { cancelled = true; }` guard used at
lines 195-225, and check it before `setHasAllrun`/`setHasAllclean`.

MEDIUM — src/components/openfoam/command-panel.tsx:543 — "Allrun" reports "Command completed" for a job that has not started
scenario: `runAllrun` fires `./Allrun > log.Allrun 2>&1 &`. The `&` makes the shell return
immediately with exit 0, so `executeCommand` reaches line 503 and shows the green toast
"Command completed" while the solver has not produced a single line yet. The user then lands on
the Monitor (`onScriptStarted`) with an empty log dropdown and a "Command completed" toast still
on screen, and reasonably concludes the run finished instantly.
fix: In `runAllrun`, suppress the generic toast for this path — e.g. give `executeCommand` an
options argument `{ quiet: true }` that skips lines 503-504 — and replace it with
`toast.info('Allrun started in the background — follow it in the Monitor')`.

LOW — src/components/openfoam/command-panel.tsx:507-512 — the error path writes to index -1 when the transcript is empty
scenario: If `setTerm` at 404 has not yet committed (an exception thrown synchronously in the same
tick, or the entry was cleared by the Clear button mid-flight), `updated.length` is 0 and
`updated[updated.length - 1] = { ...last, … }` assigns to the property `"-1"` on the array. The
error message is then invisible: the user sees the command vanish with only the
"Error communicating with WSL" toast and no transcript entry.
fix: Guard exactly as the success path does at 494: `const i = updated.length - 1; if (i < 0) return prev;`

LOW — src/components/openfoam/command-panel.tsx:800 — the send button is icon-only with no accessible name
scenario: A screen-reader user tabs to the terminal's submit control and hears only "button".
`<Button …><Send className="w-3 h-3" /></Button>` has no text, no `title` and no `aria-label`.
fix: Add `aria-label="Run command"` (and a matching `title`) to the Button at line 800.

---

## src/components/openfoam/monitor.tsx

HIGH — src/components/openfoam/monitor.tsx:934 — the residual-chart tooltip has no background because the CSS tokens are oklch, not HSL triplets
scenario: `contentStyle={{ backgroundColor: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))' }}`.
`globals.css:52` defines `--popover: oklch(1 0 0)` — a complete colour, not the `H S% L%` triplet
that the `hsl(var(--x))` idiom requires. The browser resolves this to `hsl(oklch(1 0 0))`, which is
invalid and silently dropped, so the tooltip renders with no background and no border. Hover any
curve on the residual plot in dark mode and the numbers sit directly on top of the grid and the
curves, unreadable.
fix: Use the tokens directly: `backgroundColor: 'var(--popover)', color: 'var(--popover-foreground)',
border: '1px solid var(--border)'`. Same for any other `hsl(var(--…))` added later — this codebase's
tokens are oklch values, never triplets.

MEDIUM — src/components/openfoam/monitor.tsx:615 — the "running" status bar uses a near-black green in light mode
scenario: `className={... isRunning ? 'border-green-500/50 bg-green-950/20' : ...}`. `green-950` is
the darkest green in the scale, intended for dark backgrounds. In light mode (the app's
`defaultTheme` is `light`, layout.tsx:47) a running case paints the status card with a dark
olive wash behind dark text — muddy, and inconsistent with every other card on the page.
fix: Make it theme-aware: `bg-green-50 dark:bg-green-950/20`. The identical mistake is at
dashboard.tsx:398 (`bg-green-950/20` / `bg-red-950/20`) and dashboard.tsx:753 (`bg-amber-950/20`).

MEDIUM — src/components/openfoam/monitor.tsx:104-107, 944 — chart colours hard-coded as hex instead of the theme's chart tokens
scenario: `RESIDUAL_COLORS` is ten raw hex strings and the convergence reference line is
`stroke="#22c55e"` / `fill: '#22c55e'`. `globals.css:66-70` and `:100-104` define `--chart-1`…`--chart-5`
with *different* values per theme precisely so charts follow the theme; the residual plot ignores
them, so in light mode the palette is the dark-mode palette and vice versa, and the plot is the
only chart in the app that does not shift with the theme.
fix: Either drive the series from `var(--chart-1)`…`var(--chart-5)` (read once via
`getComputedStyle(document.documentElement)`), or at minimum extend globals.css with
`--residual-1`…`--residual-10` per theme and reference those. The `ReferenceLine` at 944 should use
`var(--chart-2)` or a dedicated `--convergence` token.

MEDIUM — src/components/openfoam/monitor.tsx:552-561 — switching log files can leave the previous log's text on screen
scenario: The user selects `foamRun` in the Log Viewer dropdown while the 1 Hz poll for `blockMesh`
is still in flight. The effect sets `logContent` to `''` and calls `fetchLogs()`, which returns
immediately at line 317 because `fetchingLogsRef.current` is still `true`. The in-flight request
for `blockMesh` then resolves and calls `setLogContent(blockMesh content)` — the header badge says
`log.foamRun`, the body shows `log.blockMesh`, and `simTime`/`lastResidualLine` above are computed
from the wrong file until the next tick.
fix: Tag each fetch with the log it was for. In `fetchLogs`, capture `const forLog = selectedLog`
before the await and ignore the response when `forLog !== selectedLogRef.current`; keep a
`selectedLogRef` updated in an effect. Drop the early return in favour of aborting the previous
request with an AbortController.

MEDIUM — src/components/openfoam/monitor.tsx:460-468 — the elapsed-time effect re-runs on every render
scenario: `caseProcesses` (line 452) is a fresh array on every render, and the process poll
re-renders the component once a second, so this effect's dependency array never compares equal.
Every render calls `syncElapsedFromProcesses`, which is cheap only because of the internal 30 s
guard — but the same pattern also means the `isRunning ? … : reset` branch runs constantly.
Combined with the 250 ms/1 s timer effect at 471-485, the Monitor re-renders far more than it needs
to while a solve is running, which is exactly when the tab is heaviest.
fix: Depend on stable primitives: `useMemo` the `caseProcesses` array, or pass only what is used —
`const firstEtimes = caseProcesses[0]?.etimes;` and depend on `[isRunning, firstEtimes, syncElapsedFromProcesses]`.

MEDIUM — src/components/openfoam/monitor.tsx:373-390 — killing a PID optimistically removes it and the 1 Hz poll immediately puts it back
scenario: The user clicks Kill on a process. `setProcesses(prev => prev.filter(...))` removes the
row instantly, but the process-list poll (line 500) fires up to a second later and reinstates the
row from the server while the SIGKILL is still propagating. The row flickers out and back in, and
because `killingPid` was already reset to `null` at line 389 the Kill button is enabled again on a
row the user believes they already killed.
fix: Keep a `Set` of PIDs killed in the last ~3 s in a ref and filter them out of the rendered list
until the server also stops reporting them, or simply do not remove optimistically and instead show
the row disabled with a spinner until it disappears from a poll.

LOW — src/components/openfoam/monitor.tsx:380 — a user-facing string is in Italian
scenario: Killing a process shows `PID 1234 killato (SIGKILL)`; every other message in the panel is
English. The user sees one Italian toast among English ones.
fix: `toast.success(\`PID ${pid} killed (SIGKILL)\`)`.

LOW — src/components/openfoam/monitor.tsx:731 — the process-table refresh button has no accessible name
scenario: `<Button size="sm" variant="ghost" onClick={fetchProcesses}><RefreshCw /></Button>` —
icon only, no `title`, no `aria-label`. A screen reader announces "button"; a sighted user gets no
tooltip either, unlike the identically-shaped buttons elsewhere in the file.
fix: Add `aria-label="Refresh process list"` and `title="Refresh process list"`.

LOW — src/components/openfoam/monitor.tsx:625-628 — the process-count badge prints the same word for singular and plural
scenario: `{caseProcesses.length === 1 ? 'of case' : 'of case'}` — both branches are identical, so
the ternary is dead code and the badge always reads e.g. "1 proc of case".
fix: Delete the ternary and write the label once, or make it `proc{n === 1 ? '' : 's'} in this case`.

LOW — src/components/openfoam/monitor.tsx:683-687 — "Clean TS" does not say what it deletes
scenario: A destructive button labelled `Clean TS` sits next to the timestep list. Its `title`
explains it, but the visible label is an abbreviation the user has to hover to decode. (The
confirmation at line 235 is present and correct, so the risk is confusion, not data loss.)
fix: Label it `Delete timesteps` — there is room in that row, and the same action in the File
Editor (file-editor.tsx:611) uses the same opaque abbreviation.

---

## src/app/globals.css

(No standalone defects. It is the reference for the token findings above:
`--popover`, `--border`, `--chart-1..5` are all authored in `oklch()`, which is why the
`hsl(var(--…))` at monitor.tsx:934 cannot work.)

---

## src/components/openfoam/mesh-viewer.tsx

CRITICAL — src/components/openfoam/mesh-viewer.tsx:627 — the WebGL context is never explicitly lost, so ~16 case switches kill the 3D viewer
scenario: `page.tsx:312` renders `<MeshViewer key={selectedCase || 'none'} …>`. Every time the user
selects a different case the component UNMOUNTS and a new one mounts, creating a brand-new
`THREE.WebGLRenderer` at line 494. The cleanup calls `renderer.dispose()` (line 627) but never
`renderer.forceContextLoss()` — `dispose()` releases three's own GPU objects, it does NOT release
the browser's WebGL context, which lingers until GC decides to collect the canvas. Chromium's hard
limit is ~16 live contexts; past that it silently drops the OLDEST ones. Concretely: open the Mesh
tab, then switch between cases ~16 times (a normal afternoon of comparing variants). The viewer for
the current case goes black or logs "THREE.WebGLRenderer: Context Lost", and pressing Load mesh no
longer draws anything until the whole app is restarted. `grep -rn forceContextLoss src electron`
returns nothing.
fix: In the cleanup at line 609-630, before `renderer.dispose()` add
`renderer.forceContextLoss();` and after removing the canvas set `renderer.domElement.width =
renderer.domElement.height = 0;`. Also dispose the render targets: `renderer.dispose()` alone is
not enough here because the component is remounted, not reused.

HIGH — src/components/openfoam/mesh-viewer.tsx:616-624 — vertex-label textures are leaked on unmount
scenario: The unmount cleanup traverses `group` and `labels` and disposes geometries and materials,
but never `material.map`. The label sprites created by `makeLabelSprite` (line 156) each own a
`THREE.CanvasTexture`. `clearVertexLabels` (line 702-712) disposes them correctly; the unmount path
does not. A `blockMeshDict` with 200 vertices means 200 canvas textures that survive the unmount,
and they are re-created from scratch on the next mount. Combined with the missing
`forceContextLoss` above, each case switch with labels on leaves a full set of textures pinned to
an abandoned context.
fix: In the traversal at 617-623, mirror what `clearVertexLabels` does:
`const mat = m.material; const mats = Array.isArray(mat) ? mat : [mat]; for (const x of mats) { (x as THREE.Material & {map?: THREE.Texture}).map?.dispose(); x?.dispose(); }`

HIGH — src/components/openfoam/mesh-viewer.tsx:737-799 — a slow mesh load applied after a case switch shows the wrong case's geometry
scenario: `loadMesh` has no cancellation token and no case check after its awaits. The user presses
"Load mesh" on a large case A, and while the server is still extracting the boundary (this takes
seconds to tens of seconds) clicks case B in the Dashboard. The reset effect at line 942 clears
`patches`/`hasMesh` for B, then A's response resolves: line 795-799 sets `patches`, `triangles`,
`hasMesh = true` and toasts "N triangles, M patches". The Mesh tab now shows case A's geometry with
case B's name in the header, and pressing Reload silently replaces it — the user has no way to know
which mesh they were looking at. Note the `confirmDialog` at 752 makes the window even wider.
fix: Capture the case at entry and bail after every await:
`const forCase = caseName;` … after `await res.arrayBuffer()` and after the confirm,
`if (forCase !== caseNameRef.current) return;` with a `caseNameRef` kept current by an effect.
Better still, add an `AbortController` stored in a ref, aborted both by the reset effect at 942 and
by the unmount cleanup.

MEDIUM — src/components/openfoam/mesh-viewer.tsx:1075-1085 — the viewer resize handle is a div and cannot be used from the keyboard
scenario: The only way to change the 3D viewport height is to drag a `<div>` with pointer handlers,
or double-click it to reset. It has no `role`, no `tabIndex`, no keyboard handler, and no accessible
name (the `title` is on a non-focusable element so it is never announced). A keyboard-only user
cannot resize the viewer at all.
fix: Make it `role="separator" aria-orientation="horizontal" aria-label="Resize the 3D view"
tabIndex={0}` and handle `ArrowUp`/`ArrowDown` (±24 px) plus `Home` to reset to
`DEFAULT_VIEWER_HEIGHT` in `onKeyDown`.

MEDIUM — src/components/openfoam/mesh-viewer.tsx:1040-1054 — patch visibility is conveyed by opacity plus a colour swatch, with no text state
scenario: A hidden patch is rendered as the same button at `opacity-40`. For a user with low vision
or on a bright screen, 40 % vs 100 % opacity on an 11 px monospace label is not a reliable signal,
and the only other cue is the Eye/EyeOff icon, which is itself icon-only with no label — the state
is announced to a screen reader only through the `title` (which reads "click to hide"/"click to
show", i.e. the ACTION, not the state).
fix: Add `aria-pressed={p.visible}` to the button at 1041 and give the icon
`aria-label={p.visible ? 'visible' : 'hidden'}`; the `aria-pressed` alone makes the state
announceable and keeps the visual design unchanged.

MEDIUM — src/components/openfoam/mesh-viewer.tsx:1032-1035 — the error banner is not theme-aware in light/dark consistently
scenario: `border-amber-300 bg-amber-50 dark:bg-amber-950/20` sets a dark-mode background but
leaves `border-amber-300` and the `text-amber-600` icon fixed. In dark mode a 300-level border
around a 950/20 fill is a bright line on near-black — noticeably louder than every other border in
the app, which all come from `--border`.
fix: `border-amber-300 dark:border-amber-900` and `text-amber-600 dark:text-amber-400`, matching
the treatment already used in chat-popup.tsx:1253.

LOW — src/components/openfoam/mesh-viewer.tsx:854-858 — a failed vertex-label read leaves a permanent error banner
scenario: The user presses "Vertices" on a case whose `blockMeshDict` uses `#calc`. `setError(msg)`
paints the amber banner. Toggling Wireframe, changing the view, or pressing Vertices again does not
clear it — only a successful `loadMesh` (line 719) does. The banner then describes a failure that
has nothing to do with what is on screen.
fix: Clear it at the start of `loadVertexLabels` (`setError(null)` next to `setLabelsLoading(true)`),
and/or auto-clear on the next successful action.

---

## src/app/page.tsx

HIGH — src/app/page.tsx:139-162 — Ctrl+B never switches back to light: the shortcut captures a stale `isDark`
scenario: The keydown effect's dependency array is `[]`, but the handler closes over `isDark`
(line 58) and `setTheme`. On the very first client render `mounted` is still `false`, so
`isDark === false`, and that value is frozen into the handler for the life of the page. Press
Ctrl+B in light mode -> dark (correct). Press Ctrl+B again -> `setTheme(false ? 'light' : 'dark')` =
`setTheme('dark')` -> nothing happens. The shortcut advertised in the Shortcuts dialog
("Ctrl + B - Switch light/dark theme") is one-way. The header button at line 211 works because it
re-reads `isDark` on every render.
fix: Either add the dependencies — `}, [isDark, setTheme]);` — or avoid the closure entirely:
`setTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark')`.

MEDIUM — src/app/page.tsx:236-241 — the "close case" X is a `<span onClick>` nested inside a `<button>`
scenario: Each open-case chip is a `<button>` (line 222) containing a `<span onClick={handleCloseCase}>`
(line 236). Nesting an interactive element inside a button is invalid HTML — the span gets no focus,
no role, no keyboard activation. A keyboard user can Tab to the chip and press Enter, which
ACTIVATES the case instead of closing it; there is no keyboard path to close an open case at all.
It also has no accessible name, so a screen reader hears only the case name.
fix: Move the X out of the button — render the chip as a `<div className="inline-flex ...">` holding
two sibling buttons: one to switch to the case, one
`<button aria-label={"Close " + name} onClick={(e) => handleCloseCase(name, e)}>`.

MEDIUM — src/app/page.tsx:154-158 (with line 38) — Ctrl+1..7 cannot reach the eighth tab
scenario: `TABS` has 8 entries (lines 23-32); the last is "Src". The handler only accepts
`e.key >= '1' && e.key <= '7'`, and the Shortcuts dialog documents "Ctrl + 1-7". The Src tab is the
only tab in the app with no keyboard shortcut, and nothing tells the user why.
fix: Widen the range to '1'..'8' and update the SHORTCUTS entry at line 38 to "Ctrl + 1-8".

MEDIUM — src/app/page.tsx:88-96 — deleting the selected case inserts a nameless chip into the header
scenario: Dashboard's `handleDeleteCase` calls `onSelectCase('')` (dashboard.tsx:264) when the
deleted case was the selected one. `handleSelectCase('')` does not special-case the empty string:
`openCases.includes('')` is false, so it runs `setOpenCases(prev => ['', ...prev])` and
`setActiveTab('editor')`. The header then renders an empty pill (a Cpu icon and an X with no name)
that stays there for the rest of the session, and the app jumps to the Editor showing
"Select a case". Clicking that empty pill re-selects the empty case.
fix: Guard at the top of `handleSelectCase`:
`if (!name) { setOpenCases(prev => prev.filter(Boolean)); return; }`

MEDIUM — src/app/page.tsx:98-101 — closing/deleting a case leaves stale entries; deleted cases stay open
scenario: `handleCloseCase` only filters `openCases`. When the Dashboard DELETES a case that is
open but not selected, nothing removes it from `openCases`, so its chip stays in the header.
Clicking it makes it the active case; the Editor, Monitor, Mesh and Commands panels then all fetch a
case that no longer exists on disk and each shows its own silent-catch empty state, with no message
saying the case is gone.
fix: Have the Dashboard report the deleted name upward (e.g. a new `onCaseDeleted(name)` prop) and
in the page do `setOpenCases(prev => prev.filter(c => c !== name))`.

LOW — src/app/page.tsx:307, 312 — only two of the seven panels are told the tab is hidden
scenario: `Monitor` and `MeshViewer` receive `active={activeTab === '...'}` and correctly stop
polling/redrawing when hidden. `CommandPanel`, `FileEditor`, `Dashboard` and both `OpenFoamBrowser`
panes stay fully live behind `display:none` (line 72). That is what lets the File Editor's global
Ctrl+S / Ctrl+F listeners fire from other tabs (see below), and what keeps the command panel's
80 ms stream flush re-rendering an invisible transcript while the user watches the Monitor.
fix: Pass `active={activeTab === id}` to the rest and gate their timers and window-level key
listeners on it.

---

## src/components/openfoam/file-editor.tsx

HIGH — src/components/openfoam/file-editor.tsx:590-593 and 783-786 — deleting a FILE has no confirmation, and the control is an SVG not a button
scenario: Two defects on the same element. (1) Hovering any file in the tree reveals a trash icon
whose `onClick` calls `deleteSingle(itemPath)` directly — no `confirmDialog`, unlike folders
(line 533) and unlike multi-select delete (line 393). One mis-click on `system/controlDict` and the
file is removed from WSL with only a green "Deleted:" toast and no undo. (2) It is a bare
`<Trash2 ... onClick>` — an `<svg>`, not a `<button>` — so it is not focusable, not keyboard
operable, and has no accessible name, unlike the folder delete button 60 lines above which has both
`title` and `aria-label`.
fix: Wrap both occurrences in a real button and confirm first:
`<button type="button" title="Delete file" aria-label={"Delete " + item.name}
onClick={async (e) => { e.stopPropagation(); if (await confirmDialog('Delete "' + itemPath + '"?',
{ title: 'Delete file', confirmLabel: 'Delete', destructive: true })) deleteSingle(itemPath); }}>`

HIGH — src/components/openfoam/file-editor.tsx:204-234 — switching files silently discards unsaved edits
scenario: The user edits `0/U`; the header shows the amber "modified" badge and the footer says
"Not saved". They click `0/p` in the tree. `loadFile` overwrites `fileContent` and `originalContent`
with the new file immediately. There is no dirty check anywhere in `loadFile`, so the edits to `0/U`
are gone — and `fileCacheRef` (line 225) still holds the ORIGINAL `0/U`, so reopening it serves the
pre-edit text from cache and the work is unrecoverable. The same happens on a case switch, where the
whole component is destroyed (page.tsx:288 keys it by case).
fix: At the top of `loadFile`, before touching state:
`if (isModified && currentFile && filePath !== currentFile && !(await confirmDialog('"' + currentFile + '" has unsaved changes. Discard them?', { title: 'Unsaved changes', confirmLabel: 'Discard', destructive: true }))) return;`
and store the dirty buffer (not the original) in `fileCacheRef` so a discarded switch is recoverable.

HIGH — src/components/openfoam/file-editor.tsx:93-105 — Ctrl+S reports success before the save happens, and lies when it fails
scenario: `saveFileRef.current()` is called WITHOUT `await` and `toast.success('File saved (Ctrl+S)')`
runs on the next line, synchronously. If WSL is down or the path is not writable, `saveFile` reaches
its own `toast.error('Error saving')` a second later — so the user sees a green "File saved (Ctrl+S)"
followed by a red "Error saving", and the file is NOT on disk. On the success path they get two
toasts for one action ("File saved (Ctrl+S)" and "Saved: <path>").
fix: Make the handler async and `await saveFileRef.current();`, then delete the toast at line 99
entirely — `saveFile` already reports both outcomes at lines 255 and 257.

HIGH — src/components/openfoam/file-editor.tsx:876-878 — one DOM node per line in the gutter hangs the app on a mesh file
scenario: The tree lists `constant/polyMesh/points`, `faces`, `owner`. Clicking one loads its full
text and the gutter renders `fileContent.split('\n').map((_, i) => <div>...</div>)` — one `<div>`
per line, no virtualisation, no size guard. A 500k-cell mesh is millions of lines: React tries to
create millions of elements and the renderer process hangs, then dies. Even a 100k-line file makes
typing unusable, because the gutter re-renders on every keystroke (`fileContent` is its only input).
fix: (a) Cap the gutter — `const lineCount = useMemo(() => fileContent.split('\n').length, [fileContent])`
and render numbers only when `lineCount <= 5000`. (b) Refuse to open very large files: check
`content.length` in `loadFile` (line 223) and above ~2 MB show a "too large to edit" panel instead
of filling the textarea.

MEDIUM — src/components/openfoam/file-editor.tsx:93-122 — the editor's Ctrl+S and Ctrl+F fire from every other tab
scenario: Both listeners are on `window`, and FileEditor is never unmounted once visited — the page
only hides it with `display:none` (page.tsx:72, 286). The user is on the Monitor tab with a file
left open in the Editor and presses Ctrl+F expecting a find bar: `e.preventDefault()` swallows it
and toggles a search box on an invisible panel. Ctrl+S is worse — it writes the invisible editor
buffer back to WSL from any tab and toasts "File saved" for a panel that is not on screen.
fix: Give FileEditor an `active` prop like Monitor/MeshViewer and early-return from both handlers
when it is false, adding `active` to both dependency arrays.

MEDIUM — src/components/openfoam/file-editor.tsx:663-667 — the multi-select checkbox for 0/, system/ and constant/ never shows as ticked
scenario: In multi-select mode the three standard directories render
`<div className="w-3 h-3 rounded border border-muted-foreground" />` with no `isSel` lookup and no
tick glyph, unlike every other row (lines 716-718, 769-771). The user clicks the box next to
`system/`: it IS added to `selectedItems` (the count badge at line 639 increments) but the box stays
empty. They click again to "make it work", which deselects it, then press Delete believing `system/`
is included when it is not — or, on an even number of clicks, believing it is not when it is.
fix: Mirror the other rows — compute `const isSel = selectedItems.has(d)` and render
`<div className={"w-3 h-3 rounded border " + (isSel ? "bg-primary border-primary" : "border-muted-foreground")}>{isSel && <span className="text-[8px] text-primary-foreground leading-none">check</span>}</div>`.

MEDIUM — src/components/openfoam/file-editor.tsx:144-189 — opening a file re-lists the whole case over WSL
scenario: `fetchCaseInfo` is a `useCallback` with deps `[caseName, currentFile]`, and the effect at
187-189 depends on `fetchCaseInfo`. Every time the user clicks a different file, `currentFile`
changes -> `fetchCaseInfo` gets a new identity -> the effect re-fires -> a full `?action=info` round
trip into WSL plus `setLoading(true)`. Clicking through ten files issues ten redundant WSL calls and
flashes the tree's loading state each time.
fix: Read `currentFile` from a ref inside `fetchCaseInfo` and reduce the callback deps to `[caseName]`.

LOW — src/components/openfoam/file-editor.tsx:838-840 — "Undo" is not undo, and has no confirmation
scenario: The button labelled "Undo" with a `RotateCcw` icon calls `setFileContent(originalContent)`
— it discards ALL edits since the last save, not the last edit. A user pressing it expecting Ctrl+Z
semantics loses everything typed since the last save and gets only a "Changes discarded" info toast.
fix: Rename it "Revert" or "Discard changes" and gate it behind
`confirmDialog('Discard all unsaved changes to this file?', { title: 'Discard changes', confirmLabel: 'Discard', destructive: true })`.

LOW — src/components/openfoam/file-editor.tsx:841-846 — Copy and word-wrap are icon-only with no accessible name
scenario: The Copy button has neither `title` nor `aria-label`; the word-wrap button next to it has
a `title` but no `aria-label`. Screen reader users hear "button" in a row where every other control
is labelled, and sighted users get no tooltip on Copy at all.
fix: Add `aria-label="Copy file contents"` + `title="Copy file contents"` (line 841) and
`aria-label="Toggle word wrap"` (line 844).

LOW — src/components/openfoam/file-editor.tsx:59 — the file-content cache is never bounded
scenario: `fileCacheRef` holds the full text of every file the user has opened for the life of the
panel, cleared only by a forced refresh (line 152). Browsing `constant/polyMesh` caches several very
large files at once, on top of whatever the editor is showing.
fix: Evict the oldest entry once `size > 50`, and skip caching anything over ~1 MB.

LOW — src/components/openfoam/file-editor.tsx:887-914 — Tab/Shift+Tab in the editor destroys the selection and cannot be undone natively
scenario: Pressing Tab with text selected replaces the selection with four spaces (line 909
splices `start`..`end`), and because the change is applied with `setFileContent` rather than
`document.execCommand('insertText')`, the browser's native undo stack for the textarea is wiped —
Ctrl+Z after a Tab does nothing at all for the rest of the editing session.
fix: Use `document.execCommand('insertText', false, '    ')` (still the only cross-browser way to
keep a textarea's undo stack) and let the `onChange` handler pick the value up, or implement
multi-line indent explicitly and maintain your own undo stack.

