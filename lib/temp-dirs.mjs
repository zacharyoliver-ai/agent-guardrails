import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];

process.on('exit', () => {
  for (const dir of made) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // A folder still held open on Windows must not fail the test run.
    }
  }
});

/** Makes a temp folder for a test, and removes it when the process exits. */
export function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
