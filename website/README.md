# monize-site

The marketing / "what is Monize" site and the user documentation at `/docs`. No framework, no
build step on Cloudflare, no dependencies. The marketing page is three files: `index.html`,
`assets/css/styles.css`, `assets/js/app.js`. The documentation is described in
[Documentation](#documentation-docs) below.

* Live app demo: https://demo.monize.net
* Source: https://github.com/kenlasko/monize

## Run it locally

Open `index.html` in a browser, or serve the folder so relative paths and `_headers` behave:

```bash
npx serve .          # or: python -m http.server 8080
```

## Deploy to Cloudflare Pages (free plan)

The site is a Pages project. There is no `wrangler.jsonc` and no Workers build:
a Workers config in this folder makes Cloudflare's Workers Builds pick the site
up and deploy it a second way, alongside Pages. Deploy it through one of the
three options below and leave the folder without one.

### Option A - drag and drop (fastest, ~60 seconds)

1. Cloudflare dashboard -> **Workers & Pages** -> **Create** -> **Pages** -> **Upload assets**.
2. Name the project `monize-site`.
3. Drag this whole folder onto the upload area (not a zip of the folder - the folder itself).
4. **Deploy site**. You get `https://monize-site.pages.dev`.
5. **Custom domains** -> add `monize.net` / `www.monize.net`. If the DNS is already on Cloudflare it wires itself up.

### Option B - Wrangler CLI

```bash
npm i -g wrangler
wrangler login
wrangler pages deploy . --project-name=monize-site
```

### Option C - Git (auto-deploy on push)

Push this folder to a repo, then Pages -> **Connect to Git** -> pick it, and use:

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | *(leave empty)* |
| Build output directory | `/` |

There is nothing to compile, so builds finish instantly and stay inside the free tier.

## Files

```
index.html                     the whole page
404.html                       friendly not-found page
_headers                       security headers + revalidate-always caching
_redirects                     /demo /github /wiki /issues short links
robots.txt, sitemap.xml        change the domain if it is not monize.net
assets/css/styles.css          all styling, light + dark themes
assets/js/app.js               all interactivity and page data
assets/css/docs.css            documentation layout, on top of styles.css
assets/js/docs.js              documentation search, page list, on-this-page, copy, zoom
assets/js/theme-boot.js        documentation theme before first paint (blocking, in <head>)
docs/*.md                      documentation source, one file per page
docs/nav.json                  documentation page order and groups
docs/images/                   documentation screenshots
docs/*.html, search-index.json, sitemap.xml   GENERATED from docs/*.md -- never edit by hand
assets/img/monize-logo.svg     favicon + header mark
assets/img/screenshots/        optional local copies of the wiki screenshots
scripts/fetch-screenshots.sh   downloads them (macOS/Linux)
scripts/fetch-screenshots.ps1  downloads them (Windows)
```

## Screenshots

Every screenshot is loaded from `assets/img/screenshots/<name>.png` **first**, and falls back to
`https://raw.githubusercontent.com/wiki/kenlasko/monize/images/<name>.png` if that file is not there.
So the site looks complete out of the box, and gets faster the moment you run the fetch script.

If an image exists in neither place, a tidy "Screenshot pending - <name>.png" placeholder appears
instead of a broken image. Dropping the PNG into `assets/img/screenshots/` fixes it with no code change.

## Editing

All copy and data live in plain arrays near the top of `assets/js/app.js`:
`FEATURES`, `TOUR`, `REPORTS`, `QA`, `CODE`, `STACK`, `SECURITY`, `FORMATS`, `FAQ`, `GALLERY`, `MARQUEE`, `BUDGET`.
Add a feature card or a gallery image by adding one line - no rebuild, just refresh.

The content arrays hold **text, never markup.** Nothing in `app.js` assigns a
string to `innerHTML`: nodes are built with `el(tag, className, ...children)`
and placed with `fill(node, ...)` / `clear(node)`, so no entry in those arrays
can be parsed as HTML. Three conventions follow from that, and each replaced
markup that used to live in the data:

- Emphasis in `QA` answers is written as `*asterisks*`; `rich()` turns those
  runs into `<b>`.
- `CODE` samples are `[className, text]` token pairs (`''` plain, `'c'` comment,
  `'k'` key, `'s'` string) rather than pre-highlighted HTML. Write the text
  literally - `&&` and `<`, not `&amp;&amp;` and `&lt;` - because nothing
  unescapes entities on the way in.
- Randomness uses `rnd()`, which is `crypto.getRandomValues`, not `Math.random`.

**A name that becomes a URL is looked up, never trusted.** A screenshot name
is parked in `data-shot` between a paint and the click that opens the lightbox,
so it arrives back as DOM text -- and five `img.src = BASE + name + '.png'`
lines meant any attribute on the page was a request to a URL the site never
chose (CodeQL: "DOM text reinterpreted as HTML"). Every name now goes through
`shotName()` / `shotUrl()` / `full()`, which resolve it against a vocabulary
built from `TOUR` and `GALLERY` and return the literal from that content model
rather than the string that was read; the logo's `data-fallback` is likewise a
key into `REPO_FILES`, not a path. Anything outside the vocabulary resolves to
`null` and shows the "Screenshot pending" placeholder instead of loading.

So **a new screenshot has to be in `TOUR` or `GALLERY` before an `<img
data-shot>` anywhere can load it** -- including the ones written directly into
`index.html`. Concatenating a name into a `src` is what the resolvers exist to
replace, and `website-dom-safety.test.ts` fails on a `.src` assignment
containing a `+`.

Tag names live in the `TAGS` map, which constructs each one from a literal
`document.createElement('div')`. Adding an element the page has not used before
means adding a line there first - `el()` throws on an unknown tag rather than
quietly producing an `HTMLUnknownElement`. A parameterised
`document.createElement(t)` reads as a dynamic HTML sink to any scanner, which
cannot see that every call site passes a hardcoded tag.

This is enforced, not just documented: `frontend/src/test/website-dom-safety.test.ts`
scans every file in `assets/js/` and fails on an `innerHTML`/`outerHTML`
assignment, `insertAdjacentHTML`, `document.write`, `Math.random`, or a
`document.createElement` whose tag is not a literal. The site
has no build step, no framework escaping and no CSP behind it, so the DOM-builder
shape is the whole defence - and Bearer fails the pipeline on the alternative.

Brand colour is `--brand` in `styles.css` (teal `#4fa091`, taken from the app logo).

## Layout on a phone

A long list does not collapse to one column below the phone breakpoint -- it
becomes a horizontal strip. The features section is twenty-eight cards and the
gallery is forty-two screenshots; stacked, either is a couple of screens of
thumb-scrolling to reach the next section. `.strip` in the `max-width:640px`
block is the shape: `display:grid` (which is also what turns the gallery's
masonry off), cleared `grid-template-columns`, `grid-auto-flow:column` with a
`grid-auto-columns` under 100% so the next item peeks, `overflow-x:auto`, and
`scroll-snap-type:x`.

The rule names its consumers -- `.grid.strip,.gal.strip` -- rather than being a
bare `.strip`, because the collapse rules in the same block set
`grid-template-columns` and `columns` at the same specificity and a single class
would win on source order alone. **Putting a third list in a strip means adding
it to that selector as well as to the markup**; the class on its own is styled by
nothing.

Where the pictures are the content, as in the gallery, give them a width *and* a
height so they crop to a common size. `object-fit` crops the picture to the
element's box, but a height alone leaves the box at whatever the aspect ratio
makes it, so a portrait screenshot sits in a narrow box with the card blank
beside it.

Three rules come with all this, and each is scanned by
`frontend/src/test/website-mobile-layout.test.ts`:

- **Markup, rule and selector have to agree.** The scan fails if a listed strip
  is missing the class, if the rule is missing any of the declarations that make
  it a strip, or if no selector on that rule actually reaches the element.

- **Every sideways scroller sets `overscroll-behavior-x:contain`.** A swipe that
  reaches the end of a strip otherwise chains outward until the browser takes it
  as a back-navigation gesture, off the site.
- **A strip whose contents are replaced rewinds its own `scrollLeft`.** A scroll
  offset survives a repaint, clamped to the new content, so filtering the features
  down to two cards left the strip parked at the end of the two. Move the
  container's own `scrollLeft` -- never `scrollIntoView`, which scrolls every
  scrollable ancestor up to the document.

Both of those live in `asStrip()` / `rewind()` in `app.js`: register the list
once with the name a screen reader should announce, and call `rewind()` at the
end of its paint function. Nothing inside a feature card or a gallery figure is
focusable, so the strip takes a `tabindex` and that name while it can scroll --
asked of the element (`scrollWidth > clientWidth`) rather than by repeating the
breakpoint in JavaScript, so the two files cannot disagree after a breakpoint
moves.

## Documentation (`/docs`)

The user guide lives in `docs/` as Markdown, one file per page, and is served at
`https://monize.net/docs/<page>` (`docs/accounts.md` is `/docs/accounts`, `docs/index.md` is
`/docs/`). It replaced the GitHub wiki so that a change to a feature and the change to its
documentation land in the same pull request.

Cloudflare Pages has no build step here, so the pages are generated locally and committed:

```bash
cd frontend
npm run docs:build     # regenerate docs/*.html, docs/search-index.json, docs/sitemap.xml
npm run docs:check     # what CI runs (via frontend/src/test/website-docs.test.ts)
```

The generator is `frontend/scripts/build-website-docs.mjs`. It renders with the frontend's own
`react-markdown` + `remark-gfm`, so it needs `npm ci` in `frontend/` and nothing else.

### Changing the documentation

- **Edit the `.md` file, then run `npm run docs:build`** and commit both. A generated page that
  does not match its Markdown fails `website-docs.test.ts`.
- **A new page** is a new `docs/<slug>.md` (lower-case, hyphenated) starting with one `# Title`,
  plus an entry in `docs/nav.json` with a one-sentence `summary` (used on the landing page and as
  the page's description). A page missing from `nav.json`, or listed there without a file, fails
  the build.
- **Links between pages** are written `[text](accounts.md#financial-institutions)` so they also
  work when the Markdown is read on GitHub; the build turns them into `/docs/accounts#...`. A link
  to a page or heading that does not exist fails the build.
- **Heading anchors** use GitHub's slug rules, and the app's help links land on them: every one
  is an entry in `frontend/src/lib/docs-links.ts`, and `docs-links.test.ts` fails when a page or
  heading it names no longer exists. Renaming a heading means updating that entry. Where a
  heading's slug is taken, put `<a id="name"></a>` on the line above it; that is the only HTML the
  pages render.
- **The table of contents is generated** from the `##` and `###` headings; do not write one by hand.
- **Callouts** are GitHub's syntax: a blockquote starting `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]` or `[!CAUTION]`.
- **Screenshots** go in `docs/images/` as `.png` and are referenced as `images/<name>.png`. A
  picture alone in its paragraph becomes a figure with its alt text as the caption. A screenshot
  that is referenced but not there renders as "Screenshot pending" and the build lists it.

### Screenshots

Every documentation screenshot is taken by Playwright, never by hand, so a changed screen is one
command away from a current picture. Each picture is a test in `e2e/docs-screenshots/` whose title
is the PNG's file name; it seeds nothing of its own beyond what `e2e/readme/01-seed.spec.ts` adds to
the built-in demo data, opens the screen, waits for it to settle and writes
`docs/images/<name>.png`.

**When to add or retake one:** a page section that walks through a screen, a dialog or a widget
shows it; a change that alters how that screen looks retakes its picture in the same PR. A
setting that is one switch, or text that the page already says, needs no picture.

**Adding one:** reference `images/<name>.png` in the Markdown, add a test titled `<name>` to
`e2e/docs-screenshots/`, run it, and commit the PNG with the page. Crop to the part the section is
about with `shoot(page, name, { dir: DOCS_IMAGE_DIR, element })`; whole-screen pictures are the
1600x1000 desktop viewport, dark theme.

**Running them** needs a Monize instance holding the demo data, with rate limits raised, demo
mode off (it renames the sign-in button and adds a banner) and no plain-HTTP warning. The e2e
stack does all of that, built from the working tree so the pictures show the branch:

```bash
# repository root
printf 'services:\n  backend:\n    environment:\n      DEMO_MODE: "false"\n  frontend:\n    environment:\n      DISABLE_HTTPS_HEADERS: "true"\n' > /tmp/monize-docs.yml
docker compose -p monize-docs -f docker-compose.e2e.yml -f /tmp/monize-docs.yml up -d --build --wait
# the e2e stack skips the demo seed the production entrypoint runs; run it once
docker compose -p monize-docs -f docker-compose.e2e.yml exec -e DEMO_MODE=true backend node dist/database/seed.js

cd e2e && npm ci
BASE_URL=http://localhost:3001 npm run docs:screenshots                           # showcase seed, then every picture
BASE_URL=http://localhost:3001 npm run docs:screenshots -- -g budget-dashboard   # one picture, by file name
docker compose -p monize-docs -f ../docker-compose.e2e.yml down -v
```

A picture of a state the demo data does not reach (an AI insight, an admin dialog, an emergency
access claim) needs that state seeded through the API in the test first; until then the page
shows "Screenshot pending" and `npm run docs:build` lists it.

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` where `npx playwright install chromium` is not an option.
`e2e/readme/README.md` explains the session, the seed and the settling waits the captures share.

### Cloudflare Pages free plan

`website-docs.test.ts` also holds the whole folder to the free plan's per-deployment limits:
20,000 files, 25 MiB per file, 100 `_headers` rules, 2,000 static and 100 dynamic `_redirects`.
The documentation adds about 160 files.

## Licence

Same spirit as the app: AGPL-3.0. Screenshots and the Monize name belong to the Monize project.
