'use strict';
/**
 * Historical session accounting for the dashboard.
 *
 * Deliberately coarse: only what a session looked like at each transition -
 * created, paired, closed - with no project name, working directory or
 * computer name carried past that moment. The live dashboard reads those from
 * the in-memory session registry while it exists; nothing about a stranger's
 * machine is written to disk, and nothing here survives past a session's own
 * lifetime except a timestamp, an id and a duration.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TERMLY_DATA_DIR || path.join(__dirname, 'data');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

// Kept small on purpose: this is a personal-scale relay's event log, not a
// metrics warehouse. Trimmed back to this many lines once comfortably past it,
// so a relay left running for months does not grow the file - or the read on
// every /api/dashboard/stats request - without bound.
const MAX_EVENTS = Number(process.env.TERMLY_HISTORY_MAX_EVENTS || 20000);

let pendingCount = null; // lines on disk, counted lazily on first write

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function countLines() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Keep only the newest MAX_EVENTS lines. Returns the new count. */
function trim() {
  let lines;
  try {
    lines = fs.readFileSync(EVENTS_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0;
  }
  if (lines.length <= MAX_EVENTS) return lines.length;
  const kept = lines.slice(lines.length - MAX_EVENTS);
  fs.writeFileSync(EVENTS_FILE, kept.join('\n') + '\n');
  return kept.length;
}

/** Record one transition. Never throws - a full disk should not crash a relay. */
function record(type, fields) {
  try {
    ensureDir();
    fs.appendFileSync(EVENTS_FILE, JSON.stringify({ type, ts: Date.now(), ...fields }) + '\n');

    pendingCount = (pendingCount ?? countLines() - 1) + 1;
    // Trimming rewrites the whole file, so it only runs once there is a real
    // margin past the cap rather than on every single line past it.
    if (pendingCount > MAX_EVENTS * 1.2) pendingCount = trim();
  } catch (err) {
    // A relay whose disk is full or read-only should keep relaying, not crash.
    console.error(`[history] failed to record "${type}": ${err.message}`);
  }
}

function readEvents() {
  try {
    return fs.readFileSync(EVENTS_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stats() {
  const events = readEvents();
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const created = events.filter(e => e.type === 'created');
  const paired = events.filter(e => e.type === 'paired');
  const closed = events.filter(e => e.type === 'closed');

  const byDay = new Map();
  for (const e of created) {
    const day = new Date(e.ts).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  const last14Days = [];
  for (let i = 13; i >= 0; i--) {
    const day = new Date(now - i * DAY).toISOString().slice(0, 10);
    last14Days.push({ day, count: byDay.get(day) || 0 });
  }

  const closedPaired = closed.filter(e => e.paired);
  const durations = closedPaired.map(e => e.durationMs).filter(Number.isFinite);
  const avgSessionDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null;

  const toPair = paired.map(e => e.msToPair).filter(Number.isFinite);
  const avgTimeToPairMs = toPair.length
    ? Math.round(toPair.reduce((a, b) => a + b, 0) / toPair.length)
    : null;

  const byAiTool = {};
  for (const e of created) {
    const tool = e.aiTool || 'unknown';
    byAiTool[tool] = (byAiTool[tool] || 0) + 1;
  }

  return {
    totalSessionsEver: created.length,
    sessionsLast24h: created.filter(e => now - e.ts < DAY).length,
    sessionsLast7d: created.filter(e => now - e.ts < 7 * DAY).length,
    last14Days,
    // Only sessions that have actually ended count toward this - a session
    // created a minute ago and still open has not failed to pair, it just
    // has not paired *yet*.
    pairSuccessRate: closed.length ? Number((closedPaired.length / closed.length).toFixed(3)) : null,
    avgSessionDurationMs,
    avgTimeToPairMs,
    byAiTool
  };
}

module.exports = { record, stats, DATA_DIR, EVENTS_FILE };
