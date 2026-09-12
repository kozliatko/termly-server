/**
 * The dashboard's on-disk event log, in isolation from the server: what gets
 * recorded, what /api/dashboard/stats computes from it, and that the file
 * never grows without bound on a relay nobody ever restarts.
 *
 * `TERMLY_DATA_DIR` has to be set before history.js is first imported, since
 * it reads the env once at module load - a dynamic import after setting it
 * is what makes that ordering explicit rather than accidental.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'termly-history-'));
process.env.TERMLY_DATA_DIR = dir;
process.env.TERMLY_HISTORY_MAX_EVENTS = '10';
const { default: history } = await import('../history.js');

check('the event file does not exist before the first record', !fs.existsSync(history.EVENTS_FILE));

history.record('created', { sessionId: 'a', aiTool: 'claude-code' });
check('recording creates the data directory and the file', fs.existsSync(history.EVENTS_FILE));

history.record('paired', { sessionId: 'a', msToPair: 1500 });
history.record('closed', { sessionId: 'a', paired: true, durationMs: 60000, reason: 'idle' });

history.record('created', { sessionId: 'b', aiTool: 'claude-code' });
history.record('closed', { sessionId: 'b', paired: false, durationMs: 2000, reason: 'pairing expired' });

const stats = history.stats();

check('totalSessionsEver counts every "created" event', stats.totalSessionsEver === 2,
  String(stats.totalSessionsEver));
check('pairSuccessRate only counts sessions that have closed, one of two paired', stats.pairSuccessRate === 0.5,
  String(stats.pairSuccessRate));
check('avgSessionDurationMs averages only closed sessions that paired', stats.avgSessionDurationMs === 60000,
  String(stats.avgSessionDurationMs));
check('avgTimeToPairMs reflects the one "paired" event recorded', stats.avgTimeToPairMs === 1500,
  String(stats.avgTimeToPairMs));
check('byAiTool tallies the tool named at creation', stats.byAiTool['claude-code'] === 2,
  JSON.stringify(stats.byAiTool));

const today = new Date().toISOString().slice(0, 10);
const todayEntry = stats.last14Days.find(d => d.day === today);
check('last14Days includes today with both creations counted', todayEntry?.count === 2,
  JSON.stringify(todayEntry));
check('last14Days covers exactly 14 days', stats.last14Days.length === 14,
  String(stats.last14Days.length));

// A session still open has neither succeeded nor failed to pair yet, so it
// must not be counted either way.
const beforeOpen = history.stats().pairSuccessRate;
history.record('created', { sessionId: 'c', aiTool: 'claude-code' });
check('an open session (created, not yet closed) does not move pairSuccessRate',
  history.stats().pairSuccessRate === beforeOpen);

// Past MAX_EVENTS * 1.2 (12, here), the log is trimmed back toward the cap -
// not to it exactly on every write, but it must never be left to grow
// unboundedly on a relay that runs for months.
for (let i = 0; i < 20; i++) {
  history.record('created', { sessionId: `bulk-${i}`, aiTool: 'bulk' });
}
const lineCount = fs.readFileSync(history.EVENTS_FILE, 'utf8').split('\n').filter(Boolean).length;
check('the event log is kept near the configured cap rather than growing forever',
  lineCount <= 12, `${lineCount} lines, cap 10`);

const failed = checks.filter(c => !c).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
