# Plan: the help panel (in-app help, plan 2)

Part of `docs/future-plans/in-app-help.md`; needs plan 1's help API
(`docs/future-plans/in-app-help-bundled-docs.md`). The `?` icon on each page
opens the matching section of the guide in a panel inside the app, instead of a
new browser tab. One PR, frontend only.

## Assumptions (verified against the tree, 2026-11)

- `PageHeader` (`frontend/src/components/layout/PageHeader.tsx`) renders the `?`
  icon as `<a href={helpUrl} target="_blank">` with a hover/focus tooltip
  (`layout.pageHeader.helpAriaLabel`, `layout.pageHeader.helpTooltip`). About 30
  pages pass `helpUrl={docsUrl(key)}`.
- The assistant's `AiChatBubble` (`frontend/src/components/ai/AiChatBubble.tsx`,
  mounted by `SwipeShell`) already implements a right-side sheet with closed,
  sheet and full views, Escape stepping down a level, collapse on navigation,
  and a phone layout. The panel copies that behaviour instead of inventing a
  second one.
- `ReleaseNotesMarkdown.tsx` and `AssistantMarkdown.tsx` show how Markdown is
  rendered in the app (`react-markdown` + `remark-gfm`, component overrides, no
  raw HTML).
- The website renderer (`frontend/scripts/website-docs/markdown.mjs`) defines
  what the guide's Markdown means: GitHub heading slugs, `<a id="x"></a>` as the
  only HTML (an anchor target), `> [!NOTE]`-style callouts, `name.md#anchor`
  links between pages, `images/<name>.png` pictures with their alt text as
  caption.

## Design

### Opening it

- `PageHeader` takes `help?: DocsLink` in place of `helpUrl`. The icon stays an
  `<a href={docsUrl(help)}>`, so middle-click, Ctrl-click and "copy link" still
  reach monize.net. A plain click calls `preventDefault()` and opens the panel at
  `helpTarget(help)`. The tooltip copy changes from "opens the documentation" to
  "Help for this page".
- Every `helpUrl={docsUrl(x)}` call site becomes `help="x"` in the same commit
  (mechanical; about 30 pages). `helpUrl` is removed rather than kept as a
  second way.
- `HelpSection` in Settings opens the panel at the landing page. Its
  "Documentation" row keeps a secondary "Open on monize.net" link.
- When the manifest says `available: false`, or the page request fails, the
  click falls through to the website link. The help icon never becomes a dead
  button.

### The panel

- `frontend/src/components/help/HelpPanel.tsx`, mounted once beside
  `AiChatBubble` in `SwipeShell`. State lives in a small Zustand store
  (`frontend/src/store/helpStore.ts`): `open`, the current `{ page, section }`,
  a back/forward history, and `pinned`. Nothing is persisted to localStorage in
  this plan. If "remember pinned" is wanted later, it goes through
  `persisted-storage.guard.test.ts` with its reason.
- Layout: a right-side sheet on desktop (about 420 px, resizable to full like the
  assistant), a bottom sheet on phones. Header: page title, back, forward, "Open
  on monize.net" (`onlineUrl` plus the section), pin, close. Below it: a
  collapsible table of contents from the page's `toc`, then the content.
- Opening at a section scrolls that heading into view inside the panel's own
  scroller. It moves the panel's `scrollTop`, never `scrollIntoView`, which
  scrolls every ancestor (the website's `rewind()` lesson). Focus moves to the
  heading.
- Unpinned, the panel closes on route change, as the assistant sheet does.
  Pinned, it stays open and follows nothing: the reader chose what to read.
- **The panel and the assistant sheet share the right edge.** Opening one
  collapses the other to closed. Decide in review whether the help panel should
  instead dock left on wide screens.
- Escape closes it (or returns from full to sheet). It is a non-modal
  complementary region (`role="complementary"`, labelled) while docked, and a
  `Modal`-like dialog with a focus trap on phones.
- Non-English locales see one translated line at the top: "This guide is in
  English."

### Rendering the guide

`frontend/src/components/help/HelpMarkdown.tsx`, the third Markdown renderer,
mirrors the website's rules with app components:

- h2/h3 ids come from the page's `toc`, in order, so the app and the website
  cannot disagree about an anchor. An `<a id="x"></a>` line becomes an anchor
  target (a remark step like the website's).
- A `name.md#anchor` link navigates inside the panel and pushes history. An
  absolute link opens in a new tab with `rel="noopener noreferrer"`.
- An image renders as its caption plus "View screenshot on monize.net", linking
  to the section online. No `<img>` is emitted, so the CSP is untouched.
- Callouts render through the existing callout or `Badge` styling. Tables reuse
  the `Table.tsx` constants. Code uses the app's inline code style.
- Raw HTML other than the anchor is dropped. The website build already refuses
  it, so nothing is lost.

### Copy

New `help` namespace (registered in `frontend/src/i18n/messages.ts`): panel
labels, the English-only note, "View screenshot on monize.net", the unavailable
and error states. English first, `npm run i18n:pseudo`, every locale as the last
commit.

## Tests

- `HelpMarkdown`: for every page in `website/docs`, the ids it renders equal the
  ids in the generated `website/docs/<page>.html`, read from disk. This is the
  parity guard between the two renderers. Internal links navigate; external links
  open a new tab; images give a caption and a link with no `<img>`.
- `PageHeader`: a plain click opens the panel at the key's target; a modified
  click is left to the browser; `help` absent renders no icon.
- `HelpPanel`: history back/forward, pin survives navigation, unpinned closes on
  route change, Escape, assistant sheet collapse, unavailable fallback, error
  state (never an empty page), English-only note under a non-English locale.
- A source scan that fails on any `helpUrl=` prop or a docs URL literal in
  `frontend/src/app`.
- E2E (`e2e/`): open Budgets, click `?`, the panel shows the Budgets page, no new
  tab opens, and an internal link navigates inside the panel. Grep `e2e/` for the
  old help link's accessible name first.

## Docs

- `website/docs/getting-started.md` (or the landing page) describes the help
  panel. Retake the screenshot of any pictured page header whose icon changed.
- `docs/frontend/ui-conventions.md`: one entry ("help for a screen is
  `PageHeader` `help`, which opens the panel"), and the row in
  `frontend/CLAUDE.md`'s table updated to name `help` instead of `helpUrl`.

## What to run

`frontend/`: lint, type-check, i18n:check, `npm run test:changed`, build. Check
the bundle report: the help code and its renderer should load only when the
panel opens (dynamic import). `e2e/`: the new spec on its own.

## Observable when done

On the Budgets page, clicking `?` opens the Budgets guide beside the budget, at
the right section, with the budget still on screen. Ctrl-click still opens
monize.net in a new tab.
