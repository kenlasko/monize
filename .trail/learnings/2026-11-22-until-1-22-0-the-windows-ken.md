---
title: "Until 1.22.0 the Windows docs send people to the beta, because no stable release has a Windows installer"
author: Ken
date: 2026-11-22
branch: docs/windows-1-22-beta
cost: { minutes: 2, tokens: 70686 }
id: l-48280afd
scope: repo
status: active
src: agent
touches:
  - README.md
  - website/docs/search-index.json
  - website/docs/windows.html
  - website/docs/windows.md
  - website/index.html
  - website/assets/js/app.js
---

## Decided
Ken decided (2026-11-22) that 1.22.0 is the first official release of Monize for Windows. Until it ships, every place that offers the Windows download points to the one "Windows beta" prerelease and says releases up to 1.21.0 have no installer. Before this, the docs pointed at the latest release (1.21.0), which has no installer, and people were confused.

## Watch out
- When 1.22.0 ships, remove the beta notes and list the Release channel first again. They are in three places: the Windows guide's Download section, the README's "Windows (single PC)" section plus its feature-list line, and the "Just one Windows PC?" card on the site's home page.
- The site's "Download for Windows" button only turns into a direct download when the GitHub latest release has a Monize-Setup-*.exe asset. Until then it stays on the guide's download section, so that section has to say where the beta is.

In the code: website/docs/windows.md (#download), README.md, website/index.html, website/assets/js/app.js (winAsset, data-win-download). After editing the .md, regenerate with `npm run docs:build` in frontend/.
