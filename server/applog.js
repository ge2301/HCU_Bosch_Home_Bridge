'use strict';
// Tiny log helper: console output plus an in-memory ring buffer that the
// WebUI reads via GET /api/logs. (HCUweb "logsEnabled" shows docker logs,
// this buffer is the friendly in-WebUI view.)

const MAX_LINES = 500;
const ring = [];
let seq = 0;

function _fmt(level, args) {
  const t = new Date().toISOString().slice(11, 19);
  const parts = args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || a.message;
    try { return JSON.stringify(a); } catch { return String(a); }
  });
  return `${t} ${level} ${parts.join(' ')}`;
}

function info(...args) {
  console.log(...args);
  ring.push({ id: ++seq, level: 'info', text: _fmt('INFO ', args) });
  if (ring.length > MAX_LINES) ring.shift();
}

function warn(...args) {
  console.warn(...args);
  ring.push({ id: ++seq, level: 'warn', text: _fmt('WARN ', args) });
  if (ring.length > MAX_LINES) ring.shift();
}

function error(...args) {
  console.error(...args);
  ring.push({ id: ++seq, level: 'error', text: _fmt('ERROR', args) });
  if (ring.length > MAX_LINES) ring.shift();
}

/** Entries newer than `sinceId` (for polling). */
function since(sinceId) {
  return ring.filter((e) => e.id > sinceId);
}

module.exports = { info, warn, error, since };
