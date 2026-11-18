---
title: "Chrome on Android shows too-many-retries on the LAN address when it lacks Android's local network permission, not because of a proxy or certificate fault"
author: Ken
date: 2026-11-18
branch: feat/desktop-lan-access
cost: { minutes: 20, tokens: 119085 }
id: l-3e33e2eb
scope: repo
status: active
src: agent
touches:
  - desktop/src/lan/lan-proxy.ts
  - desktop/src/lan/certificate-authority.ts
  - desktop/src/lan/mdns.ts
  - desktop/src/lan/tls-store.ts
  - desktop/src/shell/lan-strings.ts
  - desktop/src/lan-setup/lan-setup.html
  - desktop/src/lan-setup/lan-setup-page.ts
  - desktop/src/lan-setup/lan-setup.css
  - desktop/src/lan-setup.ts
  - website/docs/windows.md
---

## Decided
When Chrome on Android shows ERR_TOO_MANY_RETRIES for the desktop LAN address, the fix is on the phone, not in Monize. Chrome lacks Android's OS-level local network permission. Every TCP connect is blocked before it reaches the PC, Chrome asks the platform for the permission, gets nothing, and restarts the request. After 32 restarts it gives up with TOO_MANY_RETRIES.
If Firefox for Android loads the LAN site with no warning page but the padlock says "Connection not secure", the root is trusted. A certificate exception saved earlier ("Accept the risk and continue", from before the root was installed) still matches the server certificate. GeckoView marks a page not secure whenever such an exception matches, even though the connection now validates. The fix is to give the server a new certificate. Quit Monize, delete `tls/server.crt` under the app's data directory, and restart. `loadServer` in `desktop/src/lan/tls-store.ts` reissues from the same root, so devices need no changes. Confirmed by the user, Nov 2026.
The user confirmed Chrome on Android already had the local network permission. Clearing Chrome's storage (Android Settings > Apps > Chrome > Storage > Clear storage) fixed ERR_TOO_MANY_RETRIES, just as it fixed Firefox's "not secure" padlock. So the -36 (ERR_LOCAL_NETWORK_PERMISSION_MISSING) loop in the net-export log most likely came from a per-site local-network decision Chrome had stored earlier, not from the OS-level permission. The setup window and the Windows user guide now tell users not to accept the certificate warning, and to clear the browser's storage if they already did.

In the code: the strings warningHeading, warningBody and warningRecovery in desktop/src/shell/lan-strings.ts, and "Setting Up a Device" in website/docs/windows.md.

## Tried and ruled out
- Faults in `desktop/src/lan/lan-proxy.ts` (first-byte sniff, HTTP/1.1 only, clientError destroy): no TCP connection ever reached the PC, so no TLS handshake happened.
- Keep-alive or socket reuse retries (HandleIOError).
- Certificate restarts from `desktop/src/lan/certificate-authority.ts`.
- HSTS.
- DNS from `desktop/src/lan/mdns.ts`: monize.local resolved to 192.168.1.2 correctly.
- Mixed content: the login page loads only same-origin files, and its security policy blocks http://.
- Whether the root is built in: GeckoView's secure flag doesn't depend on it.
- Clearing browsing data, and private tabs: the exception check uses the normal-mode store with empty origin attributes, so private tabs see the same exception. None of GeckoView's clear-data categories except ALL includes certificate exceptions, and Fenix's "Delete browsing data" doesn't use ALL.

## Watch out
- Chrome's error page shows only TOO_MANY_RETRIES. The real error (-36, ERR_LOCAL_NETWORK_PERMISSION_MISSING) appears only in a chrome://net-export log.
- Firefox on the same phone can connect, because the permission is granted per app.

In the code:
- In the net-export log, look for URL_REQUEST_DELEGATE_PLATFORM_LOCAL_NETWORK_ACCESS_PERMISSION_REQUIRED events. A failed request shows 32 of them.
- TCP_CONNECT ends with net_error -36 (os_error 115).
- The request ends with REQUEST_ALIVE net_error -375.
- Seen in Chrome 157 on Android, Nov 2026. The desktop LAN-access setup docs should tell users to allow Chrome's local network (Nearby devices) permission.
- An exception is saved per host and port, so the IP address and monize.local can each hold one.
- Desktop Firefox on the same PC looks fine because it never saved an exception.
- Android Settings → Firefox → Clear storage also works, but it wipes all of Firefox's data on the phone.

- GeckoView: mobile/shared/modules/geckoview/GeckoViewProgress.sys.mjs, `IdentityHandler.checkIdentity`, which sets `result.secure = !result.securityException`.
- GeckoView: GeckoViewStorageController.sys.mjs, ClearFlags. Only the ALL flag includes CLEAR_CERT_EXCEPTIONS.
- The desktop LAN setup docs should tell users to remove such an exception, or to reissue the server certificate.
