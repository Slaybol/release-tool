# Release Tool mockup

A clickable mockup of an internal release management tool: releases in flight, a release page with charts and a derived Hold / Wait / Ship recommendation, and a hardware testing view across device configurations and OS versions. All data is simulated demo data; the Jira and Kibana buttons are marked "Not connected" until those integrations exist.

Live: https://slaybol.github.io/release-tool/

- `index.html`: releases in flight (home)
- `release.html`: release page
- `hardware.html`: hardware testing coverage
- `integrations.html`: product, software and hardware integrations (compatibility matrix, ship order)
- `connections.html`: tool connections (example states)
- `dc-lite.js`: small renderer that makes the pages interactive
- `morphdom.min.js`: DOM diffing library (MIT, see `morphdom-LICENSE.txt`)

The `app/` folder holds the working service (phase 1): it picks up builds from `release/x.xx` branches, keeps one GitHub release per release in step with its candidate build, and serves a live home page. See [app/README.md](app/README.md). The demo `Build` and `Deploy` workflows in `.github/workflows/` feed it.

The mockup pages are static files, no build step. To preview locally: `python3 -m http.server`, then open http://localhost:8000.

Tool logos on the Connections page are SVG paths from [Simple Icons](https://simpleicons.org) (CC0). The logos are trademarks of their owners and are used only to identify each tool.
