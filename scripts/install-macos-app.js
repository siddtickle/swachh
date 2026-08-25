// Installs the freshly built app into /Applications, replacing the previous
// Swachh.app only after a complete copy has been staged beside it.
const fs = require('fs');
const path = require('path');

if (process.platform !== 'darwin') {
  console.error('update-app is available on macOS only.');
  process.exit(1);
}

const projectDir = path.join(__dirname, '..');
const source = path.join(projectDir, 'dist', 'mac-arm64', 'swachh.app');
const destination = '/Applications/Swachh.app';
const staging = `/Applications/.Swachh.app-update-${process.pid}`;

if (!fs.existsSync(source)) {
  console.error(`Built app not found at ${source}`);
  process.exit(1);
}

try {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.cpSync(source, staging, { recursive: true, dereference: true });
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(staging, destination);
  console.log(`✓ Updated ${destination}`);
} catch (error) {
  fs.rmSync(staging, { recursive: true, force: true });
  console.error(`Could not update ${destination}: ${error.message}`);
  console.error('Quit Swachh and make sure you have permission to write to /Applications, then try again.');
  process.exit(1);
}
