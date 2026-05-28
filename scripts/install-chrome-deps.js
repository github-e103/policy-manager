// Installs Chromium shared library dependencies on Linux (Azure App Service).
// Runs as prestart on every app boot; no-op on Windows.
if (process.platform !== 'linux') process.exit(0);

const { spawnSync } = require('child_process');

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: 'inherit' });
  if (result.status !== 0) console.warn(`[chrome-deps] "${cmd} ${args.join(' ')}" exited ${result.status}`);
}

run('apt-get', ['update', '-qq']);
run('apt-get', [
  'install', '-y', '--no-install-recommends',
  'libglib2.0-0', 'libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0',
  'libcups2', 'libdrm2', 'libxkbcommon0', 'libxcomposite1',
  'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1',
  'libpango-1.0-0', 'libcairo2',
  'libx11-xcb1', 'libxcb1', 'libxcursor1', 'libxi6',
  'libxrender1', 'libxss1', 'libxtst6', 'fonts-liberation',
]);
run('ldconfig', []);
