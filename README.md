# Release Tool

An internal release management tool: every release in flight on one page, a readiness check per release, release notes written for you, and test coverage across the hardware and OS matrix.

**Demo:** https://slaybol.github.io/release-tool/demo/ runs the whole flow in the browser on simulated GitHub, Jira, Zephyr and Elastic data. No server, no sign-in. 4.11 has shipped, 4.12 is ready to ship and 4.13 is blocked; over about 15 minutes a fixed 4.13 build arrives and reaches Ready. "Restart demo" plays it again.

## The release flow

| Step | What happens | GitHub release |
| --- | --- | --- |
| Cut a `release/x.xx` branch (for example `release/4.13`) | Release Tool creates release 4.13 | None yet |
| GitHub Actions **Build** succeeds on the branch | The build becomes candidate `4.13.0-rc.N` (N = build number on the line) | **Draft** `v4.13.0-rc.N` with generated notes |
| A newer build replaces the candidate | The old candidate is closed and a new one opened | Old one deleted (draft) or retitled "Superseded" (pre-release); new draft `v4.13.0-rc.N+1` |
| The candidate is deployed to `qa` or `staging` | Testing starts: Zephyr results against the imported test matrix, Actions JUnit results, Jira bugs on fix version 4.13, errors and sessions from Elastic | **Pre-release** |
| Every readiness check passes | Status **Ready**; the Ship button is enabled | Pre-release |
| A release owner presses **Ship** | Status **Shipped** | **Release** `v4.13.0`, marked latest, on the same commit as the candidate |

Versions follow [semantic versioning](https://semver.org): release candidates are `X.Y.0-rc.N` and the shipped version is `X.Y.0`. Tags are the version with a `v` prefix. The test matrix is imported once from the hardware/software workbook and reused for every build.

## What's in the repo

- `demo/`: the static demo site above, built from `app/` with `cd app && npm run build:demo`.
- `app/`: the Release Tool service (Node, TypeScript). It listens to GitHub webhooks and runs the flow for real. See [app/README.md](app/README.md).
- `.github/workflows/`: demo `Build` and `Deploy` workflows that feed the service from `release/**` branches.
- Top-level `*.html`: the original design mockup (busier, multi-product), kept for reference.

Everything served by GitHub Pages is static files with no build step. To preview locally: `python3 -m http.server`, then open http://localhost:8000/demo/.

Tool logos on the Connections page are SVG paths from [Simple Icons](https://simpleicons.org) (CC0). The logos are trademarks of their owners and are used only to identify each tool.
