/**
 * Spawns a real `termly start` against a relay and hands back its pairing code.
 *
 * Shared by the runner and by the tests that need to kill the CLI mid-session,
 * because those have to own the process rather than be handed a code.
 */
import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function startCli(serverUrl, { ai = 'demo' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'termly-test-'));
  const logPath = path.join(dir, 'cli.log');

  // `script` supplies the TTY the CLI insists on; `setsid` puts it in its own
  // process group so it can be killed as a unit and never orphans a PTY.
  const child = spawn('setsid', ['script', '-qec', `termly start --ai ${ai}`, '/dev/null'], {
    cwd: dir,
    env: { ...process.env, TERMLY_SERVER_URL: serverUrl, DEBUG: '1' },
    stdio: ['ignore', openSync(logPath, 'w'), 'inherit']
  });

  const kill = () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  };
  process.on('exit', kill);

  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const text = await readFile(logPath, 'utf8').catch(() => '');
    const match = text.match(/Pairing code generated: ([A-Z0-9]{6})/);
    if (match) return { child, code: match[1], logPath, kill };
  }
  kill();
  throw new Error(`CLI never printed a pairing code (see ${logPath})`);
}
