export interface Dependency { name: string; repo: string; tag: string } // must be published on GitHub before this ships

export interface Config {
  port: number;
  webhookSecret: string;
  owner: string;
  repo: string;
  productName: string; // "Web app" → releases are named "Web app 4.12"
  buildWorkflow: string; // name of the GitHub Actions workflow whose successful run is a build
  testEnvironments: string[]; // a candidate in any of these is "in test" and its GitHub release becomes a pre-release
  soakEnvironment: string; // where the soak time is measured
  releaseOwners: string[]; // GitHub logins allowed to ship
  adminToken?: string; // required to ship or edit notes from the page; unset = API ship only, no token
  dataDir: string;
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: number;
  // Integrations. Each runs on simulated demo data until its settings are filled in.
  jira: { baseUrl?: string; email?: string; apiToken?: string; project: string; fixVersion: string };
  zephyr: { apiToken?: string; baseUrl: string; project: string };
  elastic: { url?: string; apiKey?: string; service: string; rumIndex: string; errorIndex: string };
  matrixFile?: string;
  pollSeconds: number;
  demoMinutes: number; // how long a simulated test pass takes, start to finish
  gates: { testTargetPct: number; errorThreshold: number; soakHours: number; dependencies: Dependency[] };
}

const list = (v: string | undefined, d: string) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);
const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number(v));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repoFull = env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error('Set GITHUB_REPOSITORY to owner/name, for example Slaybol/release-tool.');
  if (!env.WEBHOOK_SECRET) throw new Error('Set WEBHOOK_SECRET to the secret configured on the GitHub webhook.');
  const jiraProject = env.JIRA_PROJECT ?? 'WEB';
  return {
    port: num(env.PORT, 3000),
    webhookSecret: env.WEBHOOK_SECRET,
    owner,
    repo,
    productName: env.PRODUCT_NAME ?? 'Web app',
    buildWorkflow: env.BUILD_WORKFLOW ?? 'Build',
    testEnvironments: list(env.TEST_ENVIRONMENTS, 'qa,staging').map((s) => s.toLowerCase()),
    soakEnvironment: (env.SOAK_ENVIRONMENT ?? 'staging').toLowerCase(),
    releaseOwners: list(env.RELEASE_OWNERS, owner).map((s) => s.toLowerCase()),
    adminToken: env.ADMIN_TOKEN || undefined,
    dataDir: env.DATA_DIR ?? 'data',
    token: env.GITHUB_TOKEN || undefined,
    appId: env.GITHUB_APP_ID || undefined,
    privateKey: env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n') || undefined,
    installationId: env.GITHUB_INSTALLATION_ID ? Number(env.GITHUB_INSTALLATION_ID) : undefined,
    jira: { baseUrl: env.JIRA_BASE_URL || undefined, email: env.JIRA_EMAIL || undefined, apiToken: env.JIRA_API_TOKEN || undefined, project: jiraProject, fixVersion: env.JIRA_FIX_VERSION ?? '{line}' },
    zephyr: { apiToken: env.ZEPHYR_API_TOKEN || undefined, baseUrl: env.ZEPHYR_BASE_URL ?? 'https://api.zephyrscale.smartbear.com/v2', project: env.ZEPHYR_PROJECT ?? jiraProject },
    elastic: { url: env.ELASTIC_URL || undefined, apiKey: env.ELASTIC_API_KEY || undefined, service: env.ELASTIC_SERVICE ?? 'web-app', rumIndex: env.ELASTIC_RUM_INDEX ?? 'traces-apm.rum*', errorIndex: env.ELASTIC_ERROR_INDEX ?? 'logs-apm.error*' },
    matrixFile: env.MATRIX_FILE || undefined,
    pollSeconds: num(env.POLL_SECONDS, 60),
    demoMinutes: num(env.DEMO_MINUTES, 20),
    gates: {
      testTargetPct: num(env.TEST_TARGET_PCT, 90),
      errorThreshold: num(env.ERROR_THRESHOLD, 8),
      soakHours: num(env.SOAK_HOURS, 24),
      dependencies: env.DEPENDENCIES ? JSON.parse(env.DEPENDENCIES) : []
    }
  };
}
