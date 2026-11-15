#!/usr/bin/env bash
# Run a Playwright command from e2e/ inside the official Playwright image.
#
# The image carries the browsers and every system library they need, so a CI
# shard no longer runs `playwright install-deps`: that step installs the
# libraries with apt from the runner's Ubuntu mirror, and when the mirror
# stalled the step hung until its 10-minute timeout -- 18 of 51 shard runs in
# the 25 CI runs before this change, every success under a minute, every
# failure the full 10 minutes. The image comes from one registry pull instead.
#
# The image is pinned by digest. A tag is a name its publisher (or whoever
# controls the registry account) can point at different content at any time; a
# digest names the content itself, so a pull either returns the image that was
# reviewed or fails. docs/container-images.md maps every pinned tag to its
# digest and says how to update one.
#
# Usage (from anywhere in the repository):
#   scripts/e2e-playwright.sh pull                  # fetch the image, with retries
#   scripts/e2e-playwright.sh <command...>          # run in e2e/, e.g.
#   scripts/e2e-playwright.sh npx playwright test --shard=1/4
#
# The container shares the host network, so BASE_URL / E2E_LB_URL point at the
# docker-compose.e2e.yml stack exactly as they did on the runner. Passed through
# when set: BASE_URL CI SHARD E2E_CLUSTER E2E_LB_URL.
set -euo pipefail

# The tag is informational -- Docker resolves the digest. Keep both in step
# with docs/container-images.md; the version must equal @playwright/test in
# e2e/package-lock.json (checked below).
IMAGE="mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe"

root="$(cd "$(dirname "$0")/.." && pwd)"

# The image's browsers belong to exactly one Playwright release. A different
# @playwright/test would look for browser builds the image does not contain and
# fail with "Executable doesn't exist" -- so say what to change instead.
image_version="${IMAGE#*:v}"
image_version="${image_version%%-*}"
locked_version="$(node -p "require('$root/e2e/package-lock.json').packages['node_modules/@playwright/test'].version")"
if [ "$image_version" != "$locked_version" ]; then
  echo "::error::The Playwright image is v$image_version but e2e/package-lock.json has @playwright/test $locked_version. Update IMAGE in scripts/e2e-playwright.sh and its row in docs/container-images.md." >&2
  exit 1
fi

if [ "${1:-}" = "pull" ]; then
  attempts=5
  for attempt in $(seq 1 "$attempts"); do
    # A capped attempt: a stalled pull is retried, not waited out.
    if timeout 600 docker pull --quiet "$IMAGE"; then
      exit 0
    fi
    echo "::warning::pull of $IMAGE failed (attempt $attempt of $attempts)" >&2
    sleep $((attempt * 15))
  done
  echo "::error::could not pull $IMAGE after $attempts attempts" >&2
  exit 1
fi

# --init reaps the browsers' child processes; --ipc=host gives Chromium a
# shared-memory segment larger than Docker's 64 MB default. The runner's own
# uid keeps the reports and test results writable by the steps that upload
# them; HOME=/tmp because that uid has no home in the image. The whole
# repository is mounted, because specs read files outside e2e/
# (push/fixture.ts reads frontend/public/sw.js).
exec docker run --rm --init --ipc=host --network host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e BASE_URL -e CI -e SHARD -e E2E_CLUSTER -e E2E_LB_URL \
  -v "$root":/work -w /work/e2e \
  "$IMAGE" "$@"
