# OpenFOAM Studio — Web GUI for OpenFOAM (WSL2)

A web-based graphical user interface for managing and running **OpenFOAM** CFD
simulations inside **WSL2 (Ubuntu)** on Windows, with an integrated AI copilot
(**FOAMy**).

This repository contains the **standalone build**: it ships with a pre-compiled
Next.js server, so no Node.js build toolchain is required to run it. It talks to
OpenFOAM through the `wsl` command instead of `docker exec`, so it runs entirely
on the Windows host with no Docker dependency.

![OpenFOAM Studio](screenshots/dashboard.png)
![OpenFOAM Studio](screenshots/file-editor.png)
![OpenFOAM Studio](screenshots/monitor.png)

---

## Requirements

Before you start, make sure you have:

| Component | Minimum version | How to verify |
|---|---|---|
| **Windows** | 10 (build 19041+) or 11 | `winver` |
| **WSL2** | enabled | `wsl --status` in PowerShell |
| **Ubuntu distro** | 22.04 or 24.04 | `wsl --list -v` |
| **OpenFOAM** | v9, v10, v11, v12, v13 or **v14** | `wsl -d Ubuntu -- bash -c "source /opt/openfoam14/etc/bashrc 2>/dev/null && echo \$WM_PROJECT_VERSION"` |
| **Node.js** | 20.9+ (only used by `start.bat`) | `node -v` in PowerShell |
| **Browser** | Recent Chrome / Edge / Firefox | — |
| **LLM API key** | Groq, OpenAI, Anthropic or compatible | for the FOAMy copilot (optional — the rest of the GUI works without it). Configured **in-app**, not in `.env`. |

> The GUI supports multiple OpenFOAM installations at the same time: it
> auto-detects every version in `/opt/openfoam*`, `/opt/openfoam/OpenFOAM-*`,
> `/usr/lib/openfoam/*` and `/usr/local/OpenFOAM-*` and lets you switch version
> on the fly from the **OpenFOAM Version** panel.

---

## Installation

### 1. Unzip the archive

Extract `openfoamGUI-standalone.zip` into a folder, for example:

```
C:\OpenFOAM-Studio\
```

After extraction the folder should contain at least:

```
C:\OpenFOAM-Studio\
├── server.js                  ← Next.js standalone server entry point
├── start.bat                  ← Windows launcher (double-click)
├── package.json
├── .env                       ← telemetry flag only (no editing needed)
├── .next\                     ← pre-compiled build (do not modify)
├── public\
├── prisma\
└── README.md                  ← this file
```

### 2. The `.env` file

The shipped `.env` contains only:

```env
NEXT_TELEMETRY_DISABLED=1
```

That is all you need at startup. **No `.env` editing is required** — the FOAMy AI
copilot is configured entirely from inside the application (see **Configure the
FOAMy AI copilot** below).

### 3. Verify OpenFOAM in WSL (recommended)

Open PowerShell and run:

```powershell
wsl -d Ubuntu -- bash -c "ls /opt/openfoam*/etc/bashrc /opt/openfoam/OpenFOAM-*/etc/bashrc /usr/lib/openfoam/*/etc/bashrc 2>/dev/null"
```

It should return at least one path like `/opt/openfoam14/etc/bashrc`. If the list
is empty, install OpenFOAM before continuing (see **Installing OpenFOAM in WSL**
below).

---

## Configure the FOAMy AI copilot

The FOAMy copilot (the orange chat button, bottom-right) is configured **entirely
from inside the application** — no `.env` editing, no server restart. The
configuration is stored in your browser (localStorage), so it is private to you
and survives page reloads.

### Steps

1. Launch the GUI (see **Starting the application** below).
2. Click the orange **FOAMy** button in the bottom-right corner to open the chat.
3. Click the **gear icon** (⚙️) in the chat header to open **LLM Configuration**.
4. Fill in the fields:

   | Field | Description |
   |---|---|
   | **Provider** | Choose `OpenAI`, `Anthropic`, `Groq` or `Custom`. Selecting a provider auto-fills the recommended base URL, API format and a default model. |
   | **Base URL** | The API endpoint. Pre-filled for known providers. For `Custom`, enter your own (e.g. `http://localhost:11434/v1` for local Ollama, or an OpenRouter / Together URL). |
   | **API Key** | Your provider key (e.g. `gsk_…` for Groq, `sk-…` for OpenAI). Stored only in your browser. |
   | **Model** | The model id. Click **Fetch models** to auto-download the list of models available for your key, then pick one from the dropdown. |
   | **API format** | `OpenAI Chat Completions` (default, works for Groq/Ollama/OpenRouter) or `Anthropic Messages`. |

5. Click **Test connection** to verify the provider responds with the current key
   and model — a green "Connected" pill appears on success.
6. Click **Save**. The chat is ready: the configuration is stored in the browser
   and used for every FOAMy request.

### Supported providers (presets)

| Provider | Default base URL | Default model | API format |
|---|---|---|---|
| **Groq** (recommended, fast & free for moderate use) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` | OpenAI Chat |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` | OpenAI Chat |
| **Anthropic** | `https://api.anthropic.com` | `claude-sonnet-4-20250514` | Anthropic Messages |
| **Custom** (Ollama, OpenRouter, Together, LM Studio, …) | _empty_ (you fill it) | _empty_ | OpenAI Chat |

> Example for a **local Ollama** instance: Provider = `Custom`, Base URL =
> `http://localhost:11434/v1`, API Key = `ollama`, Model = `llama3.1:8b`.

> Without configuring FOAMy, the dashboard, editor, commands and monitor all
> work normally — only the chat copilot stays disabled until you set it up.

---

## Starting the application

### Recommended: `start.bat`

Double-click **`start.bat`**. The launcher:

1. Verifies that **Node.js** and **WSL** are installed.
2. Auto-detects the Ubuntu distro (skips `docker-desktop`); you can change it
   later from the **Settings** panel in the GUI.
3. Verifies that **OpenFOAM** is present in the distro.
4. Starts the Next.js server on `http://localhost:3000`.
5. Opens the GUI in a Chrome app window.

When you see the line `Starting on http://localhost:3000` the GUI is ready. Keep
the launcher window open: closing it stops the server.

### Alternative: command line

If you prefer not to use `start.bat`:

```bat
:: In a command prompt, inside the OpenFOAM Studio folder
set HOSTNAME=127.0.0.1
set PORT=3000
node server.js
```

Then open your browser at <http://localhost:3000>.

### Startup parameters

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | TCP port of the server |
| `HOSTNAME` | `127.0.0.1` | Bind interface. **Do not change** unless you understand the security implications: the command API runs arbitrary shell commands inside WSL. |
| `KEEP_ALIVE_TIMEOUT` | (Node default) | HTTP keep-alive timeout in ms |

---

## First steps

1. **Open the GUI** at <http://localhost:3000>.
2. In the top-left you will see a **WSL2** badge with the distro name and a green
   (online) or red (offline) dot.
3. Open the **Dashboard** tab:
   - In the top-right, click the ⚙️ icon → **OpenFOAM Version**: choose which
     version to use among the detected ones. All paths (`$FOAM_RUN`,
     `$FOAM_TUTORIALS`, cases, commands) update automatically.
   - The case list comes from `$FOAM_RUN` (by default `~/OpenFOAM/<user>-<version>/run/`).
   - You can copy an official tutorial with the **Copy tutorial** button.
4. Click on a case to open it in the editor.
5. **Commands** tab: on the left you find the command list **filtered by the
   OpenFOAM version in use**. Switching from v13 to v14 updates the list
   automatically.
6. **Monitor** tab: log tail, residual chart, running process list with per-PID
   kill.
7. Orange button in the bottom-right → **FOAMy**: an AI copilot that reads the
   case files and suggests modifications. On first use, click the gear icon (⚙️)
   in the chat to configure your LLM provider (see **Configure the FOAMy AI
   copilot** above).

---

## Features

- **Dashboard** — Browse and select cases from `$FOAM_RUN`, switch the active WSL
  distro, switch the OpenFOAM version, copy official tutorials.
- **New Case Wizard** — Create a new case from a template (cavity, pipe flow,
  airfoil, dam break, motorbike, …) with a guided multi-step wizard.
- **File Editor** — View, edit, create and delete case files with line numbers,
  syntax highlighting and Tab support.
- **Command Panel** — Run OpenFOAM commands (`blockMesh`, `foamRun`,
  `snappyHexMesh`, `checkMesh`, …) with output preview. The left sidebar shows
  the command list **faithful to the version in use** (v9 → v14). Supports
  background execution.
- **Monitor** — Live log tail, residual chart, running process list with
  per-PID kill and "kill all".
- **Applications / Src** — Browse the installed OpenFOAM code (`$FOAM_APP`,
  `$FOAM_SRC`) with full-text search.
- **FOAMy AI Copilot** — A floating chat that reads the case files and suggests
  modifications:
  - Click the orange button to open the chat.
  - Toggle "Case context" to let FOAMy read all the case files.
  - When a file is open in the editor, its content is shared with FOAMy
    automatically.
  - FOAMy can propose file changes — click "Apply change" to write them directly.

---

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Ctrl + 1…7` | Switch tab (Dashboard, Wizard, Editor, Commands, Monitor, Applications, Src) |
| `Ctrl + S` | Save the file open in the editor |
| `Ctrl + Enter` | Send message in the FOAMy chat |
| `Ctrl + B` | Toggle light/dark theme |
| `Ctrl + F` | Search in the file open in the editor |
| `Ctrl + /` | Show/hide keyboard shortcuts |
| `↑ / ↓` | Navigate the command history in the terminal |

---

## Installing OpenFOAM in WSL (if you don't have it yet)

For **OpenFOAM v14** (Foundation, recommended):

```bash
# Inside WSL Ubuntu
sudo sh -c "wget -O - https://dl.openfoam.org/gpg.key > /etc/apt/trusted.gpg.d/openfoam.asc"
sudo add-apt-repository http://dl.openfoam.org/ubuntu
sudo apt update
sudo apt install openfoam14
```

After installation, verify:

```bash
source /opt/openfoam14/etc/bashrc
echo $WM_PROJECT_VERSION   # should print 14
```

For previous versions replace `openfoam14` with `openfoam13`, `openfoam12`, etc.
The GUI detects all of them automatically.

---

## How the WSL bridge works

All OpenFOAM interaction goes through `src/lib/wsl.ts`. The core is:

```ts
runInWsl(cmd: string, timeout?: number): string
```

which runs `wsl -d <distro> -- bash -c "<cmd>"` and returns stdout. The distro is
auto-detected once from `wsl --list -q` (first Ubuntu-like entry, skipping
`docker-desktop`) and cached for the lifetime of the process.

On top of this base layer:

- `findOpenFOAMVersions()` — scans all installations in `/opt`, `/usr/lib`,
  `/usr/local` and returns `{version, bashrcPath, installDir}[]`.
- `setOpenFOAMVersion(bashrcPath)` — selects which version to use (resets caches).
- `findBashrc()` — locates the `etc/bashrc` of the active version.
- `foamSource()` — builds the `source <bashrc>; ` prefix.
- `getFoamEnv()` — reads all OpenFOAM environment variables in a single
  `env -0` call.
- `getRunDirectory()` / `getTutorialDirectory()` — resolves `$FOAM_RUN` /
  `$FOAM_TUTORIALS`.
- `listCasesBatch()` / `getCaseInfo()` / `getCaseSummary()` — batched shell
  scripts that gather everything in a single WSL call to keep the GUI
  responsive.
- `executeCommandAsync()` — spawns `wsl bash -c` with streaming stdout/stderr;
  commands ending with `&` are wrapped in `nohup … &; disown`.

All file I/O (`readFile`, `writeFile`, `createDirectory`, `deleteFile`,
`deletePath`, `deleteAllTimesteps`, `cloneCase`) validates case names and
relative paths before touching WSL. Writes use base64 payloads and every
filesystem argument is shell-quoted, preventing paths from escaping
`$FOAM_RUN`.

The server binds to `127.0.0.1` by default because the command API
intentionally runs user shell commands inside WSL. Set `HOSTNAME` explicitly
only if you understand the security implications of exposing it to the network.

---

## API endpoints

All routes are relative to `http://localhost:3000`.

| Endpoint | Method | Actions |
|---|---|---|
| `/api/wsl` | GET | `ping`, `status`, `distros`, `setDistro`, `foamVersions`, `setFoamVersion`, `version`, `env`, `runDir`, `tutDir`, `processes`, `kill`, `killAll`, `killCase`, `fullStatus`, `quickStatus`, `foamApplications`, `foamSrc`, `foamListDir`, `foamListSubdirs`, `foamReadFile`, `foamSearch`, `foamSearchContent`, `runFoamHelp` |
| `/api/wsl` | POST | `fullStatus` (resets cache first) |
| `/api/cases` | GET | `list`, `listBatch`, `info`, `timesteps`, `runDir` |
| `/api/cases` | POST | `create`, `delete` |
| `/api/cases/[name]` | GET | `read`, `info`, `logs`, `listLogs`, `residuals`, `checkMesh`, `validateBC`, `caseSummary` |
| `/api/cases/[name]` | POST | `write`, `mkdir`, `deleteFile`, `deletePath`, `deleteBatch`, `deleteTimesteps`, `clone` |
| `/api/commands` | POST | run a command in the case directory (supports `parallel`, `nProcs`, `background`) |
| `/api/tutorials` | GET | `categories`, `cases`, `tutDir` |
| `/api/tutorials` | POST | `copy` |
| `/api/chat` | POST | FOAMy AI copilot (`chat`, `readFile`, `caseInfo`, `readCaseFiles` actions) |
| `/api/chat` | DELETE | clear conversation history by `sessionId` |

---

## Troubleshooting

### The WSL2 badge is red

- Run `wsl --status` in PowerShell.
- If WSL is running but the distro does not respond: run `wsl --shutdown` then
  restart `start.bat`.
- If you have multiple distros, open the GUI → Dashboard → Settings → change
  distro.

### "No OpenFOAM version found"

The GUI cannot find OpenFOAM in `/opt/openfoam*`, `/opt/openfoam/OpenFOAM-*`,
`/usr/lib/openfoam/*` or `/usr/local/OpenFOAM-*`. Possible causes:

- OpenFOAM is not installed → see **Installing OpenFOAM in WSL**.
- OpenFOAM is installed in a non-standard path → create a symlink:
  `sudo ln -s /yourpath/OpenFOAM-X /opt/openfoam/OpenFOAM-X`.
- The wrong distro is selected → Dashboard → Settings → change distro.

### FOAMy does not respond

- Open the FOAMy chat → click the gear icon (⚙️) → **LLM Configuration**.
- Verify that a **Provider**, **Base URL**, **API Key** and **Model** are set and
  saved (click **Save**).
- Click **Test connection** — a green "Connected" pill confirms the key works.
- Click **Fetch models** to confirm the provider returns a model list.
- Open the browser console (F12) to check for network errors.
- Verify that the API key is valid by making a direct `curl` call to the
  provider.
- The configuration is stored in the browser (localStorage): if you switch
  browser or use private/incognito mode, you need to configure FOAMy again.

### The server does not start

- Check that port 3000 is free: `netstat -ano | findstr :3000`. If it is taken,
  change `PORT` in `start.bat` or in the `node server.js` command.
- Check that `server.js` and `.next/` exist in the folder.
- Start from a command prompt to see the errors: `node server.js`.

### OpenFOAM commands not found

If the command sidebar shows few items or is missing commands for a specific
version:

- Verify that the correct version is selected in Dashboard → ⚙️ →
  **OpenFOAM Version** (the dot must be on the desired version).
- The list is filtered automatically based on the version in use: commands
  introduced in v13/v14 do not appear if v9-v12 is selected.
- If the version is not detected (WSL offline), the GUI shows all commands as a
  fallback.

---

## Development (rebuilding from source)

This section is for contributors who want to modify the source code, not for
standalone users.

### Prerequisites

- [Node.js](https://nodejs.org/) 20.9+ or [Bun](https://bun.sh/)
- WSL2 with Ubuntu and OpenFOAM installed (for runtime testing)

### Build commands

```bash
# Install dependencies
bun install          # or: npm install

# Dev server (hot reload) on port 3000
bun run dev          # or: npm run dev

# Typecheck + lint
bun run check

# Build standalone (produces .next/standalone/)
bun run build

# Full rebuild + zip (clean → build → copy static/public/auxiliary → zip)
bun run rebuild

# Start the built standalone (binds 127.0.0.1:3000)
bun start            # or: node scripts/start.js

# Package the source into a zip (excludes node_modules, .next, dist, .git)
bun run source-zip
```

### Project structure

| Path | Role |
|---|---|
| `src/lib/wsl.ts` | The WSL bridge (all OpenFOAM interaction) |
| `src/lib/wsl-input.ts` | Validation and shell quoting for WSL input |
| `src/lib/openfoam-data.ts` | Command database + case/file templates (with `minVersion` for dynamic filtering) |
| `src/app/api/wsl/route.ts` | Status / distro / versions / processes / kill endpoint |
| `src/app/api/cases/**` | Case CRUD + file I/O + checkMesh / validateBC / caseSummary |
| `src/app/api/commands/route.ts` | Runs an OpenFOAM command in a case |
| `src/app/api/tutorials/route.ts` | Browse / copy `$FOAM_TUTORIALS` |
| `src/app/api/chat/route.ts` | FOAMy copilot (OpenAI-compatible LLM) |
| `src/components/openfoam/dashboard.tsx` | Cases + tutorials + OpenFOAM version selection |
| `src/components/openfoam/case-wizard.tsx` | New case wizard |
| `src/components/openfoam/file-editor.tsx` | File editor |
| `src/components/openfoam/command-panel.tsx` | Terminal + dynamic command sidebar |
| `src/components/openfoam/monitor.tsx` | Logs + residuals + processes |
| `src/components/openfoam/foam-browser.tsx` | Browse `$FOAM_APP` / `$FOAM_SRC` |
| `src/components/chat-popup.tsx` | Floating FOAMy chat |
| `start.bat` | Windows launcher (auto-detects distro + OpenFOAM) |
| `server.js` | Next.js standalone server entry point |
| `scripts/start.js` | Alternative Node.js launcher |
| `scripts/build.js` | Post-build: copies `.next/static` + `public` into `.next/standalone` |
| `scripts/rebuild-standalone.js` | Full clean rebuild + zip |
| `scripts/package-source.js` | Packages the source zip |

The built standalone is what gets zipped for a release. The `server.js` at the
root is the Next.js standalone entry point; `start.bat` runs `node server.js`
after the environment checks.

---

## License & credits

OpenFOAM is free software released under the GNU GPL v3 license by The OpenFOAM
Foundation. This GUI is independent and not affiliated with The OpenFOAM
Foundation.

OpenFOAM Studio is provided "as is", without warranties. Check the license of
the LLM modules you use for the FOAMy copilot.
