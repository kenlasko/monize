import { TargetProblem } from "../move/target";
import { MovePhase } from "../move/move-types";

/**
 * The text of "Move data folder". Part of `TEXT` (`strings.ts`, as
 * `TEXT.move`); kept in its own file only for size.
 */

const TARGET_PROBLEMS: Readonly<Record<TargetProblem, string>> = {
  "not-absolute": "That is not a full folder path.",
  unstorable:
    "The folder's name contains a character the database cannot work with " +
    "(a quotation mark, or a line break). Choose a folder with a plainer name.",
  network:
    "That folder is on a network share. The database needs a disk in this " +
    "computer; on a share it can be damaged when the connection drops.",
  root: "That is a whole drive. Choose or create a folder on it, for example one named Monize.",
  same: "That is the folder your data is already in.",
  "inside-data":
    "That folder is inside the folder your data is in now. Choose a folder somewhere else.",
  "inside-default":
    "That folder is inside Monize's original data folder, which the " +
    "uninstaller can remove. Choose a folder somewhere else.",
  "inside-install":
    "That folder is where Monize itself is installed. Every update deletes " +
    "everything in the installation folder, so your data would be lost.",
  "parent-missing":
    "The folder that would contain it does not exist. Create it first, or choose an existing empty folder.",
  "not-a-folder": "That is a file, not a folder.",
  "not-empty":
    "That folder already contains files. Choose an empty folder, or create a new one.",
  leftover:
    "Next to that folder there is already a folder with the same name ending " +
    "in .monize-partial. Delete it, or choose another folder.",
  "no-space": "There is not enough free space there.",
};

const PHASES: Readonly<Record<MovePhase, string>> = {
  stopping: "Stopping Monize and its database...",
  preparing: "Getting ready to copy...",
  copying: "Copying your data...",
  verifying: "Checking the copy...",
  switching: "Switching to the new folder...",
};

export const MOVE_TEXT = {
  trayItem: "Move data folder...",

  notMovableTitle: "The data folder cannot be moved right now",
  envOverride:
    "This Monize was started with the MONIZE_DATA_DIR setting, which names " +
    "the data folder for one launch and wins over a move. Start Monize " +
    "without it to move the data folder.",
  updateRunning:
    "An update is being checked for, downloaded or installed. Try again when it has finished.",

  oldCopyPending:
    "The copy your data was moved from last time is still on this " +
    "computer. Monize asks about it each time it starts: choose to delete " +
    "it or to keep it, then move the data folder again.",

  pickTitle: "Choose an empty folder for your Monize data",
  pickButton: "Move here",

  refusedTitle: "Monize cannot move your data there",
  targetProblem: TARGET_PROBLEMS,
  spaceDetail: (needed: string, free: string) =>
    `The move needs ${needed}; ${free} is free.`,

  confirmTitle: "Move your Monize data?",
  confirmDetail: (from: string, to: string, size: string, files: number) =>
    `From: ${from}\nTo: ${to}\nSize: ${size} in ${files} files\n\n` +
    "Monize stops, copies everything, checks the copy file by file, and " +
    "opens again from the new folder. Nothing is deleted: the old folder " +
    "stays as it is until you choose to delete it. You will be asked to " +
    "sign in again.\n\n" +
    "Choose a disk that is always connected to this computer. A folder " +
    "outside your user profile may be readable by other accounts on this " +
    "computer.",
  confirmMove: "Move",

  progressTitle: "Moving your data",
  phase: PHASES,
  progressDetail: (
    phase: string,
    done: string,
    total: string,
    percent: number,
  ) => `${phase} ${done} of ${total} (${percent}%)`,
  progressKeepOpen: "Do not turn the computer off.",

  failedTitle: "Your data was not moved",
  failedDetail: (from: string, reason: string) =>
    `Monize is still using ${from}; nothing in it was changed.\n\n${reason}`,
  failedLeftover: (folders: string) =>
    `An incomplete copy could not be removed and can be deleted by hand: ${folders}`,
  uncertainDetail: (reason: string) =>
    "The copy finished, but recording the new folder failed and Monize " +
    "cannot tell which folder is current. Nothing was deleted; Monize works " +
    `it out when it opens again.\n\n${reason}`,
  restart: "Restart Monize",

  interruptedTitle: "A move of your data did not finish",
  interruptedDetail: (to: string, current: string) =>
    `The move to ${to} was interrupted before it completed. Monize is ` +
    `still using ${current}, where nothing was changed, and the incomplete ` +
    "copy was removed. You can start the move again from the tray icon.",
  interruptedLeftover: (folders: string) =>
    `The incomplete copy could not be removed and can be deleted by hand: ${folders}`,

  bootFailedTitle: "Monize could not start from the new folder",
  bootFailedDetail: (to: string, from: string) =>
    `Your data was moved to ${to}, and Monize has not been able to start ` +
    `there. The previous folder, ${from}, is untouched. Going back makes ` +
    "Monize use it again; the new folder is kept so you can look at what " +
    "went wrong.",
  goBack: "Go back to the previous folder",
  keepTrying: "Stay here",
  rollbackRefusedTitle: "Monize could not go back",
  rolledBackTitle: "Monize is using the previous folder again",

  missingTitle: "Monize cannot find its data folder",
  missingDetail: (dir: string) =>
    `Your Monize data was moved to ${dir}, and that folder is not there ` +
    "now, or no longer holds Monize data. If it is on a drive that is not " +
    "connected, connect it and start Monize again. Monize has not created " +
    "anything in its place.",
  movedAwayTitle: "This folder's data was moved",
  movedAwayDetail: (dir: string, to: string) =>
    `Monize was asked to open ${dir}, but its data was moved` +
    `${to === "" ? "" : ` to ${to}`}. This copy is out of date, so Monize ` +
    "will not open it: anything entered here would be missing from the " +
    "real data. To use this copy anyway, delete the file " +
    "moved-elsewhere.json from it.",

  cleanupTitle: "Delete the old copy of your data?",
  cleanupDetail: (current: string, old: string) =>
    `Monize now keeps your data in ${current}. The copy it was moved ` +
    `from is still in ${old}. Look through your accounts first; once you ` +
    "are satisfied everything is here, the old copy can be deleted. " +
    "Deleting it cannot be undone.",
  cleanupDelete: "Delete the old copy",
  cleanupKeep: "Keep it",
  cleanupLater: "Ask me next time",
  cleanupDoneTitle: "The old copy was deleted",
  cleanupFolderRemains: (old: string) =>
    `${old} still holds files Monize did not create, so the folder itself was left.`,
  cleanupFailedTitle: "The old copy was not deleted",
} as const;
