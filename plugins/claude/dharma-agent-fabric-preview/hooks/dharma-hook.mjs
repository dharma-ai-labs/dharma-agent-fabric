// Runs `dharma hook claude <action>` for the 1.0.7-preview hooks with no shell syntax in the hook command, so the
// same command works under sh, Git Bash, Windows PowerShell 5.1 and pwsh. The hook JSON on stdin goes to the CLI.
// A missing CLI, an older CLI without `hook claude`, or any failure prints nothing and exits 0. Only the inbox
// hook's output is forwarded, and only when the CLI exited 0; its stderr is never shown.
import { spawn } from 'node:child_process';

const action = process.argv[2];
const done = () => process.exit(0);

if (action !== 'session-start' && action !== 'inbox') done();
else {
  try {
    // shell on Windows so dharma.cmd resolves; the arguments are fixed strings.
    const child = spawn('dharma', ['hook', 'claude', action],
      { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true });
    const output = [];
    child.on('error', done);
    child.stdout.on('data', chunk => output.push(chunk));
    child.stdin.on('error', () => {});
    process.stdin.on('error', () => {});
    process.stdin.pipe(child.stdin);
    child.on('close', code => {
      if (code === 0 && action === 'inbox' && output.length > 0) process.stdout.write(Buffer.concat(output), done);
      else done();
    });
  } catch {
    done();
  }
}
