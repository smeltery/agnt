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
- `scene.css`: illustrative desktop and phone UI.
- `site.js`: provider previews, example conversations, and copy commands.
- `assets/og.png`: 1200 × 630 social preview, also embedded in the root README.
- `brand/og.html`: editable HTML source for the social preview.

The provider and conversation controls change an illustrative demo only.
The setup and documentation links point to the repository's real guides.
Provider logo attribution is in `assets/brands/NOTICE`.

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
