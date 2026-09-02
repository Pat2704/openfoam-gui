# Third-party notices

OpenFOAM Studio is distributed under the MIT License (see `LICENSE`).
The packaged application — `OpenFOAMStudio-v2-portable.exe` and
`OpenFOAMStudio-v2-folder.zip` — additionally embeds the third-party
components listed here. Their licenses are permissive, and every one of them
requires its copyright notice to travel with the binary.

This file is that notice, and it is the only place the attribution appears:
the web dependencies below are compiled into the application’s own JavaScript
bundles by Next.js, so their package directories — and the LICENSE files
inside them — are not present in the shipped tree. Their full texts are in
each project’s repository. Electron and Chromium are the exception: their
license texts ship as `LICENSE.electron.txt` and `LICENSES.chromium.html`
alongside the executable.

## Runtime, bundled in the executable

| Component | Version | License |
|---|---|---|
| Electron | 31.7.7 | MIT |
| Node.js (bundled `node.exe`) | as shipped in `electron/resources/bin` | MIT |
| Next.js | 16.3.3 | MIT |
| React, React DOM | 19.2.8 | MIT |
| three.js | 0.185.1 | MIT |
| Recharts | 2.15.4 | MIT |
| Radix UI primitives (dialog, select, tabs, toast, and others) | 1.x–2.x | MIT |
| lucide-react | 0.525.0 | ISC |
| class-variance-authority | 0.7.1 | Apache-2.0 |
| clsx | 2.1.1 | MIT |
| tailwind-merge | 3.6.0 | MIT |
| next-themes | 0.4.6 | MIT |
| sonner | 2.0.8 | MIT |

Electron and Node.js each carry their own dependency notices (Chromium, V8,
OpenSSL and others); those are reproduced in the license files shipped with
them, and are not restated here.

## Not bundled

**OpenFOAM** is not part of this distribution. It is free software released
under the GNU General Public License v3 by The OpenFOAM Foundation (and, for
the `.com` line, by OpenCFD Ltd). OpenFOAM Studio runs it as a separate program
inside WSL2 through `wsl.exe`; it neither links against it nor redistributes any
part of it, so the GPL does not extend to this application.

**OpenFOAM** is a registered trademark of OpenCFD Ltd. This project is
independent and is not approved, sponsored or endorsed by OpenCFD Ltd, ESI
Group, or The OpenFOAM Foundation.
