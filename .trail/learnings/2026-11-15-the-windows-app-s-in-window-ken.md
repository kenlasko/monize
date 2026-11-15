---
title: "The Windows app's in-window menu asks the shell to pop up the tray's native menu rather than rebuilding it in the page"
author: Ken
date: 2026-11-15
branch: feat/desktop-shell-menu
cost: { minutes: 18, tokens: 182645 }
id: l-04cd5408
scope: repo
status: active
src: agent
touches:
  - frontend/src/i18n/messages/de/help.json
  - frontend/src/i18n/messages/es/help.json
  - frontend/src/i18n/messages/fr/help.json
  - frontend/src/i18n/messages/hi/help.json
  - frontend/src/i18n/messages/id/help.json
  - frontend/src/i18n/messages/it/help.json
  - frontend/src/i18n/messages/ja/help.json
  - frontend/src/i18n/messages/ko/help.json
  - frontend/src/i18n/messages/nl/help.json
  - frontend/src/i18n/messages/pl/help.json
---

## Decided
The tray's items are reachable inside the window two ways, both built by the
main process from the tray's own model and handlers: the menu bar (Alt, then
the "Monize" menu) and a "Desktop app menu" entry in the page's Help menu that
asks the shell to pop the native menu up at the pointer. The page's request
carries no data and receives nothing, so the bridge stays one-way like the
notification bridge, menu state (update progress, the login tick) never has to
be synced to the page, and new tray items show up in the window for free.

## Tried and ruled out
- Rebuilding the menu as a React dropdown: needs a two-way bridge for the
  update/login state (the shell contract forbids the shell sending to the
  page), a command per item, and ~10 desktop strings copied into 18 locales.
- The menu bar alone: the window hides it (autoHideMenuBar), so few would
  find it.

## Watch out
- Before this, the shell never set an application menu, so Electron's default
  (with electronjs.org Help links) was in use; the new bar keeps Electron's
  Edit/View/Window roles, View still has Toggle Developer Tools.
- The application menu is global: the log viewer and popup windows get it
  too. The popup request is accepted only from the main window's page on the
  app origin.
- Both are torn down when a data-folder move or quit begins, like the tray.

In the code: desktop/src/window-menus.ts, windowMenuModel in
desktop/src/shell/tray-model.ts, desktop/src/shell/ipc-sender.ts,
__MONIZE_SHELL_MENU__ / monize:shell-menu in desktop/src/preload.ts,
offersShellMenu/openShellMenu in frontend/src/lib/shell.ts,
docs/frontend/shell-contract.md "The shell menu".
