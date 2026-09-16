// postbuild: writes dist/latest.json, the manifest the download page reads to
// discover the current version, size and URL. Upload it to R2 alongside the .dmg
// and the site picks up the new release with no code change.
const fs = require('fs');
const path = require('path');

const DOWNLOAD_BASE = 'https://downloads.sidtickle.com/downloads';

const pkg = require('../package.json');
const distDir = path.join(__dirname, '..', 'dist');
const filename = `${pkg.name}-${pkg.version}-arm64.dmg`;
const dmgPath = path.join(distDir, filename);

if (!fs.existsSync(dmgPath)) {
  console.error(`❌  Expected ${filename} in dist/ — did the build finish?`);
  process.exit(1);
}

const bytes = fs.statSync(dmgPath).size;
const manifest = {
  version: pkg.version,
  url: `${DOWNLOAD_BASE}/${filename}`,
  sizeMB: Math.round(bytes / 1024 / 1024),
  arch: 'arm64',
  releasedAt: new Date().toISOString(),
};

const out = path.join(distDir, 'latest.json');
fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`✓  Wrote dist/latest.json → v${manifest.version} (${manifest.sizeMB}MB)`);
