// prebuild: stages a self-contained ffmpeg + ffprobe into vendor/ so
// electron-builder can bundle them as extraResources inside the .app.
//
// Homebrew's ffmpeg is dynamically linked against ~25 dylibs in /opt/homebrew.
// Copying the bare executables produced an .app that only ran on machines that
// already had Homebrew ffmpeg installed. dylibbundler copies those dependencies
// next to the binaries and rewrites their load paths to @executable_path/libs,
// so the bundle stands on its own.
const cp   = require('child_process');
const fs   = require('fs');
const path = require('path');

const vendorDir = path.join(__dirname, '..', 'vendor');
const libsDir   = path.join(vendorDir, 'libs');

function need(bin, hint) {
  try {
    return cp.execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
  } catch {
    console.error(`❌  Could not find ${bin}. Run: ${hint}`);
    process.exit(1);
  }
}

need('dylibbundler', 'brew install dylibbundler');

fs.rmSync(libsDir, { recursive: true, force: true });
fs.mkdirSync(libsDir, { recursive: true });

for (const name of ['ffmpeg', 'ffprobe']) {
  let src;
  try {
    src = cp.execSync(`which ${name}`, { encoding: 'utf8' }).trim();
  } catch {
    src = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]
      .find(p => fs.existsSync(p));
  }

  if (!src || !fs.existsSync(src)) {
    console.error(`❌  Could not find ${name}. Run: brew install ffmpeg`);
    process.exit(1);
  }

  const dest = path.join(vendorDir, name);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);

  // -of/-of so the second pass reuses the libs the first one already collected.
  cp.execFileSync('dylibbundler', [
    '--fix-file', dest,
    '--dest-dir', libsDir,
    '--install-path', '@executable_path/libs/',
    '--bundle-deps',
    '--overwrite-files',
  ], { stdio: ['ignore', 'ignore', 'inherit'] });

  console.log(`✓  Staged ${src} → vendor/${name}`);
}

// install_name_tool edits invalidate each dylib's signature, and arm64 refuses
// to load unsigned code — so re-sign everything that was rewritten.
const signTargets = [
  ...fs.readdirSync(libsDir).map(f => path.join(libsDir, f)),
  path.join(vendorDir, 'ffmpeg'),
  path.join(vendorDir, 'ffprobe'),
];
for (const target of signTargets) {
  cp.execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
}

console.log(`✓  Bundled ${fs.readdirSync(libsDir).length} dylibs into vendor/libs and re-signed`);
