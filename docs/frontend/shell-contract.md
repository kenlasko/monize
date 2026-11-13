# Frontend: the shell contract

What the web app offers to a native shell that hosts it: the Electron window on Windows and the Capacitor WebView on Android. Read this before adding code that asks "am I inside a shell?", before touching the push enable controls, and before building or changing a shell.

This is a contract, not a framework. The shells share no code; they share these rules, written once so neither plan has to restate them. `docs/future-plans/windows-installer.md` (section 3, decisions D10 and D11) and `docs/future-plans/android-offline-app.md` describe the shells.

**Status.** The page's side is implemented: `frontend/src/lib/shell.ts` holds the detection helper and the capability table, and the two push controls honour it. The Electron shell and the Capacitor shell are planned; this document is what the Electron preload and the Capacitor layer are built against, and a deviation from it is a change to this document first.

## A shell announces itself with one flag

`window.__MONIZE_SHELL__` is either absent or `{ kind: 'electron' | 'capacitor', version: string }`. Absent means an ordinary browser, installed PWA included.

The Electron preload sets it through `contextBridge.exposeInMainWorld` with `contextIsolation` on, so it exists before any page script runs and the page's own scripts cannot replace the preload's object. A shell that set it from a page-injected script after load would race the helper's first read.

The page reads the flag in one helper, `detectShell()` in `frontend/src/lib/shell.ts`. It returns the flag when present and well-formed (a `kind` the capability table knows and a string `version`; anything else counts as absent); otherwise it duck-types `window.Capacitor` and answers `capacitor`, unless the object's `isNativePlatform()` answers false, which is Capacitor's web build running in a plain browser. The fallback is there because the Android plan already detects Capacitor that way and its bridge does not set the flag, so that plan needs no change. The helper never answers "browser" for a shell: a feature written as "not a browser" would treat the Electron window as a browser and offer push that cannot work there.

The page owns the helper, and no component reads `window.__MONIZE_SHELL__` or `window.Capacitor` directly, so a new shell kind or a renamed flag changes one file.

## The page asks for capabilities, not kinds

The page branches on three capabilities, derived from `kind` in one helper the page owns (the same module as `detectShell()`):

- `canReceivePush`: true in a browser that has the Push API, true in `capacitor` once FCM is built, false in `electron` (see Notifications).
- `opensExternalLinksNatively`: true when the shell itself sends a foreign-origin navigation to the system browser (see External links).
- `supportsDeepLinks`: true when the operating system hands `monize://` URLs to the shell (see Deep links).

A component that tests `kind === 'electron'` has to be found and edited when a third shell appears; one that tests a capability does not. The derivation table is the only place a kind is named.

## Deep links use the `monize://` scheme

A shell registers `monize://` with the operating system. The only route accepted initially is `monize://open/<path>`, which the shell maps onto the same path of the app's own origin (`monize://open/accounts` opens `/accounts`) and loads in its window.

The shell must reject anything else: a host other than `open`, a path that would leave the app's origin, or a URL that fails to parse. The scheme is reachable from any other program and any web page, so it is an input the user did not type. A link never carries a credential and never authenticates: the page it opens applies the ordinary cookie session and sends a signed-out user to login.

New routes under `monize://` are added to this section when a shell implements them. The Android plan does not define deep links today; the section is the shared definition if it adds them.

## External links stay ordinary anchors

A shell that opens links natively intercepts navigations to a foreign origin (anything other than the origin the shell loaded) and hands them to the system browser; the app origin keeps navigating in the window. The page does nothing shell-specific: it keeps using plain anchors, with `target="_blank"` and `rel="noopener noreferrer"` as `docs/frontend/ui-conventions.md` describes.

The reason is that the page must still work in a browser and in a shell that does not intercept, and a page that called a shell API to open links would need a second code path in every component that renders a link. The interception belongs to the shell because only the shell knows where its window may navigate: a foreign page loaded inside the window would run with the shell's privileges.

## Notifications depend on the shell

- **Browser:** Web Push through the service worker, as `docs/frontend/pwa-push-share.md` describes.
- **Electron:** no Web Push, because the Electron window has no push service to register with. The tray offers "Open in browser", where the installed PWA and its push keep working against the same server. A native notification bridge is a later task, and when it exists it sets `canReceivePush` for `electron` and gets its own section here.
- **Capacitor:** FCM through the native layer, because Android WebView has no Push API. The Android plan defers FCM past its first release, so until then `canReceivePush` is false for `capacitor` too.

`PushEnableBanner` (`frontend/src/components/layout/PushEnableBanner.tsx`) and the push settings panel (`frontend/src/components/settings/PushDevicesPanel.tsx`) gate on `pushUnavailableShell()`, which answers only for a shell whose `canReceivePush` is false; a browser keeps its own states (blocked, needs installing, unsupported) from `frontend/src/lib/push.ts` untouched. Inside such a shell the banner renders nothing, because its only purpose is to offer Enable and a prompt for something the reader cannot do is worse than none; the settings panel hides its Enable control and says why in place of it, with the shell's own remedy. A silent hide in the panel is a defect: the user would look for the setting and conclude the feature is broken. A shell that gains push later flips the capability, and no component changes.

## Auth is not bypassed

The shell holds no token, no password and no session of its own. The page's same-origin httpOnly cookies are the only session, exactly as in a browser, so the CSRF header, refresh and sign-out behave identically in every shell.

A shell must not read, copy, inject or persist those cookies, must not add an `Authorization` header to the page's requests, and must not log a user in on the page's behalf. The reason is that every shell-side credential store is a second place a session can leak from, and the backend has no login path that returns a token for one to hold. A shell that needs to know whether a user is signed in asks the page, which already knows.
