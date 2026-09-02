# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Use GitHub's private reporting instead: go to the **Security** tab of this
repository and choose *Report a vulnerability*. That opens a private channel
visible only to the maintainer.

Expect a first reply within about a week. This is a spare-time project
maintained by one person, so please be patient — and do say if you intend to
disclose publicly on a schedule, so it can be met.

## What is in scope

The application itself: the Electron shell, the local server it runs, the REST
endpoints under `src/app/api/**`, and the way commands are built before being
handed to WSL. Anything that lets a case file, a filename or a model reply reach
a shell unescaped is very much in scope.

Two areas deserve particular attention:

- **The agent's unrestricted mode.** When it is on, it is a shell in the case
  directory by design. `checkUnrestrictedCommand()` in `src/lib/agent-policy.ts`
  refuses commands mentioning `/mnt/`, so the mode cannot reach the Windows
  drives. That check reads the command as text: it stops an accident, not a
  determined bypass, and that limit is deliberate and documented. A way to reach
  the Windows filesystem *without* naming `/mnt/` is a real finding.
- **Path handling.** Every case-relative path goes through `validateRelativePath`
  precisely so it cannot escape the case directory. A way around it is a finding.

## What is not in scope

- OpenFOAM itself. It is not part of this project and is not redistributed by
  it; report those upstream.
- WSL, Windows, Electron and Node.js — report to their own projects, though a
  note here is welcome if this app makes such an issue materially worse.
- The unsigned executable and the resulting SmartScreen warning. This is known
  and explained in the README.
