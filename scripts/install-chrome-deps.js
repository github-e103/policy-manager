// Installs Chromium shared library dependencies on Linux (Azure App Service).
// Called from server.js at startup. No-op on Windows or if already installed.
if (process.platform !== 'linux') return;

const { spawnSync, execSync } = require('child_process');

// Skip if the key library is already present (e.g. after a warm container restart)
try {
  execSync('ldconfig -p | grep libgobject-2.0', { stdio: 'pipe' });
  return; // already installed
} catch (_) {}

console.log('[chrome-deps] Installing Chromium system dependencies...');

spawnSync('apt-get', ['update', '-qq'], { stdio: 'inherit' });

const libs = [
  'libglib2.0-0', 'libglib2.0-0t64',
  'libasound2',   'libasound2t64',
  'libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0',
  'libcups2', 'libdrm2', 'libxkbcommon0', 'libxcomposite1',
  'libxdamage1', 'libxfixes3', 'libxrandr2', 'libgbm1',
  'libpango-1.0-0', 'libcairo2',
  'libx11-xcb1', 'libxcb1', 'libxcursor1', 'libxi6',
  'libxrender1', 'libxss1', 'libxtst6', 'fonts-liberation',
];

for (const lib of libs) {
  const r = spawnSync('apt-get', ['install', '-y', '--no-install-recommends', lib], { stdio: 'pipe' });
  if (r.status !== 0) console.warn(`[chrome-deps] skipped ${lib} (not available)`);
  else console.log(`[chrome-deps] installed ${lib}`);
}

spawnSync('ldconfig', [], { stdio: 'inherit' });
console.log('[chrome-deps] Done.');
