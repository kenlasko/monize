---
title: "Installer progress lines must be short, because the window's status line cuts off long text"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-e674648f
scope: repo
status: active
src: agent
touches:
  - desktop/README.md
  - desktop/build/installer.nsh
---

## Decided
Every line the installer prints while it works (the DetailPrint text defines) is kept to one short sentence. Ken saw the long "tens of thousands of files..." line cut off on a real Windows install, so it became "Copying files... this will take some time." The explanation of why the step is slow lives in the README, not in the installer.

## Tried and ruled out
A long explanatory line before the file step: the details list shows it, but the status line above the progress bar shows only the start of it, and that is where people look.

## Watch out
makensis -WX through the harness cannot catch this: it only proves the script compiles. Text length is only checked by installing on Windows. "Checking the installation folder and closing Monize if it is running..." is the next longest and may need the same treatment.

In the code:
- desktop/build/installer.nsh: MONIZE_TXT_CHECKING, MONIZE_TXT_UNPACKING, MONIZE_TXT_INSTALLED
