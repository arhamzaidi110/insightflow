import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const windowsPython = resolve(root, '.venv', 'Scripts', 'python.exe');
const unixPython = resolve(root, '.venv', 'bin', 'python');
const python = existsSync(windowsPython)
  ? windowsPython
  : existsSync(unixPython)
    ? unixPython
    : process.platform === 'win32'
      ? 'python'
      : 'python3';

const child = spawn(python, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`Could not start Python (${python}): ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Python exited after signal ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
