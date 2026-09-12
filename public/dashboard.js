// Polls the relay's own metadata endpoints and renders them. No build step,
// no dependency - this is an operator page, not something a redeploy should
// ever be able to break silently.

const $ = sel => document.querySelector(sel);
const REFRESH_MS = 5000;

function fmtAge(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function dot(on) {
  return `<span class="dot ${on ? 'on' : 'off'}" aria-hidden="true"></span>`;
}

function renderSessions({ sessions }) {
  $('#live-count').textContent = sessions.length ? `(${sessions.length})` : '';
  $('#live-empty').hidden = sessions.length > 0;
  const table = $('#live-table');
  table.hidden = sessions.length === 0;
  if (!sessions.length) return;

  table.querySelector('tbody').innerHTML = sessions.map(s => `
    <tr>
      <td class="mono">${s.sessionId}</td>
      <td>${fmtAge(s.ageMs)}</td>
      <td>${dot(s.cliConnected)}</td>
      <td>${dot(s.peerConnected)}</td>
      <td>${dot(s.paired)}</td>
      <td>${escapeHtml(s.aiTool || 'unknown')}</td>
      <td>${escapeHtml(s.projectName || '—')}</td>
      <td>${s.cols && s.rows ? `${s.cols}×${s.rows}` : '—'}</td>
      <td><button type="button" class="kill" data-id="${s.sessionId}">Kill</button></td>
    </tr>
  `).join('');
}

async function killSession(shortId, button) {
  if (!confirm(`End session ${shortId}? Both sides get disconnected immediately.`)) return;
  button.disabled = true;
  button.textContent = '…';
  try {
    const res = await fetch(`/api/dashboard/sessions/${encodeURIComponent(shortId)}/kill`, {
      method: 'POST',
      headers: { 'X-Termly-Dashboard': '1' }
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    await tick();
  } catch (err) {
    showError(`Could not end session ${shortId}: ${err.message}`);
    button.disabled = false;
    button.textContent = 'Kill';
  }
}

$('#live-table').addEventListener('click', e => {
  const button = e.target.closest('button.kill');
  if (button) killSession(button.dataset.id, button);
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return `${m}m`;
}

function statCard(label, value) {
  return `<div class="stat"><div class="value">${value}</div><div class="label">${label}</div></div>`;
}

function renderStats(stats) {
  $('#stat-grid').innerHTML = [
    statCard('Sessions ever', stats.totalSessionsEver),
    statCard('Last 24h', stats.sessionsLast24h),
    statCard('Last 7d', stats.sessionsLast7d),
    statCard('Pair success', stats.pairSuccessRate == null ? '—' : `${Math.round(stats.pairSuccessRate * 100)}%`),
    statCard('Avg time to pair', fmtDuration(stats.avgTimeToPairMs)),
    statCard('Avg session length', fmtDuration(stats.avgSessionDurationMs))
  ].join('');

  const max = Math.max(1, ...stats.last14Days.map(d => d.count));
  $('#bars').innerHTML = stats.last14Days.map(d => `
    <div class="bar" title="${d.day}: ${d.count}">
      <div class="fill" style="height:${Math.round((d.count / max) * 100)}%"></div>
      <div class="day">${d.day.slice(5)}</div>
    </div>
  `).join('');

  const tools = Object.entries(stats.byAiTool).sort((a, b) => b[1] - a[1]);
  $('#by-tool').innerHTML = tools.length
    ? tools.map(([tool, count]) => `<li>${escapeHtml(tool)} <b>${count}</b></li>`).join('')
    : '<li>No history yet.</li>';
}

function showError(message) {
  const el = $('#error');
  el.textContent = message;
  el.hidden = false;
}

async function tick() {
  try {
    const [sessionsRes, statsRes] = await Promise.all([
      fetch('/api/dashboard/sessions'),
      fetch('/api/dashboard/stats')
    ]);
    if (!sessionsRes.ok || !statsRes.ok) throw new Error('request failed');
    renderSessions(await sessionsRes.json());
    renderStats(await statsRes.json());
    $('#error').hidden = true;
  } catch (err) {
    showError(`Could not refresh: ${err.message}`);
  }
}

tick();
setInterval(tick, REFRESH_MS);
