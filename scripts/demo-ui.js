'use strict';
// Dev-only UI demo: Mock-SHC + auto-accepting mock HCU + plugin instance.
// Fully populated WebUI (paired, devices included) WITHOUT touching the real
// HCU or the default data dir.
//
// Run:  node scripts/demo-ui.js   ->  http://localhost:8347
// Stop: Ctrl+C

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { createMockShc } = require('./mock-shc');

const ROOT = path.join(__dirname, '..');
const HCU_WS_PORT = 19003;
const SHC = { pairPort: 18443, apiPort: 18444, infoPort: 18446, pin: '12345678901234567890' };
const WEBUI_PORT = parseInt(process.env.DEMO_PORT || '8347', 10);
const PLUGIN_ID = 'de.essers.gerrit.plugin.boschbridge';
const HCU_IP = '192.168.178.128';

let pluginWs = null;
let seq = 0;
let child = null;
let mockShc = null;

function hcuSend(type, body) {
  if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) return;
  pluginWs.send(JSON.stringify({ id: 'hcu-' + (++seq), pluginId: PLUGIN_ID, type, body }));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- auto-accepting HCU mock: DISCOVER after READY, INCLUSION after DISCOVER ---
const wsServer = new WebSocket.Server({ port: HCU_WS_PORT, host: '127.0.0.1' });
wsServer.on('connection', (ws) => {
  pluginWs = ws;
  console.log('[demo-hcu] plugin connected');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'SYSTEM_INFO_REQUEST') {
      ws.send(JSON.stringify({ id: m.id, pluginId: PLUGIN_ID, type: 'SYSTEM_INFO_RESPONSE',
        body: { success: true, isOnlineMode: true, ipAddress: HCU_IP } }));
    } else if (m.type === 'HMIP_SYSTEM_REQUEST') {
      ws.send(JSON.stringify({ id: m.id, pluginId: PLUGIN_ID, type: 'HMIP_SYSTEM_RESPONSE',
        body: { code: 200, body: { devices: {} } } }));
    } else if (m.type === 'PLUGIN_STATE_RESPONSE' && m.body.pluginReadinessStatus === 'READY') {
      setTimeout(() => hcuSend('DISCOVER_REQUEST', {}), 300);
    } else if (m.type === 'DISCOVER_RESPONSE') {
      const ids = (m.body.devices || []).map((d) => d.deviceId);
      if (ids.length) {
        console.log('[demo-hcu] auto-including ' + ids.length + ' device(s)');
        setTimeout(() => hcuSend('INCLUSION_EVENT', { deviceIds: ids }), 300);
      }
    }
  });
  ws.on('close', () => { if (pluginWs === ws) pluginWs = null; });
});

function webui(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: WEBUI_PORT, method, path: urlPath,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 60000,
    }, (res) => {
      let acc = '';
      res.on('data', (c) => { acc += c; });
      res.on('end', () => { try { resolve(JSON.parse(acc || 'null')); } catch { resolve(acc); } });
    });
    r.on('timeout', () => r.destroy(new Error('timeout ' + urlPath)));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  mockShc = createMockShc(SHC);
  await mockShc.start();
  console.log('[demo] mock SHC: pair=' + SHC.pairPort + ' api=' + SHC.apiPort + ' info=' + SHC.infoPort + ' PIN=' + SHC.pin);

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'boschbridge-demo-'));
  fs.writeFileSync(path.join(tmpData, 'token.txt'), 'demo-token');
  child = spawn(process.execPath, [
    path.join(ROOT, 'server', 'index.js'),
    PLUGIN_ID,
    'ws://127.0.0.1:' + HCU_WS_PORT,
    path.join(tmpData, 'token.txt'),
  ], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATA_DIR: tmpData,
      WEBUI_PORT: String(WEBUI_PORT),
      BOSCH_PAIR_PORT: String(SHC.pairPort),
      BOSCH_API_PORT: String(SHC.apiPort),
      BOSCH_INFO_PORT: String(SHC.infoPort),
    }),
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => { console.log('[demo] plugin exited:', code); shutdown(); });

  for (let t = 0; t < 40; t++) {
    try { const s = await webui('GET', '/api/status'); if (s && s.pluginId) break; } catch { /* retry */ }
    await sleep(300);
  }
  console.log('[demo] WebUI: http://localhost:' + WEBUI_PORT);

  try {
    const pair = await webui('POST', '/api/bosch/pair', { host: '127.0.0.1', pin: SHC.pin });
    console.log('[demo] paired with mock SHC: ' + JSON.stringify(pair.status || pair).slice(0, 120));
  } catch (e) {
    console.log('[demo] pairing failed (already paired?):', e.message);
  }
  await sleep(1500);
  try {
    const st = await webui('GET', '/api/status');
    console.log('[demo] devices: known=' + st.devices.known + ' included=' + st.devices.included + ' - Demo bereit!');
  } catch { /* ignore */ }
}

function shutdown() {
  try { child && child.kill(); } catch { /* ignore */ }
  try { mockShc && mockShc.stop(); } catch { /* ignore */ }
  try { wsServer.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((e) => { console.error('[demo] fatal:', e); shutdown(); });
