# Release Tool service (phase 1)

Picks up builds automatically and keeps one GitHub release per release in step with its candidate build. The home page at `/` lists every release in flight and updates live.

## What it does

| GitHub event | What Release Tool does |
| --- | --- |
| A `release/x.xx` branch is created | Creates the release, status **Building** |
| The **Build** workflow succeeds on that branch | Records the build as the new candidate (`4.12.0-rc.N`), opens a **draft** GitHub release `v4.12.0-rc.N` with generated notes, and closes the previous one |
| The candidate is deployed to a test environment (`qa`, `staging`) | Turns the draft into a **pre-release**, status **Testing** |
| A release owner ships | Publishes it as **latest** with the final tag `v4.12.0`, status **Shipped** |

Closing a GitHub release when its build is replaced: GitHub has no closed state, so a draft is deleted and a pre-release is retitled "Superseded" with a link to its replacement, keeping its tag.

Release notes come from GitHub's generate-notes API, comparing the last published release with the new candidate, under a short header about the build. Grouping by Jira and edit locking come in phase 2.

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

### Shipping

Phase 1 has no sign-in yet, so shipping is an API call naming a GitHub login from `RELEASE_OWNERS`:

```sh
curl -X POST localhost:3000/api/releases/4.12/ship -H 'content-type: application/json' -d '{"actor":"Slaybol"}'
```

The Ship button and readiness gates arrive in phase 5.

## Demo workflows

`.github/workflows/build.yml` runs on every push to `release/**` (tests this service, packages the site). `deploy.yml` runs after a successful Build and records deployments of that commit to `qa`, then `staging`. GitHub only runs `workflow_run` workflows from the default branch, so `deploy.yml` starts working once this is merged to `main`.

To demo: `git switch -c release/4.12 && git push -u origin release/4.12`, then push again to the branch to see the GitHub release replaced.

## Code

- `src/flow.ts`: the automated flow (build pickup, GitHub release lifecycle, ship).
- `src/state.ts`, `src/model.ts`: records rebuilt from an append-only event log on start.
- `src/store.ts`: JSON Lines files under `DATA_DIR` (raw webhooks and domain events). The platform plan replaces this with Postgres.
- `src/reconcile.ts`: on start and every 6 hours, catches release branches and builds the webhooks missed.
- `src/server.ts`: webhook endpoint with signature check, `/api/releases`, live updates on `/api/stream`, the home page.
- `web/index.html`: the live home page, built on the mockup's renderer.

`npm test` runs the flow against a fake GitHub; `npm run typecheck` checks types.
