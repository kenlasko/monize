import { contextBridge, ipcRenderer, IpcRendererEvent } from "electron";

/**
 * The splash page's preload: three channels and nothing else. The page gets
 * `window.monizeSplash` with `onView`, `retry` and `quit`; it never sees
 * `ipcRenderer` itself. Sandboxed, so the channel names are a copy of
 * `shell/splash-channels.ts`, held equal by `splash-preload.spec.ts`.
 */

export const SPLASH_API_KEY = "monizeSplash";
export const SPLASH_CHANNELS = {
  view: "monize-splash:view",
  retry: "monize-splash:retry",
  quit: "monize-splash:quit",
} as const;

export interface SplashApi {
  onView(listener: (view: unknown) => void): void;
  retry(): void;
  quit(): void;
}

export const splashApi: SplashApi = {
  onView(listener) {
    ipcRenderer.on(SPLASH_CHANNELS.view, (_event: IpcRendererEvent, view) =>
      listener(view),
    );
  },
  retry: () => ipcRenderer.send(SPLASH_CHANNELS.retry),
  quit: () => ipcRenderer.send(SPLASH_CHANNELS.quit),
};

contextBridge.exposeInMainWorld(SPLASH_API_KEY, splashApi);
