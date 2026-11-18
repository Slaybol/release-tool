export interface Config {
  port: number;
  webhookSecret: string;
  owner: string;
  repo: string;
  productName: string; // "Web app" → releases are named "Web app 4.12"
  buildWorkflow: string; // name of the GitHub Actions workflow whose successful run is a build
  testEnvironments: string[]; // a candidate in any of these is "in test" and its GitHub release becomes a pre-release
  releaseOwners: string[]; // GitHub logins allowed to ship
  dataDir: string;
  token?: string;
  appId?: string;
  privateKey?: string;
  installationId?: number;
}

const list = (v: string | undefined, d: string) => (v ?? d).split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repoFull = env.GITHUB_REPOSITORY ?? '';
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error('Set GITHUB_REPOSITORY to owner/name, for example Slaybol/release-tool.');
  if (!env.WEBHOOK_SECRET) throw new Error('Set WEBHOOK_SECRET to the secret configured on the GitHub webhook.');
  return {
    port: Number(env.PORT ?? 3000),
    webhookSecret: env.WEBHOOK_SECRET,
    owner,
    repo,
    productName: env.PRODUCT_NAME ?? 'Web app',
    buildWorkflow: env.BUILD_WORKFLOW ?? 'Build',
    testEnvironments: list(env.TEST_ENVIRONMENTS, 'qa,staging').map((s) => s.toLowerCase()),
    releaseOwners: list(env.RELEASE_OWNERS, owner).map((s) => s.toLowerCase()),
    dataDir: env.DATA_DIR ?? 'data',
    token: env.GITHUB_TOKEN,
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    installationId: env.GITHUB_INSTALLATION_ID ? Number(env.GITHUB_INSTALLATION_ID) : undefined
  };
}
