import { contextBridge, ipcRenderer } from "electron";

/**
 * The "Set up another device" page's preload: three calls and a change
 * signal. The page gets `window.monizeLanSetup`; it never sees `ipcRenderer`
 * and can pass nothing to the main process, which decides what to save and
 * where. Sandboxed, so the channel names are a copy of
 * `shell/lan-setup-channels.ts`, held equal by `lan-setup-preload.spec.ts`.
 */

export const LAN_SETUP_API_NAME = "monizeLanSetup";
export const LAN_SETUP_CHANNELS = {
  view: "monize-lan:view",
  saveRoot: "monize-lan:save-root",
  replaceRoot: "monize-lan:replace-root",
  changed: "monize-lan:changed",
} as const;

export interface LanSetupApi {
  view(): Promise<unknown>;
  saveRoot(): Promise<unknown>;
  replaceRoot(): Promise<unknown>;
  /** Called whenever the addresses or the certificate change. */
  subscribe(listener: () => void): void;
}

export const lanSetupApi: LanSetupApi = {
  view: () => ipcRenderer.invoke(LAN_SETUP_CHANNELS.view),
  saveRoot: () => ipcRenderer.invoke(LAN_SETUP_CHANNELS.saveRoot),
  replaceRoot: () => ipcRenderer.invoke(LAN_SETUP_CHANNELS.replaceRoot),
  subscribe(listener) {
    ipcRenderer.on(LAN_SETUP_CHANNELS.changed, () => listener());
  },
};

contextBridge.exposeInMainWorld(LAN_SETUP_API_NAME, lanSetupApi);
