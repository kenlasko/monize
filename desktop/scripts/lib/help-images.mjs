import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { copySource } from "./copy.mjs";

/** True when `cwebp` runs. */
export function hasCwebp(run = spawnSync) {
  const result = run("cwebp", ["-version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

/**
 * Stages the user guide's screenshots into `out`. With cwebp on PATH the
 * repository's own backend/scripts/convert-help-images.sh does the conversion
 * (run through `sh`, which Git Bash provides on Windows), so the flags live in
 * one place. Without it the PNGs are copied and a warning is written, unless
 * `requireWebp` is set, which throws instead. The backend's help listing
 * prefers a WebP and falls back to the PNG of the same name.
 * Returns "webp" or "png".
 */
export function stageHelpImages({
  src,
  out,
  script,
  requireWebp = false,
  cwebpAvailable = hasCwebp(),
  run = spawnSync,
  warn = () => {},
}) {
  if (!cwebpAvailable) {
    if (requireWebp) {
      throw new Error(
        "cwebp is not on PATH and --require-webp was passed. Install libwebp (apt install webp, brew install webp, or the libwebp release zip on Windows) and retry.",
      );
    }
    warn(
      "cwebp is not on PATH: copying the help screenshots as PNG (about 2.4x larger). The backend's help listing falls back to PNG, so in-app help still works; pass --require-webp to fail instead.",
    );
    fs.mkdirSync(out, { recursive: true });
    copySource({ src: path.join(src, "*.png"), dest: out });
    return "png";
  }
  const slash = (p) => p.split(path.sep).join("/");
  const result = run("sh", [slash(script), slash(src), slash(out)], {
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `convert-help-images.sh failed (${result.error ? result.error.message : `exit ${result.status}`}); it needs sh and cwebp on PATH`,
    );
  }
  return "webp";
}
