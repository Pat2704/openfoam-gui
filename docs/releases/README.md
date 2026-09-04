# Release notes

One file per release, named after the version in `package.json`, in the
canonical `vMAJOR.MINOR.PATCH` form. Each file is the text that was published
on the GitHub release, archived here so the notes are versioned with the code
instead of living only on GitHub.

Publishing a release reads its notes from this directory:

```
gh release create vX.Y.Z dist-electron/OpenFOAMStudio-vX.Y.Z-portable.exe \
  dist-electron/OpenFOAMStudio-vX.Y.Z-folder.zip \
  --title "OpenFOAM Studio vX.Y.Z — <what changed>" \
  --notes-file docs/releases/vX.Y.Z.md
```

## The tags do not all match the filenames

The three-component rule starts at `v2.0.0`. Everything before it was tagged
with one or two components, and those tags are published URLs — they were left
alone rather than rewritten. The archive uses the canonical form throughout so
the directory sorts correctly, which makes this table the mapping:

| file | tag as published |
|---|---|
| `v1.0.0.md` | `v1` |
| `v1.1.0.md` | `v1.1` |
| `v1.2.0.md` | `v1.2` |
| `v1.3.0.md` | `v1.3` |
| `v1.4.0.md` | `v1.4` |
| `v2.0.0.md` | `v2.0.0` |
| `v2.1.0.md` | `v2.1.0` |
| `v2.2.0.md` | `v2.2.0` |
| `v2.2.1.md` | `v2.2.1` |
| `v2.3.0.md` | `v2.3.0` |
| `v2.3.1.md` | `v2.3.1` |
| `v3.0.0.md` | `v3.0.0` |
