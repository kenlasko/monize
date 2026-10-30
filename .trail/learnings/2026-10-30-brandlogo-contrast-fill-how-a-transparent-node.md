---
title: "BrandLogo contrast fill: how a transparent logo gets its backing"
author: Node
date: 2026-10-30
branch: claude/issue-1945
cost: { minutes: 11, tokens: 89421 }
touches:
  - docs/frontend/ui-conventions.md
  - frontend/src/components/ui/BrandLogo.test.tsx
  - frontend/src/components/ui/BrandLogo.tsx
  - frontend/src/lib/logo-backing.test.ts
  - frontend/src/lib/logo-backing.ts
---

## Decided
- Maintainer chose a client-side check (option 1), a plain fill (no ring), for payee and institution logos alike. It lives in frontend/src/lib/logo-backing.ts and is applied in components/ui/BrandLogo.tsx on the img's onLoad.
- The classification is pure (classifyLogoPixels): read only the inscribed circle of a 32px redraw. Less than 15% see-through means the icon paints its own background, so no fill. Otherwise take the dominant 3-bit-per-channel bucket of ink pixels (alpha >= 128) and compare it with THEME_SWATCHES.default light/dark cards. Below 2:1 contrast the result is 'light' (dark:bg-white) or 'dark' (bg-gray-800, dark:bg-transparent).
- Theme switching is handled by Tailwind dark: variants, not useTheme, so BrandLogo needs no theme context and its 16 consumers were untouched.
- The inset comes from a --brand-logo-inset CSS variable (size/10) through p-(--brand-logo-inset), so padding applies only in the mode where the fill shows.

## Tried and ruled out
- A 3:1 (WCAG non-text) threshold: it fills ordinary brand oranges and light greens on white. 2:1 catches only near-matches.
- Returning the cached answer on load: a payee logo is refetched under the same URL when its website changes, so every load re-reads the pixels. The cache only seeds the first paint on a remount.

## Watch out
- --color-white is themed (each palette's light paper) but never redefined in dark blocks, so dark:bg-white is light in every palette. The gray ramp is dark at 800 in light mode in every palette.
- jsdom has no 2D canvas. Tests spy on HTMLCanvasElement.prototype.getContext and must stub clearRect, drawImage and getImageData. The module reuses one context, so call clearLogoBackingCache() in afterEach.
