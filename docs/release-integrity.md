# Release Integrity Contract

The rules that make a released artifact traceable to a verified source
revision. They exist because a green pipeline proves something only about the
commit it actually ran on, and both halves of that sentence have already been
weaker here than they looked: a test job that discovers no tests reports
success, and a release that commits after its gates have run publishes a
revision no gate ever saw.

This document covers the release and verification boundary.
`docs/verification-contract.md` covers which tests an invariant requires;
this one covers whether those tests ran, on what, and whether the thing
shipped is the thing tested.

Every rule below names the mechanism that enforces it or states plainly that
nothing does. Where the current pipeline does not satisfy a rule, the gap is
recorded as a gap rather than described as a guarantee -- see section 6.

## 1. Zero discovered tests is a failure, never a pass

A test runner that finds no tests has not verified anything. It must exit
non-zero.

The failure mode is not a runner bug; it is that the *set of tests* is itself
untested state. A renamed directory, an edited glob, a suite moved during a
refactor, or a `testPathPatterns` regex that no longer matches all silently
reduce the discovered set -- possibly to nothing -- and a runner told to
tolerate an empty set converts that into a green check. The pipeline then
reports "Backend Integration Tests: passed" on a run that executed no
integration test at all.

```text
REL-001
No test command may carry a blanket "succeed if nothing was discovered" flag
(`--passWithNoTests` or equivalent). A suite that legitimately has no tests
must be removed from the pipeline, not made unfailable.

REL-002
A suite whose absence would be a release-blocking regression must be asserted
present by name before the runner starts, and the discovered count must be
printed in the job log so a shrinking suite is visible in the diff of two runs.
```

REL-002 is the stronger of the two, and the reason is worth stating: removing
the flag makes *zero* tests fail, but it does nothing about twenty tests
silently becoming three. Only an explicit inventory catches partial loss.

**Current state:** `backend/package.json` runs integration tests with an
unconditional `--passWithNoTests`:

```json
"test:integration": "jest --config ./test/jest-e2e.json --testPathPatterns='test/integration/.*\\.spec\\.ts$' --runInBand --passWithNoTests",
```

There are 21 real suites under `backend/test/integration/`, so the flag is not
covering a package that has no tests by design -- it is a blanket net under a
populated suite, which is exactly the case REL-001 forbids. `.github/workflows/ci.yml`
invokes it unconditionally in the `backend-integration-tests` job. No other
runner in the pipeline has an equivalent flag: `test:unit` and the frontend's
`vitest run --coverage` have none, and Playwright fails by default when it
discovers no spec files.

## 2. The tested revision and the released revision must be the same

A gate result is a statement about one commit. It does not extend to a commit
created afterwards, however mechanical the change.

```text
REL-003
The commit identified by a release tag, a published image's
`org.opencontainers.image.revision`, and the commit the required gates ran on
must be one revision -- or a later run of the complete gate must verify the
final revision before it is tagged.

REL-004
A commit pushed after the gates have run must either be verified by an
equivalent full gate, or be proven to differ from the tested revision only in
ways the gate could not have covered. "Proven" means a check in the workflow,
not a reviewer's expectation about what `npm version` touches.

REL-005
A version-bump or release-automation commit may not be pushed with `[skip ci]`
unless REL-004's proof is in place. `[skip ci]` on a commit that becomes the
head of a protected branch means the branch head is a revision no workflow has
ever evaluated.
```

**Current state -- the image half is right.** The release path resolves the git
SHA once, in `prepare-release`, a job that creates no commit, and threads that
single value downstream as a job output. `build-and-push` stamps it into the
build as `GIT_SHA` and into the manifest as
`index:org.opencontainers.image.revision`, then signs with cosign, attaches an
SBOM attestation, and gates a Trivy scan -- all against
`${{ steps.build.outputs.digest }}`, a digest rather than a moving tag. The
published image is therefore provably built from the revision the
`needs:`-listed gates tested. This is the pattern to copy whenever an artifact
must be tied to a verified revision.

**Current state -- the git half is not.** The `release` job checks out with an
admin PAT and then:

```yaml
git commit -m "chore: bump version to ${VERSION} [skip ci]"
git pull --rebase
git push
```

That creates a new commit, pushes it to protected `main` past branch
protection, and nothing re-runs the gate on it. `gh release create "v${VERSION}"`
then runs with no `--target`, so the tag resolves to the default branch tip --
the bump commit, not the tested-and-imaged revision. The result is a split
identity: the image points at the verified revision, the tag and the branch head
point at an unverified one.

The `git pull --rebase` widens this. If `main` moved during the release, the
bump commit is rebased onto whatever arrived, and the pushed head then contains
changes that were never part of any release gate -- with `[skip ci]` suppressing
the push-triggered run that would have caught them.

## 3. Bypass is a recovery procedure, not a release step

A branch protection rule that the normal release path routinely circumvents is
not a control; it is a comment.

```text
REL-006
Administrator bypass of a required check must be an exceptional, recorded
recovery action. A standing credential whose purpose is to push past protection
on every release means the protected branch is unprotected for the one class of
commit that reaches it most predictably.
```

**Current state:** the bypass is by design and documented in the workflow
itself. `ci.yml` explains that `RELEASE_TOKEN` is an admin-owned fine-grained
PAT used because the default `GITHUB_TOKEN` acts as a non-admin bot that cannot
bypass protection, and that this "lets the `[skip ci]` version-bump commit
through the required 'Verify PR checklist' check on main". The workflow is
candid that it bypasses rather than forges a check, which is the honest
framing -- but the bypass is on the standard path, not an exception.

There is a second-order effect worth naming. `pr-checklist.yml` carries a
`push: branches: [main]` trigger whose stated purpose is to satisfy the required
check for commits the release job pushes. `[skip ci]` on the bump commit
suppresses push-triggered runs, so the trigger added to cover this case cannot
fire for it. The push succeeds regardless, via the PAT -- which is why the
contradiction has been invisible.

The fix direction REL-006 implies is a release-PR flow: the bump lands through
the same gate every other change does, and no standing bypass credential is
needed. Short of that, REL-004's proof is the minimum.

## 4. Required checks are policy, and policy belongs in the repository

```text
REL-007
The set of required status checks and the branch protection posture must be
readable from the repository. A control that exists only in a web UI cannot be
reviewed in a diff, cannot be restored after an accidental change, and cannot
be verified by anyone without administrator access.
```

**Current state:** no in-repo policy exists. `.github/` contains workflows plus
`lighthouse/`, `zap/`, `zizmor.yml`, a PR template and a discussion template --
no `settings.yml`, no ruleset export, no `CODEOWNERS`. Branch protection is
described only in workflow comments, including a comment asserting that "Do not
allow bypassing the above settings" is unchecked on the `main` rule. That
assertion may be true, but nothing in the repository can confirm it, and
nothing notices if it changes.

This is the one rule here that cannot be closed by a test. It needs either an
exported ruleset committed to the repository, or a scheduled job that reads the
protection API and fails when the live configuration diverges from a committed
expectation.

## 5. What the pipeline already does well

Recording these matters as much as recording the gaps: they are the patterns a
change should imitate, and a reviewer should notice when a new workflow step
does not.

| Control | Where | Why it is right |
| --- | --- | --- |
| SHA resolved once, threaded as an output | `prepare-release` to `build-and-push` | The artifact cannot drift from the tested revision, because no step re-reads a moving ref |
| Scans and signatures target a digest | cosign, `actions/attest-sbom`, Trivy | A tag can be moved after a scan; a digest cannot |
| CVE gate fails the build | Trivy with `exit-code: '1'` on CRITICAL | The scan is a gate, not a report |
| Every third-party action pinned to a full commit SHA | all workflows | A tag-pinned action is a supply-chain write primitive for whoever controls the tag |
| Workflows themselves are scanned | `zizmor-scan`, SARIF uploaded | Workflow security is machine-checked rather than reviewed by eye |
| Schema drift is a required gate | `schema-drift` running `scripts/verify-schema.sh` | Gates both the release and preview publish paths, and reproduces locally with only Docker |
| Bearer scan exceptions expire | `bearer-exceptions-review.yml` | A suppression with a `review-by` date that lapses opens an issue, so exceptions cannot become permanent silently |

The last two are the model this whole document is arguing for: a rule with an
expiry date and a job that enforces it, rather than a paragraph asking people to
remember.

## 6. Gap register

The rules above are normative. This table records where the pipeline stands
against them today, so no reader mistakes an intention for a control. A row
moves to "enforced" only when a workflow step or committed policy makes it
fail, not when a document describes it.

| Rule | Status on `main` | Blocking evidence |
| --- | --- | --- |
| REL-001 no blanket pass-with-no-tests | **not enforced** | `--passWithNoTests` in `backend/package.json` `test:integration` |
| REL-002 mandatory suites asserted by name | **not enforced** | no inventory step precedes the runner |
| REL-003 one revision across tag, image, gate | **partially enforced** | image bound to tested SHA; release tag resolves to the untested bump commit |
| REL-004 post-gate commit proven or verified | **not enforced** | nothing checks the bump commit's parent or diff scope |
| REL-005 no `[skip ci]` without that proof | **not enforced** | bump commit carries `[skip ci]` |
| REL-006 bypass is exceptional | **not enforced** | admin PAT bypass is the standard release path |
| REL-007 protection policy in-repo | **not enforced** | no `settings.yml` or ruleset export exists |

## 7. Definition of done for a change to the release path

A change to any workflow that builds, tags, publishes or pushes must state, in
the pull request:

1. which revision each produced artifact is bound to, and how that binding is
   enforced rather than assumed;
2. whether the change adds any commit created after the gates run, and if so
   what verifies it;
3. whether it introduces a new bypass, standing credential, or `[skip ci]`, and
   why the alternative was rejected;
4. which rows of section 6 the change moves, in either direction.

A change that moves a row from "not enforced" to "enforced" should delete the
row's blocking evidence in the same commit, so this table cannot quietly
describe a pipeline that no longer exists. `CLAUDE.md`'s rule applies here in
full: a doc that names an identifier is making a claim about the source, and
this document names workflow jobs, script names and flags throughout.
