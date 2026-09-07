/**
 * Loading OpenCV.js, and the one place it is reached from.
 *
 * It is deliberately NOT imported through the module graph, and that is not a
 * bundling preference. The package's entry point *is* a Promise, so its ES
 * module namespace has a `then` binding -- and a namespace with a `then` is
 * treated as thenable by the loader, which then calls it with the namespace as
 * receiver and throws `Promise.prototype.then called on incompatible receiver`.
 * A static import, a dynamic import and `Promise.resolve` on the namespace all
 * fail that way, and the failure takes down the whole module, not just the
 * scan.
 *
 * Loading it as a script at runtime avoids the hazard entirely, and is how
 * OpenCV.js is meant to be used: it installs `globalThis.cv` and resolves when
 * the WebAssembly runtime is up. Keeping that here -- and importing this module
 * only from the worker -- is also what keeps several megabytes out of every
 * page's chunks (`I7`); `document-scan.guard.test.ts` fails a second reference.
 */

/** The subset of OpenCV this feature uses, named so the pipeline is typed. */
export type OpenCv = typeof import('@techstark/opencv-js');

/**
 * Where the browser fetches the engine from.
 *
 * Served from our own origin rather than a CDN: the CSP allows scripts from
 * `self` only, and a document a user is scanning should not cause a request to
 * a third party.
 */
export const OPENCV_SCRIPT_URL = '/vendor/opencv/opencv.js';

let pending: Promise<OpenCv> | null = null;

/** Whether a value is the initialised namespace rather than a promise for one. */
function isReadyNamespace(value: unknown): value is OpenCv {
  return !!value && typeof (value as { Mat?: unknown }).Mat === 'function';
}

/**
 * Settle whatever `cv` currently is into the initialised namespace.
 *
 * The global is a Promise before the runtime is up and the namespace after, and
 * which one a caller sees depends on nothing it controls -- so both are handled
 * rather than assumed.
 */
async function settleGlobal(): Promise<OpenCv> {
  const current = (globalThis as { cv?: unknown }).cv;
  if (isReadyNamespace(current)) return current;
  const resolved = await (current as Promise<unknown>);
  if (isReadyNamespace(resolved)) return resolved;
  // Some builds resolve to the module rather than installing it globally.
  const afterwards = (globalThis as { cv?: unknown }).cv;
  if (isReadyNamespace(afterwards)) return afterwards;
  throw new Error('The document scanner engine failed to initialise');
}

/** Load the engine in a classic worker, where `importScripts` is available. */
async function loadInWorker(): Promise<OpenCv> {
  (globalThis as unknown as { importScripts(url: string): void }).importScripts(
    OPENCV_SCRIPT_URL,
  );
  return settleGlobal();
}

/** Load the engine on a page, by appending a script tag. */
async function loadInDocument(): Promise<OpenCv> {
  await new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${OPENCV_SCRIPT_URL}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener(
        'error',
        () => reject(new Error('The document scanner engine failed to load')),
        { once: true },
      );
      // Already finished loading before we attached a listener.
      if ((globalThis as { cv?: unknown }).cv) resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = OPENCV_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () =>
      reject(new Error('The document scanner engine failed to load'));
    document.head.appendChild(script);
  });
  return settleGlobal();
}

/**
 * Load the engine under Node, for the unit suites.
 *
 * `createRequire` reaches the package outside the ES module graph, which is
 * exactly what makes it work where an import does not. Test-only by nature --
 * a browser has no `require` -- so the browser paths above are what the
 * end-to-end spec exercises.
 */
async function loadInNode(): Promise<OpenCv> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const loaded: unknown = require('@techstark/opencv-js');
  if (isReadyNamespace(loaded)) return loaded;
  const resolved = await (loaded as Promise<unknown>);
  if (!isReadyNamespace(resolved)) {
    throw new Error('The document scanner engine failed to initialise');
  }
  return resolved;
}

/**
 * Resolve the initialised OpenCV namespace, loading it at most once.
 *
 * The promise is cached rather than the resolved value, so two dialogs opening
 * at once share one initialisation instead of racing two downloads.
 */
export function loadEngine(): Promise<OpenCv> {
  if (!pending) {
    pending = (async () => {
      if (isReadyNamespace((globalThis as { cv?: unknown }).cv)) {
        return settleGlobal();
      }
      if (
        typeof (globalThis as { importScripts?: unknown }).importScripts ===
        'function'
      ) {
        return loadInWorker();
      }
      // Node comes BEFORE the document branch, because jsdom provides a
      // `document` while being a Node process: taking the script-tag path there
      // waits forever on a fetch jsdom does not make. A browser bundle has no
      // `process.versions.node`, so this can never win in one.
      if (
        typeof process !== 'undefined' &&
        typeof process.versions?.node === 'string'
      ) {
        return loadInNode();
      }
      if (typeof document !== 'undefined') {
        return loadInDocument();
      }
      throw new Error('The document scanner engine cannot be loaded here');
    })().catch((error: unknown) => {
      // A failed load must not poison every later attempt: the next call starts
      // again rather than replaying this rejection forever.
      pending = null;
      throw error;
    });
  }
  return pending;
}

/** Drop the cached engine. Exists for tests; the app loads it once. */
export function resetEngineForTests(): void {
  pending = null;
}
