# Contributing

Thanks for taking an interest. This is a small project maintained by one person,
so the most useful contribution is usually a good bug report.

## Reporting a bug

Open an issue and use the bug template — it asks for the four things that decide
whether a report can be acted on at all:

- **Which download you used**, the folder `.zip` or the portable `.exe`. They
  behave differently at startup and several past bugs appeared in only one.
- **Your OpenFOAM version and WSL distribution.** The app supports the OpenFOAM
  Foundation line, 9 to 14. ESI versions (`v2312` and similar) are not supported
  and are known to misbehave.
- **`%APPDATA%\openfoam-studio\startup.log`** if the app failed to start. It is
  truncated on every run, so grab it right after the failure. This file exists
  precisely because the portable build detaches stdout and a failed start would
  otherwise leave nothing to look at.
- **What you expected instead.**

## Before you open a pull request

Please open an issue first and describe what you want to change. A small project
can absorb a focused fix easily and a large unannounced rewrite not at all.

If we agree on the change:

```bash
npm install
npm run dev        # browser, hot reload, port 3000
npm run check      # typecheck + lint, both must pass
```

Three things worth knowing before you touch anything:

- **The dev server is not the app.** Focus behaviour, process handling and
  anything persisted only reproduce in the packaged build. The README's "Three
  traps to know about" explains why. Verify a fix in a real build, not only in
  `npm run dev`.
- **`npm run electron:build` must report about 87 MB.** A much larger number
  means Next's file tracer swallowed the project; `next.config.ts` explains it.
- **Do not run anything destructive against real cases.** Test on a scratch case
  you can afford to lose.

## Style

Match the file you are editing: its naming, its comment density, its idiom.
Comments here explain *why* something is the way it is, usually because the
obvious alternative was tried and failed. Please keep that habit — a comment
that records a dead end is worth more than one that restates the code.

## Licence

Contributions are accepted under the MIT Licence, the same terms as the project.
