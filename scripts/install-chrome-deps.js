// Installs Chromium shared library dependencies on Linux (Azure App Service).
// Runs as prestart on every app boot; no-op on Windows.
if (process.platform !== 'linux') process.exit(0);

const { spawnSync } = require('child_process');

function apt(pkg) {
  const r = spawnSync('apt-get', ['install', '-y', '--no-install-recommends', pkg], { stdio: 'pipe' });
  if (r.status !== 0) console.warn(`[chrome-deps] skipped ${pkg} (not available)`);
}

spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });

const libs = [
  'libglib2.0-0', 'libglib2.0-0t64',   // Ubuntu 22.04 / 24.04
  'libasound2',   'libasound2t64',       // Ubuntu 22.04 / 24.04
  'libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0',
  'libcups2', 'libdrm2', 'libxkbcommon0', 'libxcomposite1',
  'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1',
  'libpango-1.0-0', 'libcairo2',
  'libx11-xcb1', 'libxcb1', 'libxcursor1', 'libxi6',
  'libxrender1', 'libxss1', 'libxtst6', 'fonts-liberation',
];

for (const lib of libs) apt(lib);

spawnSync('ldconfig', [], { stdio: 'inherit' });
