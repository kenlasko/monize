# Frontend: the shell contract

What the web app offers to a native shell that hosts it: the Electron window on Windows and the Capacitor WebView on Android. Read this before adding code that asks "am I inside a shell?", before touching the push enable controls, and before building or changing a shell.

This is a contract, not a framework. The shells share no code; they share these rules, written once so neither plan has to restate them. `docs/future-plans/windows-installer.md` (section 3, decisions D10 and D11) and `docs/future-plans/android-offline-app.md` describe the shells.

**Status.** The page's side is implemented: `frontend/src/lib/shell.ts` holds the detection helper and the capability table, and the two push controls honour it. The Electron shell and the Capacitor shell are planned; this document is what the Electron preload and the Capacitor layer are built against, and a deviation from it is a change to this document first.

## A shell announces itself with one flag

`window.__MONIZE_SHELL__` is either absent or `{ kind: 'electron' | 'capacitor', version: string }`. Absent means an ordinary browser, installed PWA included.

The Electron preload sets it through `contextBridge.exposeInMainWorld` with `contextIsolation` on, so it exists before any page script runs and the page's own scripts cannot replace the preload's object. A shell that set it from a page-injected script after load would race the helper's first read.

The flag is data and nothing else. The Electron preload exposes exactly one other key, `window.__MONIZE_SHELL_NOTIFICATIONS__`, the notification bridge described in "Native notifications"; no other key, and no other function, crosses into the page.

The page reads the flag in one helper, `detectShell()` in `frontend/src/lib/shell.ts`. It returns the flag when present and well-formed (a `kind` the capability table knows and a string `version`; anything else counts as absent); otherwise it duck-types `window.Capacitor` and answers `capacitor`, unless the object's `isNativePlatform()` answers false, which is Capacitor's web build running in a plain browser. The fallback is there because the Android plan already detects Capacitor that way and its bridge does not set the flag, so that plan needs no change. The helper never answers "browser" for a shell: a feature written as "not a browser" would treat the Electron window as a browser and offer push that cannot work there.

The page owns the helper, and no component reads `window.__MONIZE_SHELL__`, `window.__MONIZE_SHELL_NOTIFICATIONS__` or `window.Capacitor` directly, so a new shell kind or a renamed flag changes one file.

## The page asks for capabilities, not kinds

The page branches on four capabilities, derived from `kind` in one helper the page owns (the same module as `detectShell()`):

- `canReceivePush`: true in a browser that has the Push API, true in `capacitor` once FCM is built, false in `electron` (see Notifications).
- `opensExternalLinksNatively`: true when the shell itself sends a foreign-origin navigation to the system browser (see External links).
- `supportsDeepLinks`: true when the operating system hands `monize://` URLs to the shell (see Deep links).
- `receivesNotificationsNatively`: true when the shell raises the operating system's own notifications from what the page publishes to it (see Native notifications). It is not push and does not change `canReceivePush`. It is the one capability that also needs the shell's side to be present: the table says yes for `electron`, and the helper answers true only if the bridge key is there too, so a page newer than its shell never says notifications appear when nothing would show them.

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
- **Electron:** no Web Push, because the Electron window has no push service to register with, so `canReceivePush` stays false. The shell raises native notifications instead, from the rows the page reads in its own notification centre (`receivesNotificationsNatively`, see Native notifications); they appear while Monize runs, the window hidden to the tray included. The tray's "Open in browser" still reaches the installed PWA and its push against the same server.
- **Capacitor:** FCM through the native layer, because Android WebView has no Push API. The Android plan defers FCM past its first release, so until then `canReceivePush` is false for `capacitor` too.

`PushEnableBanner` (`frontend/src/components/layout/PushEnableBanner.tsx`) and the push settings panel (`frontend/src/components/settings/PushDevicesPanel.tsx`) gate on `pushUnavailableShell()`, which answers only for a shell whose `canReceivePush` is false; a browser keeps its own states (blocked, needs installing, unsupported) from `frontend/src/lib/push.ts` untouched. Inside such a shell the banner renders nothing, because its only purpose is to offer Enable and a prompt for something the reader cannot do is worse than none; the settings panel hides its Enable control and says why in place of it, with the shell's own remedy. Where `receivesNotificationsNatively` is true the panel says instead that notifications appear on this PC while Monize runs, so there is nothing to enable (`settings.notifications.push.native`). A silent hide in the panel is a defect: the user would look for the setting and conclude the feature is broken. A shell that gains push later flips the capability, and no component changes.

## Native notifications

The Electron shell shows the notification centre's unread rows as the operating system's notifications. The page polls; the shell decides and shows. The pieces are `useShellNotificationBridge` (`frontend/src/hooks/useShellNotificationBridge.ts`) with its pure half in `frontend/src/lib/shell-notifications.ts`, the publish helper in `frontend/src/lib/shell.ts`, the preload (`desktop/src/preload.ts`), the snapshot check (`desktop/src/shell/notification-snapshot.ts`), the state machine (`desktop/src/shell/notification-bridge.ts`) and the glue that raises them (`desktop/src/notifications.ts`).

**The page polls, with its own session.** Mounted in the authenticated shell, the hook reads `GET /notifications` every minute through `notificationsApi`, the bell's own client, so the request carries the page's cookies, refreshes and CSRF exactly as the bell's does, and the shell never holds, reads or replays a credential (see "Auth is not bypassed"). It reads the full list, not `unreadOnly`, because that read is what materializes bill reminders. A failed read doubles the wait, up to 15 minutes. A hidden window keeps polling: Chromium throttles a hidden page's timers to about once a minute, which this interval already is. The page, not the main process, is the caller because only the page knows who is signed in and can refresh an expired access token; a main-process request with the window's cookies would stop working once the access token expired and could not tell one person from the next.

**The snapshot.** After each read the page calls `window.__MONIZE_SHELL_NOTIFICATIONS__.publish({ identity, rows })`, through `publishNotificationsToShell()`: `identity` is the signed-in user's id, or `null` when nobody is signed in or the reader is acting for another account; `rows` are the unread rows, each `{ id, createdAt, title, body, target }`. The page says nothing while its auth store is still hydrating after a reload, rather than briefly reporting nobody, and drops a response that arrives after the person changed. The title and body are the same generic per-category copy Web Push sends (`notifications.native.<category>`, mirroring the server's `push.notification.<category>`), because a notification can show on a locked screen and a row's own text carries amounts and names; the row, one click away, has the detail. `target` is the row's path after `safeNotificationTarget`, or `null`.

**The shell decides.** The preload forwards the snapshot over IPC and receives nothing back. The main process accepts it only from the main window's page on the app origin and only in the shape above (bounded lengths, at most 100 rows; anything else is dropped whole), then applies these rules, each held by a spec:

- A row is raised once. The state lives in the main process, so a reload re-publishes without re-raising.
- Nothing created before the floor is raised: the moment the shell started, or the moment the last signed-in person left (signed out, or another person signed in). A launch or a sign-in does not replay history; the bell still has it.
- At most three rows per snapshot, newest first; the rest are counted into one summary notification.
- A raised row that is no longer unread (read or dismissed, in any client) is closed.
- A change of person, sign-out included, closes every notification raised for the previous one; a click on one raised for someone no longer signed in only shows the window.
- On quit every notification is closed and no snapshot is accepted.

**A click** shows the window and loads the row's target on the app origin, resolved and checked against the navigation policy (`desktop/src/shell/navigation.ts`); a missing target, or one that would leave the origin, opens the home page. The click does not mark the row read, as a push click does not.

**What is not covered.** Nothing arrives while Monize is closed: the server runs inside it. The notification matrix's Push column governs Web Push and is not applied: in the window, which has no push device, it is not a live control. Each raise is logged by row id, never its text, in `main.log`.

## Auth is not bypassed

The shell holds no token, no password and no session of its own. The page's same-origin httpOnly cookies are the only session, exactly as in a browser, so the CSRF header, refresh and sign-out behave identically in every shell.

A shell must not read, copy, inject or persist those cookies, must not add an `Authorization` header to the page's requests, and must not log a user in on the page's behalf. The reason is that every shell-side credential store is a second place a session can leak from, and the backend has no login path that returns a token for one to hold. A shell that needs to know whether a user is signed in asks the page, which already knows. The notification bridge is the worked example: the page makes the request and tells the shell who is signed in; the shell makes no request at all.
