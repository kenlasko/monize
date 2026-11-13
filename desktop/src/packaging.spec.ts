import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { resolveDataDir } from "./app-paths";
import { QUIT_FLAG } from "./shell/launch-args";
import { QUIT_WAIT_MS } from "./shell/quit-wait";

/**
 * The installer is built on Windows only, so the parts of its configuration
 * that the application's own code depends on are held here, where every
 * platform runs them: what is packed, what is left out, and the names the
 * NSIS include shares with the TypeScript.
 */

const desktopRoot = join(__dirname, "..");
const read = (file: string): string =>
  readFileSync(join(desktopRoot, file), "utf8");

const config = read("electron-builder.yml");
const nsh = read("build/installer.nsh");
const manifest = JSON.parse(read("staging-manifest.json")) as {
  entries: { to: string }[];
};
const pkg = JSON.parse(read("package.json")) as {
  main: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The lines of one top-level YAML block, without its key line. */
function block(key: string): string {
  const match = new RegExp(`^${key}:\\n((?:[ #].*\\n|\\n)+)`, "m").exec(config);
  expect({ key, found: match !== null }).toEqual({ key, found: true });
  return match?.[1] ?? "";
}

describe("electron-builder.yml", () => {
  it("ships every staged directory as a resource, from staging/ itself", () => {
    const resources = block("extraResources");
    // electron-builder drops a node_modules at the root of a `from`, so a
    // per-directory entry would ship the backend without its dependencies.
    expect(resources).toMatch(/^ {2}- from: staging\n {4}to: \.\n/);
    expect(resources).not.toMatch(/from: staging\//);
    const shipped = [...resources.matchAll(/^ {6}- (\w+)\/\*\*$/gm)].map(
      (m) => m[1],
    );
    const staged = [
      ...new Set(manifest.entries.map((entry) => entry.to.split("/")[0])),
    ];
    expect(shipped.sort()).toEqual(staged.sort());
  });

  it("packs the compiled shell and leaves out tests and the PostgreSQL packages", () => {
    const files = block("files");
    expect(pkg.main).toBe("dist/electron-main.js");
    for (const line of [
      "- package.json",
      "- dist/**",
      '- "!dist/test-support{,/**}"',
      '- "!dist/**/*.spec.js"',
      '- "!dist/**/*.fake.js"',
      '- "!**/node_modules/@embedded-postgres{,/**}"',
    ]) {
      expect(files).toContain(line);
    }
    expect(config).toMatch(/^asar: true$/m);
  });

  it("builds a per-user x64 NSIS installer with the updater's metadata", () => {
    const nsis = block("nsis");
    for (const line of [
      "oneClick: false",
      "perMachine: false",
      "allowToChangeInstallationDirectory: true",
      "include: build/installer.nsh",
      "artifactName: Monize-Setup-${version}.${ext}",
      "deleteAppDataOnUninstall: false",
    ]) {
      expect(nsis).toContain(`  ${line}\n`);
    }
    // Left on (the default), so the build writes the blockmap the updater
    // downloads differences with.
    expect(nsis).not.toMatch(/differentialPackage:\s*false/);
    expect(block("win")).toMatch(/target: nsis\n\s+arch:\n\s+- x64\n/);
    expect(block("publish")).toMatch(
      /provider: github\n\s+owner: kenlasko\n\s+repo: monize\n/,
    );
    expect(config).not.toMatch(/^electronVersion:/m);
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies["electron-builder"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("names build resources that exist", () => {
    for (const file of ["build/icon.ico", "build/installer.nsh"]) {
      expect(config).toContain(file);
      expect({ file, exists: existsSync(join(desktopRoot, file)) }).toEqual({
        file,
        exists: true,
      });
    }
  });
});

describe("the dist script", () => {
  it("typechecks, builds, stages with WebP required, then packages without publishing", () => {
    expect(pkg.scripts.dist).toBe(
      "npm run typecheck && npm run build && npm run stage -- --require-webp && electron-builder --win --publish never",
    );
  });
});

describe("build/installer.nsh", () => {
  const define = (name: string): string | undefined =>
    new RegExp(`^!define ${name} "?([^"\\n]+)"?$`, "m").exec(nsh)?.[1];

  it("protects the folder the application keeps its data in", () => {
    const dataDir = resolveDataDir({
      env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
      platform: "win32",
      isPackaged: true,
      resourcesPath: "C:\\x\\resources",
      desktopRoot: "C:\\x",
      homeDir: "C:\\Users\\a",
    });
    expect(dataDir).toBe(
      `C:\\Users\\a\\AppData\\Local\\${define("MONIZE_DATA_DIR_NAME")}`,
    );
  });

  it("stops the application with the flag the shell understands, and outwaits it", () => {
    expect(nsh).toContain(
      `'"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" ${QUIT_FLAG}'`,
    );
    expect(Number(define("MONIZE_QUIT_TIMEOUT_MS"))).toBeGreaterThan(
      QUIT_WAIT_MS,
    );
  });

  it("defines the hooks the template inserts, each once", () => {
    for (const hook of [
      "customHeader",
      "customInit",
      "customInstallMode",
      "customCheckAppRunning",
      "customUnInstall",
      "customUnInstallSection",
    ]) {
      const count = nsh.split(`\n!macro ${hook}\n`).length - 1;
      expect({ hook, count }).toEqual({ hook, count: 1 });
    }
  });

  it("removes data only from the unticked checkbox or the explicit switch, never on an update", () => {
    expect(nsh).toMatch(/Section \/o "un\.\$\{MONIZE_TXT_REMOVE_DATA\}"/);
    expect(define("MONIZE_REMOVE_DATA_SWITCH")).toBe("--remove-data");
    const remove = /Function un\.MonizeRemoveData\n([\s\S]*?)FunctionEnd/.exec(
      nsh,
    )?.[1];
    expect(remove).toMatch(
      /^\s*;.*\n\s*;.*\n\s*\$\{If\} \$\{isUpdated\}\n\s*Return/,
    );
  });
});
