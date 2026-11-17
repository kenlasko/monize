import { spawnSync } from "child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

import {
  BACKEND_DEPS_FILE,
  backendDepsPath,
  PreloadMissingError,
} from "./backend-deps";

/**
 * The backend-deps preload against real Node processes. Outside Electron an
 * `.asar` path is an ordinary directory, so a directory named
 * `node_modules.asar` stands in for the archive: the preload's rules are about
 * resolution, and Electron only changes how the bytes are read.
 */

const PRELOAD = join(__dirname, "..", "..", "resources", BACKEND_DEPS_FILE);

let resources: string;

function write(rel: string, content: string): void {
  const file = join(resources, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Runs `code` as a backend script would run: from backend/dist, under the preload. */
function runInBackend(code: string): { status: number | null; out: string } {
  write("backend/dist/probe.js", code);
  const result = spawnSync(
    process.execPath,
    ["--require", join(resources, "shell", BACKEND_DEPS_FILE), "dist/probe.js"],
    { cwd: join(resources, "backend"), encoding: "utf8" },
  );
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const ARCHIVED = "backend/node_modules.asar/node_modules";

beforeEach(() => {
  resources = mkdtempSync(join(tmpdir(), "monize-backend-deps-"));
  mkdirSync(join(resources, "shell"));
  copyFileSync(PRELOAD, join(resources, "shell", BACKEND_DEPS_FILE));
  // A CommonJS package that needs a hoisted sibling.
  write(`${ARCHIVED}/cjs-a/package.json`, '{"name":"cjs-a","main":"main.js"}');
  write(
    `${ARCHIVED}/cjs-a/main.js`,
    'module.exports = "a+" + require("cjs-b");',
  );
  write(`${ARCHIVED}/cjs-b/package.json`, '{"name":"cjs-b"}');
  write(`${ARCHIVED}/cjs-b/index.js`, 'module.exports = "b";');
  // An ESM-only package with an exports map, importing a sibling.
  write(
    `${ARCHIVED}/esm-c/package.json`,
    '{"name":"esm-c","type":"module","exports":{".":"./c.js","./sub":"./sub.js"}}',
  );
  write(
    `${ARCHIVED}/esm-c/c.js`,
    'import b from "cjs-b"; export default "c+" + b;',
  );
  write(`${ARCHIVED}/esm-c/sub.js`, 'export default "sub";');
});

afterEach(() => {
  rmSync(resources, { recursive: true, force: true });
});

describe("backendDepsPath", () => {
  it("is <resources>/shell/backend-deps.cjs in the platform's flavour", () => {
    expect(
      backendDepsPath("C:\\Program Files\\Monize\\resources", "win32"),
    ).toBe("C:\\Program Files\\Monize\\resources\\shell\\backend-deps.cjs");
    expect(backendDepsPath("/opt/monize/resources", "linux")).toBe(
      "/opt/monize/resources/shell/backend-deps.cjs",
    );
  });

  it("names the missing file in its error", () => {
    const error = new PreloadMissingError("/r/shell/backend-deps.cjs");
    expect(error.code).toBe("PRELOAD_MISSING");
    expect(error.message).toContain("/r/shell/backend-deps.cjs");
  });
});

describe("the backend-deps preload, with real processes", () => {
  jest.setTimeout(20_000);

  it("lets backend/dist require a package from the archive, and that package its siblings", () => {
    const run = runInBackend('console.log(require("cjs-a"));');
    expect(run).toEqual({ status: 0, out: "a+b\n" });
  });

  it("lets backend/dist import an ESM-only package and its exports subpaths from the archive", () => {
    const run = runInBackend(
      'Promise.all([import("esm-c"), import("esm-c/sub")]).then(([c, s]) => console.log(c.default, s.default));',
    );
    expect(run).toEqual({ status: 0, out: "c+b sub\n" });
  });

  it("lets backend/dist require an ESM-only package (require of ESM)", () => {
    const run = runInBackend('console.log(require("esm-c").default);');
    expect(run).toEqual({ status: 0, out: "c+b\n" });
  });

  it("prefers a package found by the ordinary lookup over the archive's", () => {
    write("backend/node_modules/cjs-b/package.json", '{"name":"cjs-b"}');
    write("backend/node_modules/cjs-b/index.js", 'module.exports = "disk";');
    const run = runInBackend('console.log(require("cjs-b"));');
    expect(run).toEqual({ status: 0, out: "disk\n" });
  });

  it("never redirects a relative path, and a missing package still fails as Node's own error", () => {
    const relative = runInBackend(
      'try { require("./cjs-b"); } catch (e) { console.log(e.code); }',
    );
    expect(relative).toEqual({ status: 0, out: "MODULE_NOT_FOUND\n" });
    const missing = runInBackend(
      'try { require("nope"); } catch (e) { console.log(e.code, e.message.split("\\n")[0]); }' +
        'import("nope").catch((e) => console.log(e.code, e.message.includes("\'nope\'")));',
    );
    expect(missing).toEqual({
      status: 0,
      out: "MODULE_NOT_FOUND Cannot find module 'nope'\nERR_MODULE_NOT_FOUND true\n",
    });
  });

  it("does nothing when there is no archive", () => {
    rmSync(join(resources, "backend", "node_modules.asar"), {
      recursive: true,
    });
    const run = runInBackend(
      'try { require("cjs-b"); } catch (e) { console.log(e.code); }',
    );
    expect(run).toEqual({ status: 0, out: "MODULE_NOT_FOUND\n" });
  });
});
