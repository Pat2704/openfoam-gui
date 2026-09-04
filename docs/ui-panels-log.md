# UI Polish Log — chat-popup.tsx & claude-panel.tsx

STATUS: complete — chat-popup.tsx, then claude-panel.tsx

Scope: presentation-only polish of the FOAMy chat popup and the Claude agent panel.
Rule: preserve the existing colourful, technical visual identity; refine, never neutralise.

## The type ladder used in both panels

Four steps, applied everywhere. `text-[9px]` and `text-[8px]` are gone — at those
sizes the panels were guessing, not reading.

| step | use |
| --- | --- |
| `text-sm` | conversation body, the thing being read |
| `text-xs` | secondary prose, composer, suggestion rows, code |
| `text-[11px]` | dense chrome: chips, block headers, inline buttons, tool rows |
| `text-[10px]` | the floor: captions, timestamps, hints, section labels |

## src/components/chat-popup.tsx

**Colours that were only right in one theme.** Every one of these had a
single-theme value applied in both, or a light/dark pair that drifted apart.
Same hue in, same hue out — the panel keeps all five of its working colours plus
the orange.

- Apply block (the green one, the panel's most distinctive element):
  `border-2 border-green-300 dark:border-green-700` + `bg-green-50/50
  dark:bg-green-950/20` + `bg-green-100 dark:bg-green-900/30` header →
  `border-success/40`, `bg-success-soft/30`, `bg-success-soft`. Title text
  `text-green-800 dark:text-green-300` → `text-success`. Still unmistakably the
  green apply card, now the same green in both themes.
- Apply / Apply-all buttons: `bg-green-600 hover:bg-green-700 text-white` →
  `bg-success text-background hover:bg-success/90`. `text-white` was wrong in
  dark, where `success` is a light green; `text-background` inverts correctly.
- Syntax-problem strip: red pair → `border-danger/40 bg-danger-soft`,
  `text-danger`. Name-problem strip: amber pair → `border-warning/40
  bg-warning-soft`, `text-warning`. The two stay visibly different, as intended
  — one is "will not parse", the other "not in this installation".
- Truncated-reply banner: `border-amber-300 bg-amber-50 dark:bg-amber-950/20` —
  the border had NO dark value at all — → `border-warning/40 bg-warning-soft`.
- `!llmProvider` hint box, last-error banner, the remove-API-key hover: amber /
  red pairs → `warning-soft` / `danger-soft` tokens.
- Header model chip `bg-blue-100 dark:bg-blue-950/40 text-blue-700
  dark:text-blue-300` → `bg-info-soft text-info`. Its status dot keeps its two
  meanings: `text-success` saved, `text-warning` unsaved.
- Case-context toggle (orange, and the panel's own colour): the on/off/hover
  orange pairs → `bg-brand-soft`, `border-brand/50`, `text-brand`. Disabled state
  was `text-muted-foreground/40` — invisible in dark — now `text-muted-foreground
  opacity-50`.
- Single-theme leftovers now tokenised: `text-red-600` (error), `text-green-500`
  (copy tick), `text-blue-500` / `text-blue-400` (file icons), `text-amber-500`
  (token counter), `bg-green-500` / `bg-green-400` (key-set and launcher dots),
  `text-orange-500` (full-case-context note).
- KEPT, deliberately: the orange→red gradient on the launcher, the header, the
  avatars and the send button. That is the app's mark and it is correct in both
  themes already.

**Three strings that rendered as literal garbage.** `📝`,
`📄`, `📁` and `—` sat in JSX *text*, not in a JS
string, so they were not escapes — the user saw the characters
`📝` on screen. The emoji became the lucide icons the rest of the panel
already uses (`FileCode`, `FolderOpen`), and the dash became a real em dash.

**An empty red pill.** The connection chip picked its classes with a two-way
ternary, so `connectionStatus === 'idle'` — the state it is in most of the time —
fell through to the *error* styling and painted a small empty red blob with no
text in it. Added the third branch; idle is now `hidden`. Presentation only: the
state and its two visible branches are untouched.

**Spacing, sizing, alignment.**
- Header buttons were `p-1.5` on icons of three different sizes, so they were
  three different widths. Now all three are `w-7 h-7` boxes with the icon
  centred at `w-3.5`, and the close X came down from `w-4` to match.
- Chip icons `w-2` → `w-2.5`; chip padding `px-1 py-0` → `px-1.5 py-px`, so the
  chips are the same object twice instead of two near-misses.
- Apply-block header gained `gap-2` + `truncate` so a long path shortens instead
  of shoving the status button out of the row.
- Case-context toggle `py-0.5` → `py-1`, matching the badge beside it.
- Suggestion rows `py-1.5` → `py-2` for a 32px row.

**States.**
- Focus: removed the bespoke `focus:outline-none focus:ring-1
  focus:ring-primary/50` from all four inputs and the composer. They now take the
  shared orange `:focus-visible` ring from globals.css, like everything else.
- Hover/active added where a control had hover but no press feedback:
  `active:bg-accent/70` on header buttons, `active:bg-accent/70` on provider
  buttons, `active:bg-brand-soft` on the case-context toggle.
- Disabled: composer textarea gained `disabled:opacity-60
  disabled:cursor-not-allowed`; the fetch-models link gained
  `disabled:pointer-events-none` so a disabled link stops taking hover.
- Loading: the case-context button swapped `FolderSearch` for a spinning
  `Loader2` while it reads, which is the same treatment every other in-flight
  action in the panel gets.

**Microinteractions.** `transition-all` → `transition-colors` on the provider
buttons and the remove-key button (they were animating layout). The launcher's
`transition-shadow` → `transition-[box-shadow,filter]` with `hover:brightness-105`.
Nothing animates while idle: the only animations left are the send spinner, the
applying spinner, the case-context spinner and the Wi-Fi pulse during a live
connection test.

**Readability.** The worst offenders were the "Default:" hints and the model
count at `text-[9px] text-muted-foreground/50` — 9px at half opacity on a muted
ground. Now `text-[10px] text-muted-foreground`. Message timestamps
`text-[9px] .../60` → `text-[10px]` full strength. Inside the amber name-problem
strip, `text-muted-foreground` was too close to the tint, so it is
`text-foreground/65`. Grip and resize handles went `/40` → `/60`, and the resize
handle now brightens on hover so it can be found.

**Skipped, on purpose.** The dead `group` class on the launcher was removed (no
`group-*` rule used it); nothing else behavioural was touched — no state,
effects, fetches or props changed.

## src/components/claude-panel.tsx

This panel is deliberately dressed as Claude Desktop — the warm `#FAF9F5` /
`#1F1E1B` ground, the `#E8E6DC` / `#33322C` user bubble, `#26251F` composer, and
`#D97757` throughout. **All of that is kept.** Those hexes are already correct
pairs, and the coral is this panel's identity in the same way the orange gradient
is FOAMy's. The tokens were used only where a colour was genuinely broken in one
theme, or where it is a *status* colour rather than Claude's own.

**Colours that were only right in one theme.**
- `text-green-600` on the code-block copy tick → `text-success`. This was the
  real one-theme bug in the file: green-600 is a dark green, all but invisible
  against `#26251F`.
- `text-red-500` (status-error icon), `text-red-600 dark:text-red-400` (probe
  failures) → `text-danger`.
- The two red boxes — the sign-in error and the turn error — were a hand-rolled
  four-class pair (`border-red-300 dark:border-red-900 bg-red-50
  dark:bg-red-950/30 text-red-700 dark:text-red-300`) → `border-danger/40
  bg-danger-soft text-danger`. Same red, one definition, and now the same red as
  FOAMy's error strip.
- A failing tool call now tints its whole card border `border-danger/40` instead
  of relying on one small icon to carry the state.

**Kept as-is, deliberately.** The guard-rails toggle stays coral when unrestricted
rather than going red. The existing comment says it should be "plain when off and
loud when on", and coral IS this panel's loud — recolouring it to `danger` would
have been me redefining what the control means. It gained `ring-1
ring-[#D97757]/45` instead, so "on" now reads as an engaged toggle rather than
just another accent-coloured chip.

**Typography.** Same ladder as the other panel. `text-[8px]` on the subscription
chip and five separate `text-[9px]` (the "What was tried" and "Reasoning" section
captions, the account-menu footer, the composer footnote, the turn duration) all
became `text-[10px]`. The tool-card `pre` blocks went `text-[10px]` →
`text-[11px]`, matching the code blocks in the same transcript.

**Spacing, sizing, alignment.**
- Header buttons: `p-1.5` around icons of two sizes → `w-7 h-7` boxes, close X
  `w-4` → `w-3.5`. Now identical to FOAMy's header, which was the point.
- Control heights were a mix of `h-7 text-xs`, `h-8 text-[11px]` and `h-8
  text-xs`. Settled on `h-8 text-xs` for every block button.
- The two bare inputs (`claude.exe` path, sign-in code) were `py-1.5`, so ~30px
  next to a 32px button. Both are `h-8` now and line up with the button beside
  them.
- Menu widths were `w-56` / `w-60` / `w-64`. The model and reasoning menus open
  from the same toolbar and now share `w-60`; the account menu stays `w-64`.
- The tool-row verb gained `flex-shrink-0` so a long path truncates the path
  rather than squeezing "Writing" into "Writ…".

**States.**
- Focus: the composer is one field as far as the user is concerned, so the app's
  shared ring goes on the box, not on the textarea inside it —
  `focus-within:outline-2 focus-within:outline-offset-2
  focus-within:outline-brand`, which is the exact rule from globals.css. Measured
  in the running app: on focus the container reports `2px solid`, offset `2px`,
  in the brand orange. Everything else in the panel had no `outline-none` and so
  already inherits the shared ring.
  (First attempt used `has-[textarea:focus-visible]:…`; the utility compiled but
  never matched at runtime, so it was replaced with the `focus-within` form
  above, which was then verified live.)
- The model and reasoning triggers had no *open* state — the menu appeared with
  the button that opened it looking untouched. Both now hold the hover
  background while their menu is open, like the account button already did.
- Added `active:` press feedback to the header buttons, both menus' items, the
  tool-card row, the suggestion rows, the send button and the stop button.
- Disabled: `disabled:hover:bg-transparent` on the reasoning trigger →
  `disabled:pointer-events-none` (it was still taking hover and the cursor);
  same on the send button and the account sign-in item; composer textarea gained
  `disabled:opacity-60 disabled:cursor-not-allowed`.

**Microinteractions.** Nothing here animated while idle, and it still doesn't.
Every remaining animation is gated on real work: the streaming caret
(`block.live`), the running-tool spinner (`block.status === 'running'`), the
"Thinking…" spinner (`running`), and the status/sign-in spinners. The launcher
matches FOAMy's: `transition-[box-shadow,filter] duration-150` with
`hover:brightness-105` and `hover:shadow-…/30`.

**Readability.** Muted text at `/50`, `/60` and `/70` opacity went to full
strength (the composer footnote, the turn duration, the account-menu footer, the
sign-in version line). Grip and resize handles `/40` → `/60`, and the resize
handle brightens on hover. Composer placeholder `/60` → `/70`.

## Launchers

Both are `w-14 h-14 rounded-full shadow-lg hover:shadow-xl`, both use
`hover:shadow-<own colour>/30`, both `transition-[box-shadow,filter]
duration-150 hover:brightness-105`, both stay in the bottom-right corner at the
same offsets, and dragging is untouched. FOAMy keeps its orange→red gradient and
its green online dot (the dot shrank from `w-4` to `w-3.5` and moved in to
`-top-0.5 -right-0.5` so it sits on the rim rather than floating off it); Claude
keeps its solid `#D97757` burst.

## One finding I could not fix from here

The `-soft` grounds are comfortable in the DARK theme and thin in the LIGHT one.
Measured in the running app, foreground-on-soft contrast:

| pair | dark | light |
| --- | --- | --- |
| `text-success` on `bg-success-soft` | 6.13 | 3.52 |
| `text-warning` on `bg-warning-soft` | 6.73 | **2.60** |
| `text-danger` on `bg-danger-soft` | 4.68 | 4.06 |
| `text-info` on `bg-info-soft` | 5.55 | 3.68 |
| `text-brand` on `bg-brand-soft` | 4.93 | 3.16 |
| `text-background` on `bg-success` (apply button) | 9.09 | 4.00 |

Dark passes AA everywhere; light does not. The fix is a darker light-theme value
for each accent in globals.css, which is outside the two files I was asked to
touch — so it is reported, not applied. Inside the panels I used the tokens as
specified everywhere the coloured text is a short label, and moved only the one
piece of real body copy (the "Select a provider…" sentence) onto
`text-foreground/80`, letting the icon, ground and border carry the amber.

## Constraints honoured

- Presentation only. No state, effect, fetch, prop, handler or piece of logic was
  changed in either file. The one structural edit — the connection pill's third
  ternary branch — adds a CSS class for a state that was already being rendered.
- Only `chat-popup.tsx`, `claude-panel.tsx` and this log were touched.
- No dev server started, no build run.
- `npm run typecheck` and `npm run lint` both clean.
- All existing comments preserved; three new ones added to explain the composer
  ring, the connection pill's idle branch, and the one contrast exception.
- Verified in the running app at localhost:3000 in both themes: both launchers,
  the FOAMy window and its settings panel, the Claude panel and its model menu.
  No console errors.
