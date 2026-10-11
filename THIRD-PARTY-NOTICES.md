# Third-Party Notices

This project uses third-party components. Their licenses and trademark rights
remain with the respective owners. This file lists them; see `LICENSE` for the
license of this project's own sources (GNU GPL-3.0).

## Runtime dependencies (npm)

| Package | License | Upstream |
|---|---|---|
| `express` | MIT | https://github.com/expressjs/express |
| `ws` | MIT | https://github.com/websockets/ws |
| `uuid` | MIT | https://github.com/uuidjs/uuid |
| `selfsigned` | MIT | https://github.com/jfromaniello/selfsigned |

Full license texts are shipped in `node_modules/<package>/LICENSE` of an
installed copy.

## Frontend dependencies (npm, build time / bundled)

| Package | License | Upstream |
|---|---|---|
| `react`, `react-dom` | MIT | https://github.com/facebook/react |
| `vite`, `@vitejs/plugin-react` | MIT | https://github.com/vitejs/vite (build only) |

## Fonts and icons

**Material Symbols Rounded** (weight 300) - `webui-src/public/fonts/`,
plus the icon paths used inline in `webui-src/src/AddHomeIcon.jsx`.

Copyright Google LLC, licensed under the Apache License, Version 2.0.
You may obtain a copy at https://www.apache.org/licenses/LICENSE-2.0

The font binary redistributed here is a subset produced with `fonttools`
(MIT, Copyright David Turner, Robert Wilhelm, Werner Lemberg) containing only
the ligature glyphs used by this WebUI. The subset retains the font's original
copyright and license name records.

## Trademarks

The names and logos below are trademarks or registered trademarks of their
respective owners. They are used in this project purely to identify the
systems that this bridge connects. **This project is not sponsored, endorsed,
or affiliated with the owners of these marks.**

| Mark | Owner | Where used here |
|---|---|---|
| Bosch, Bosch Smart Home | Robert Bosch GmbH / Bosch Smart Home GmbH | Project name, WebUI header logo, documentation |
| Homematic, Homematic IP, HCU | eQ-3 Entwicklung GmbH | Documentation, WebUI header emblem |

The Bosch wordmark/emblem (`webui-src/src/BoschLogo.jsx`) and the Homematic IP
emblem (`webui-src/src/HmipLogo.jsx`) are reproduced for identification and
compatibility communication only. If you are the rights holder and would like a
change, please open an issue - it will be acted on promptly.

## API documentation referenced during development

Homematic IP **Connect API** documentation: (c) eQ-3 Entwicklung GmbH.
**Bosch Smart Home Local API** documentation: (c) Robert Bosch Smart Home GmbH,
published under Creative Commons BY-NC-ND.

Both are external reference material. **Neither documentation nor any excerpt of
it is included in this repository or in the plugin image.**

## Documentation platform

The `PLAN-hcu-bosch-plugin.md` in `docs/` was produced during development and is
covered by this project's GPL-3.0 license.
