# Release Tool service

Picks up builds automatically and keeps one GitHub release per release in step with its candidate build. The home page at `/` lists every release in flight and updates live; `/releases/4.12` shows one release in full: readiness gates, builds, time in each environment, the GitHub release, editable release notes, the test matrix, Jira bugs and real use.

## What it does

| GitHub event | What Release Tool does |
| --- | --- |
| A `release/x.xx` branch is created | Creates the release, status **Building** |
| The **Build** workflow succeeds on that branch | Records the build as the new candidate (`4.12.0-rc.N`), opens a **draft** GitHub release `v4.12.0-rc.N` with generated notes, and closes the previous one |
| The candidate is deployed to a test environment (`qa`, `staging`) | Turns the draft into a **pre-release**, status **Testing** |
| Any workflow on the branch uploads a `test-results*` artifact (JUnit XML) | Counts the automated results against that build |
| Jira, Zephyr or Elastic change (polled every `POLL_SECONDS`) | Updates bugs, matrix results and real use, refreshes the notes, recomputes readiness |
| A release owner presses **Ship** (only when every gate passes) | Publishes it as **latest** with the final tag `v4.12.0`, status **Shipped** |

Closing a GitHub release when its build is replaced: GitHub has no closed state, so a draft is deleted and a pre-release is retitled "Superseded" with a link to its replacement, keeping its tag.

### Release notes

The GitHub release body is written in marked sections: About this release, Highlights, What's changed (GitHub's generated notes from the last published release, with `WEB-` keys linked to Jira), Known issues (open bugs on the fix version) and Release facts. They are rebuilt for every build and Jira change. Highlights, What's changed and Known issues can be edited in the tool or straight on GitHub; an edited section is kept as written and carried to later builds. Send `"text": null` to hand it back to the tool.

### Readiness and status

| Gate | Passes when |
| --- | --- |
| Automated tests | No failures in Actions JUnit results for the candidate |
| Matrix tests | At least `TEST_TARGET_PCT` of planned matrix tests ran, none failed |
| Matrix coverage | Every Required cell of the matrix passed |
| Blocker bugs | No open Jira blocker on the fix version |
| Error rate | Errors per hour on the candidate at or under `ERROR_THRESHOLD` |
| Soak | `SOAK_HOURS` in `SOAK_ENVIRONMENT` |
| Dependencies | Each repo in `DEPENDENCIES` has published its tag |

Status is **Blocked** when a blocker bug or dependency fails, **At risk** when another gate fails, **Testing** while gates wait, and **Ready** when all pass.

### Test matrix

Imported once from the hardware/software workbook (sheets "Test Matrix" and "Configurations", R = Required, S = Smoke): `npm run import-matrix -- path/to/matrix.xlsx`, or `MATRIX_FILE` on start, or `curl -X POST localhost:3000/api/matrix -H 'x-filename: matrix.xlsx' --data-binary @matrix.xlsx`. Re-importing replaces the plan. Results come from Zephyr executions whose environment names the configuration.

### Demo data

Without Jira, Zephyr or Elastic settings, those sources run on simulated data that tells a story over `DEMO_MINUTES`: rc.1 picks up a blocker bug, failed tests and rising errors; the next build comes good. GitHub is always live. The page says which sources are simulated.

## Run it

Node 20 or newer.

```sh
cd app
npm install
cp .env.example .env   # fill it in
node --env-file=.env --import tsx src/server.ts
```

Then point GitHub's webhooks at `http://<host>:3000/webhooks/github`. For a laptop demo, forward them with [smee.io](https://smee.io): `npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/webhooks/github`.

### GitHub access

Use a GitHub App (preferred) or a fine-grained token on the demo repository.

- **Permissions:** Contents read and write (to create and edit releases), Actions read, Deployments read, Metadata read.
- **Webhook events:** Create, Workflow runs, Deployment statuses. Use the same secret as `WEBHOOK_SECRET`.

### Shipping and edits

The Ship button on a release page is enabled when every gate passes and asks which release owner (`RELEASE_OWNERS`) is shipping. There is no sign-in yet; set `ADMIN_TOKEN` to require a bearer token for shipping, note edits and matrix uploads. The same as API calls:

```sh
curl -X POST localhost:3000/api/releases/4.12/ship -H 'content-type: application/json' -d '{"actor":"Slaybol"}'
curl -X PUT localhost:3000/api/releases/4.12/notes/highlights -H 'content-type: application/json' -d '{"text":"## Highlights\n\nFaster checkout.","actor":"Slaybol"}'
```

## Demo workflows

`.github/workflows/build.yml` runs on every push to `release/**` (tests this service, uploads the JUnit `test-results` artifact, packages the site). `deploy.yml` runs after a successful Build and records deployments of that commit to `qa`, then `staging`. GitHub only runs `workflow_run` workflows from the default branch, so `deploy.yml` starts working once this is merged to `main`.

To demo: `git switch -c release/4.12 && git push -u origin release/4.12`, then push again to the branch to see the GitHub release replaced.

## Code

- `src/flow.ts`: the automated flow (build pickup, GitHub release lifecycle, ship).
- `src/state.ts`, `src/model.ts`: records rebuilt from an append-only event log on start.
- `src/store.ts`: JSON Lines files under `DATA_DIR` (raw webhooks and domain events). The platform plan replaces this with Postgres.
- `src/gates.ts`: readiness gates and status.
- `src/notes.ts`: release note sections, GitHub edit detection, Jira links.
- `src/matrix.ts`, `src/xlsx.ts`: matrix import and coverage. `src/junit.ts`: Actions test results.
- `src/integrations/`: Jira, Zephyr and Elastic sources, live and simulated. `src/poller.ts` polls them.
- `src/reconcile.ts`: on start and every 6 hours, catches release branches and builds the webhooks missed.
- `src/server.ts`: webhook endpoint with signature check, `/api/releases`, `/api/releases/:line`, ship, notes and matrix endpoints, live updates on `/api/stream`.
- `web/index.html`, `web/release.html`: the live home and release pages, built on the mockup's renderer.

`npm test` runs the flow against a fake GitHub; `npm run typecheck` checks types.
