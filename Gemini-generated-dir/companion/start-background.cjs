const { spawn } = require('node:child_process');
const path = require('node:path');

const electronPath = require('electron');
const child = spawn(electronPath, [path.join(__dirname, 'main.cjs')], {
  cwd: path.resolve(__dirname, '..'),
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
});

child.once('error', (error) => {
  console.error(`Could not start the LAN Browser Bridge: ${error.message}`);
  process.exitCode = 1;
});

child.unref();
