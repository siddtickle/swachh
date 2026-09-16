// electron-builder afterPack hook.
//
// Without this, the .app ships with only the linker's stub ad-hoc signature and
// no sealed resources. Gatekeeper reads that as a tampered bundle and tells the
// user the app is "damaged" — with no "Open Anyway" override in Settings. A real
// ad-hoc signature seals the resources, which downgrades that to the ordinary
// "unidentified developer" prompt the user can actually bypass.
const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
  execFileSync('codesign', ['--verify', '--strict', appPath], {
    stdio: 'inherit',
  });
};
