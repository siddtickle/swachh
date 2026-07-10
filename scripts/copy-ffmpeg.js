// prebuild: copies the system ffmpeg + ffprobe into vendor/ so electron-builder
// can bundle them as extraResources inside the .app
const cp   = require('child_process');
const fs   = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, '..', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

for (const name of ['ffmpeg', 'ffprobe']) {
  let src;
  try {
    src = cp.execSync(`which ${name}`, { encoding: 'utf8' }).trim();
  } catch {
    // which failed — try common Homebrew locations
    const candidates = [
      `/opt/homebrew/bin/${name}`,
      `/usr/local/bin/${name}`,
    ];
    src = candidates.find(p => fs.existsSync(p));
  }

  if (!src || !fs.existsSync(src)) {
    console.error(`❌  Could not find ${name}. Run: brew install ffmpeg`);
    process.exit(1);
  }

  const dest = path.join(vendorDir, name);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  console.log(`✓  Copied ${src} → vendor/${name}`);
}
