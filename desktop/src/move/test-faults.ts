import { MoveFs } from "./move-types";

/**
 * Faults for exercising a move's failure paths end to end. A development
 * build can be started with `--test-move-fault=<name>` (`move-data.ts`
 * refuses the flag in a packaged build), and the specs use the same faults,
 * so the failure a person sees is the one the tests drive.
 */

export const MOVE_FAULTS = ["copy", "verify", "pointer"] as const;
export type MoveFault = (typeof MOVE_FAULTS)[number];

export function isMoveFault(value: string): value is MoveFault {
  return (MOVE_FAULTS as readonly string[]).includes(value);
}

/** How many files copy before the `copy` fault stops the disk. */
export const COPY_FAULT_AFTER = 20;

export function withFault(fs: MoveFs, fault: MoveFault): MoveFs {
  switch (fault) {
    case "copy": {
      let copied = 0;
      return {
        ...fs,
        async copyFile(from, to, mode) {
          copied += 1;
          if (copied > COPY_FAULT_AFTER) {
            throw new Error("injected fault: the disk stopped accepting data");
          }
          return fs.copyFile(from, to, mode);
        },
      };
    }
    case "verify": {
      let corrupted = false;
      return {
        ...fs,
        async digest(path) {
          const digest = await fs.digest(path);
          if (corrupted || digest.size === 0) return digest;
          corrupted = true;
          return { ...digest, sha256: "0".repeat(64) };
        },
      };
    }
    case "pointer":
      return {
        ...fs,
        async writeFileAtomic(path, data) {
          if (path.endsWith("-location.ini")) {
            throw new Error("injected fault: the pointer could not be written");
          }
          return fs.writeFileAtomic(path, data);
        },
      };
  }
}
