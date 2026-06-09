# Releases and release notes

Releases are cut by manually running the **CI Pipeline** workflow
(`.github/workflows/ci.yml`) against `main`. The `build-and-push` job only runs
on `workflow_dispatch` and only after the full CI suite (lint, unit,
integration, e2e, audits, scans) passes. When it runs it:

1. Bumps the version in `backend/package.json` and `frontend/package.json`
   (kept in lockstep).
2. Builds, signs, and pushes the multi-arch backend/frontend images to GHCR,
   with SBOM and provenance attestations, and Trivy-scans them.
3. Commits the version bump back to `main`.
4. Creates the `v<version>` GitHub Release using the notes you provide (see
   below), falling back to GitHub's auto-generated notes when you provide none.

## Cutting a release

From the Actions tab: **Actions -> CI Pipeline -> Run workflow**, pick the
branch `main`, and fill in the inputs. Or from the CLI:

```sh
# Patch bump (default): 1.10.5 -> 1.10.6
gh workflow run "CI Pipeline" --ref main

# Minor bump: 1.10.5 -> 1.11.0
gh workflow run "CI Pipeline" --ref main -f release_type=minor

# Major bump: 1.10.5 -> 2.0.0
gh workflow run "CI Pipeline" --ref main -f release_type=major

# Explicit version (overrides release_type)
gh workflow run "CI Pipeline" --ref main -f version=1.11.0
```

### Version inputs

| Input          | Effect                                                                 |
| -------------- | --------------------------------------------------------------------- |
| `release_type` | `patch` (default), `minor`, or `major`. Bumps the current version.    |
| `version`      | An explicit `MAJOR.MINOR.PATCH` string. Overrides `release_type`.     |

A minor bump of the current `1.10.x` line lands on `1.11.0`; passing
`version=1.11.0` does the same thing explicitly.

## Release notes

The notes are authored by hand (for example, drafted in Claude Desktop) and
fed into the release. The workflow resolves the release body in this order:

1. **`release_notes` input** - Markdown passed when you trigger the run. Best
   when triggering from the CLI so multi-line Markdown is preserved:

   ```sh
   gh workflow run "CI Pipeline" --ref main -f release_type=minor \
     -f release_notes="$(cat my-notes.md)"
   ```

2. **`docs/release-notes/<version>.md`** - a committed file named for the exact
   version being released (for example, `docs/release-notes/1.11.0.md`). Commit
   it to `main` before triggering the run. Use this when you prefer the notes to
   live in the repo and go through review.

3. **GitHub auto-generated notes** - used only when neither of the above is
   provided, so a release never fails for lack of notes.

Whichever source wins becomes the full body of the GitHub Release.

### Suggested authoring flow

1. Draft user-friendly notes in Claude Desktop from the commits/PRs since the
   last release. Group them into something readable, for example
   **New features**, **Improvements**, and **Bug fixes**, in plain language.
2. Either pass them via `-f release_notes=...` at trigger time, or commit them
   to `docs/release-notes/<version>.md`.
3. Run the workflow with the matching `release_type` / `version`.
