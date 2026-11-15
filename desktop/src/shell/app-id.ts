/**
 * The application's identity on Windows: the AppUserModelID. The installer
 * stamps the same string on the Start Menu and desktop shortcuts
 * (`appId` in `electron-builder.yml`), and Windows groups the running
 * window under the shortcut, and attributes its notifications to it, only
 * when the process declares the id the shortcut carries.
 * `app-id.spec.ts` holds the two strings equal.
 */
export const APP_ID = "com.monize.desktop";
