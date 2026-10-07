# agnt marketing site

A standalone static marketing page inspired by the visual language of
[loft](https://github.com/smeltery/loft) and convrt (a private repository).
It is separate from the browser
client in `agnt-web/` and does not connect to a relay or agent.

From the repository root:

```sh
python3 -m http.server 4174 --bind 127.0.0.1 --directory agnt-site
```

Open <http://localhost:4174>. No installation or build step is required.
All assets are local; the page uses system fonts and has no analytics.

- `index.html`: page content and social metadata.
- `styles.css`: layout, typography, sections, and responsive footer.
- `scene.css`: framing for real desktop and mobile browser captures.
- `site.js`: provider details and copy commands.
- `assets/og.png`: 1200 × 630 social preview, also embedded in the root README.
- `brand/og.html`: editable HTML source for the social preview.

Product images render the actual `agnt-web` components with example conversation
data. Both views show the browser client, not the native iOS or Android apps.
Provider buttons update feature descriptions; they do not alter the screenshots.
The setup and documentation links point to the repository's real guides.
Provider logo attribution is in `assets/brands/NOTICE`.

## Refresh product screenshots

Start the actual browser client from the repository root:

```sh
npm --prefix agnt-web run dev -- --host 127.0.0.1 --port 5173
```

With Playwright installed, run in a second terminal:

```sh
node agnt-site/brand/render-product.mjs /path/to/playwright/index.mjs
```

The renderer uses isolated browser contexts and seeds only example in-memory
state through the Vite development modules. It does not pair, contact a relay,
run an agent, or read saved conversations. It captures the shipped components
and styles without replacing their markup or CSS. Desktop is 1440 × 1000;
mobile browser is 430 × 932. Output goes to `assets/screenshots/`.

Inspect both captures and regenerate the social preview whenever the client UI
changes. Keep the platform and example-data labels alongside the images.

## Regenerate the social preview

With a working Chrome or Chromium executable installed:

```sh
node agnt-site/brand/render-og.mjs /path/to/chromium
```

The renderer opens `brand/og.html` in an isolated headless browser profile
and writes `assets/og.png`. Keep the image at 1200 × 630 and inspect it after
changing the copy or layout. It can also be rendered from a browser at that
viewport size.

This site is local-only for now. When a public origin is chosen, set an absolute
`og:image` and `twitter:image` URL and add canonical and `og:url` metadata for
that origin. No hosting or public domain is configured here.
