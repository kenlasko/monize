# Container images: tags and digests

Every third-party container image this repository pulls should be named by
**digest**, not only by tag. This file is the map from the human-readable tag
to the digest that is actually pulled, so a reviewer can see what a reference
means without querying a registry.

## Why a digest

A tag such as `v1.64.1-noble` or `16-alpine` is a name. Whoever controls the
publishing account -- or a compromised registry, mirror or CI token -- can point
that name at different content at any time, and every later pull silently gets
the new content. A digest (`sha256:...`) is the hash of the image index itself:
a pull by digest either returns exactly the reviewed content or fails. It is the
same rule this repository already applies to GitHub Actions, which are pinned
to full commit SHAs (`docs/release-integrity.md`, section 5).

A reference may carry both, `name:tag@sha256:digest`. Docker then pulls by the
digest and ignores the tag; the tag stays only so a reader knows which release
the digest is.

## Pinned images

The digest is the multi-architecture **image index** digest (what
`docker pull name:tag` resolves first), not a per-platform manifest.

| Image | Tag | Digest | Used in |
| --- | --- | --- | --- |
| `mcr.microsoft.com/playwright` | `v1.65.0-noble` | `sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe` | `scripts/e2e-playwright.sh` (E2E shards in `.github/workflows/ci.yml`) |
| `mirror.gcr.io/library/postgres` | `18-alpine` | `sha256:b6972e1115a4ff8eba5d7f7d19184926d1e16d7d1136ae1e1a7ebf286da0f015` | `.github/workflows/ci.yml` (integration-test service), `scripts/verify-schema.sh`, `docker-compose.e2e.yml` |
| `mirror.gcr.io/library/nginx` | `1.29-alpine` | `sha256:5616878291a2eed594aee8db4dade5878cf7edcb475e59193904b198d9b830de` | `docker-compose.e2e.yml` (cluster-shard load balancer) |
| `mirror.gcr.io/library/node` | `24-alpine` | `sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53` | `backend/Dockerfile`, `frontend/Dockerfile` (`development` and `production` stages) |
| `mirror.gcr.io/library/node` | `24-slim` | `sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205` | `backend/Dockerfile` (`builder` and `deps` stages), `frontend/Dockerfile` (`builder` stage) |

Per-platform manifests of the Playwright index, for reference when comparing a
pulled image (`docker image inspect --format '{{index .RepoDigests 0}}'` shows
the platform manifest on some engines):

| Tag | Platform | Manifest digest |
| --- | --- | --- |
| `v1.65.0-noble` | `linux/amd64` | `sha256:f6fe3cf9a493670b9a20f33597a807262abb25c40c31839ba4ac1dbc51fe7366` |
| `v1.65.0-noble` | `linux/arm64` | `sha256:714043ec4d54008d194a4b3835bc2a1156c51862d8bb45d72bea414f0ce9ed61` |

## When to move a digest

A new digest is new content, and a freshly published image is exactly what a
compromised account or registry would deliver. The rule is the one
`.github/dependabot.yml` already applies to npm packages:

- **Wait about a week.** Move a pin to a digest that has been public for at
  least seven days, so a compromised or broken publish has time to be noticed
  and withdrawn first.
- **Never automatically.** A digest changes only in a reviewed pull request;
  whoever changes it reads the digest from the registry themselves (below) and
  updates this file in the same commit.
- **Urgent security fixes are the exception, done by hand.** When a fix cannot
  wait a week (for example a Node.js security release for the base image),
  update the reference and this file manually and say in the pull request why
  the week was skipped.

## Reading the digest of a tag

Either command prints the index digest for a tag; run it, compare, and only
then change a reference:

```sh
docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.64.1-noble   # "Digest:" line

curl -sI \
  -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' \
  https://mcr.microsoft.com/v2/playwright/manifests/v1.64.1-noble | grep -i docker-content-digest
```

A digest copied from a pull request or a chat is not evidence; read it from the
registry yourself.

## Updating the Playwright image

The image's browsers belong to exactly one Playwright release, so the image must
move together with `@playwright/test` in `e2e/package-lock.json` (for example
when Dependabot bumps it). `scripts/e2e-playwright.sh` refuses to run when the
two disagree, naming both versions.

1. Read the new index digest for `v<version>-noble` (commands above).
2. Change `IMAGE` in `scripts/e2e-playwright.sh` -- tag and digest together.
3. Change the Playwright rows of the tables above in the same commit.

## The guard

`backend/src/common/image-digest-pin.guard.spec.ts` scans every tracked
Dockerfile, `docker-compose.e2e.yml`, and every workflow and shell script (the
same files `ci-images.guard.spec.ts` scans for the registry allowlist). It
fails when a `mirror.gcr.io` or `mcr.microsoft.com` reference has no
`@sha256:` digest, when a pinned digest has no row in the "Pinned images"
table above, or when a row in that table is not actually pinned anywhere --
so this file cannot go stale silently in either direction. Adding a reference
or moving a digest means updating both in the same commit.

## Not yet pinned

These references still pull by tag alone, deliberately: they are this
project's own images in the user-facing compose files and the Helm chart,
where `:latest` is a convenience for self-hosters, and pinning them is a
separate decision (issue #1837, item 5).

- `docker-compose.dev.yml`, `docker-compose.prod.yml`, `docker-compose.ha.yml`: `postgres:18-alpine` (dev) and `postgres:16-alpine` (prod, ha), `caddy:2-alpine`, and the project's own `ghcr.io/kenlasko/monize-*:latest`
- `helm/values.yaml`: the project's own images, by tag
