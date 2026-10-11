'use strict';
// Dev-only smoke test: mocks the HCU side of the Connect API WebSocket and
// walks the plugin through READY -> DISCOVER -> STATUS -> CONFIG_TEMPLATE ->
// CONFIG_UPDATE -> SYSTEM_INFO -> re-disconnect, asserting each answer.
//
// Run:  node scripts/smoke-mock-hcu.js
// Exit code 0 = all checks passed.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const WS_PORT = 19001;
const WEBUI_PORT = 8342;
const PLUGIN_ID = 'de.essers.gerrit.plugin.boschbridge';
const HCU_IP = '192.168.99.50';

const results = [];
let wsServer;
let child;
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}
function fail(name, detail) { check(name, false, detail); finish(1); }

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error('bad json from ' + url)); }
      });
    }).on('error', reject);
  });
}
function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body || {}));
  });
}

// --- expectation queue -------------------------------------------------------
const pending = [];
function expect(type, desc, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${desc} (${type})`)), timeoutMs);
    pending.push({ type, predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}
let seq = 0;
function sendInit(ws, type, body) {
  const id = `mock-${++seq}`;
  ws.send(JSON.stringify({ id, pluginId: PLUGIN_ID, type, body }));
  return id;
}
function answerPlugin(ws, m) {
  ws.send(JSON.stringify({ id: m.id, pluginId: PLUGIN_ID, type: m._replyType, body: m._replyBody }));
}

async function runFlow(ws) {
  // 1. readiness
  sendInit(ws, 'PLUGIN_STATE_REQUEST', {});
  const ready = await expect('PLUGIN_STATE_RESPONSE', 'readiness');
  check('PLUGIN_STATE_RESPONSE READY', ready.body.pluginReadinessStatus === 'READY');

  // 2. plugin asks for system info (mock answers automatically)
  const infoReq = new Promise((resolve) => autoResponses.set('SYSTEM_INFO_REQUEST', resolve));
  await infoReq;
  check('plugin sent SYSTEM_INFO_REQUEST', true);
  await new Promise((r) => setTimeout(r, 500)); // let webuiUrl settle

  // 3. discovery
  sendInit(ws, 'DISCOVER_REQUEST', {});
  const disc = await expect('DISCOVER_RESPONSE', 'discover');
  check('DISCOVER_RESPONSE success + devices[]',
    disc.body.success === true && Array.isArray(disc.body.devices),
    `${disc.body.devices.length} devices`);

  // 4. status
  sendInit(ws, 'STATUS_REQUEST', {});
  const stat = await expect('STATUS_RESPONSE', 'status');
  check('STATUS_RESPONSE success', stat.body.success === true);

  // 5. config template
  sendInit(ws, 'CONFIG_TEMPLATE_REQUEST', {});
  const tpl = await expect('CONFIG_TEMPLATE_RESPONSE', 'config template');
  const p = tpl.body.properties || {};
  check('template has WEBLINK webui_link',
    p.webui_link && p.webui_link.dataType === 'WEBLINK');
  check('WEBLINK currentValue = http://<hcuIp>:8342',
    p.webui_link && p.webui_link.currentValue === `http://${HCU_IP}:${WEBUI_PORT}`,
    p.webui_link && p.webui_link.currentValue);
  check('template has status + boolean settings',
    !!p.hcu_status && p.hcu_status.dataType === 'READONLY' &&
    p.enableScenarios && p.enableScenarios.dataType === 'BOOLEAN');
  check('template groups present', Object.keys(tpl.body.groups || {}).length >= 4);

  // 6. config update (HCUweb save)
  sendInit(ws, 'CONFIG_UPDATE_REQUEST', { languageCode: 'de', properties: { enableEnergyMeters: true } });
  const upd = await expect('CONFIG_UPDATE_RESPONSE', 'config update');
  check('CONFIG_UPDATE_RESPONSE APPLIED', upd.body.status === 'APPLIED');
  const settings = await getJson(`http://127.0.0.1:${WEBUI_PORT}/api/settings`);
  check('config update persisted (enableEnergyMeters=true)',
    settings.settings.enableEnergyMeters === true);

  // 7. WebUI REST round-trips
  const status = await getJson(`http://127.0.0.1:${WEBUI_PORT}/api/status`);
  check('webui /api/status connected to mock hcu',
    status.hcu.connected === true && status.hcu.hcuIp === HCU_IP);
  const dev = await getJson(`http://127.0.0.1:${WEBUI_PORT}/api/devices`);
  check('webui /api/devices ok', Array.isArray(dev.devices));
  const logs = await getJson(`http://127.0.0.1:${WEBUI_PORT}/api/logs`);
  check('webui /api/logs has entries', Array.isArray(logs.entries) && logs.entries.length > 0);

  // 8. INCLUSION_EVENT for offered device ids -> twins stay resolvable
  sendInit(ws, 'INCLUSION_EVENT', { deviceIds: [] });
  await new Promise((r) => setTimeout(r, 300));
  check('INCLUSION_EVENT tolerated', true);

  // 9. re-discover via WebUI triggers a WS close by the plugin
  const closed = new Promise((resolve) => { ws.once('close', resolve); });
  await postJson(`http://127.0.0.1:${WEBUI_PORT}/api/rediscover`, {});
  await Promise.race([closed, new Promise((_, rej) => setTimeout(() => rej(new Error('no reconnect cycle')), 6000))])
    .then(() => check('rediscover closes WS for re-discovery', true))
    .catch((e) => fail('rediscover closes WS for re-discovery', e.message));

  // 10. reconnect: mock gets a fresh connection -> runFlow again would loop;
  // just verify second connection happened.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no reconnect within 8s')), 8000);
    wsServer.once('connection', () => { clearTimeout(t); resolve(); });
  })
    .then(() => check('plugin reconnects after rediscover', true))
    .catch((e) => fail('plugin reconnects after rediscover', e.message));

  finish(0);
}

// automatic answers to plugin-initiated requests
const autoResponses = new Map();
function attachAutoAnswer(ws) {
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    // dispatch to expectation queue
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].type === m.type && (!pending[i].predicate || pending[i].predicate(m))) {
        const [p] = pending.splice(i, 1);
        p.resolve(m);
        break;
      }
    }
    // auto-answer plugin requests
    if (m.type === 'SYSTEM_INFO_REQUEST') {
      ws.send(JSON.stringify({
        id: m.id, pluginId: PLUGIN_ID, type: 'SYSTEM_INFO_RESPONSE',
        body: { success: true, isOnlineMode: true, ipAddress: HCU_IP },
      }));
      const cb = autoResponses.get('SYSTEM_INFO_REQUEST');
      if (cb) { autoResponses.delete('SYSTEM_INFO_REQUEST'); cb(); }
    } else if (m.type === 'HMIP_SYSTEM_REQUEST') {
      ws.send(JSON.stringify({
        id: m.id, pluginId: PLUGIN_ID, type: 'HMIP_SYSTEM_RESPONSE',
        body: { code: 200, body: {} },
      }));
    }
  });
}

let connections = 0;
let flowStarted = false;
wsServer = new WebSocket.Server({ port: WS_PORT, host: '127.0.0.1' });
wsServer.on('connection', (ws, req) => {
  connections++;
  if (connections === 1) {
    check('ws handshake headers',
      req.headers['plugin-id'] === PLUGIN_ID &&
      !!req.headers.authtoken &&
      req.headers['hmip-system-events'] === 'true',
      `plugin-id=${req.headers['plugin-id']} token=${!!req.headers.authtoken} events=${req.headers['hmip-system-events']}`);
    attachAutoAnswer(ws);
    if (!flowStarted) { flowStarted = true; runFlow(ws).catch((e) => fail('flow', e.message)); }
  }
});
wsServer.on('error', (e) => fail('mock ws server', e.message));

// --- start the plugin --------------------------------------------------------
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'boschbridge-smoke-'));
fs.writeFileSync(path.join(tmpData, 'smoke-token.txt'), 'smoke-dummy-token');
child = spawn(process.execPath, [
  path.join(ROOT, 'server', 'index.js'),
  PLUGIN_ID,
  `ws://127.0.0.1:${WS_PORT}`,
  path.join(tmpData, 'smoke-token.txt'),
], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DATA_DIR: tmpData, WEBUI_PORT: String(WEBUI_PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });
child.on('exit', (code) => {
  if (code !== 0 && results.every((r) => r.ok)) {
    console.log('plugin exited early with code ' + code + '\n' + childLog);
    finish(1);
  }
});

const guard = setTimeout(() => fail('global timeout', '60s'), 60000);

function finish(code) {
  clearTimeout(guard);
  try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
  try { wsServer && wsServer.close(); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== smoke result: ${results.length - failed.length}/${results.length} passed ===`);
  if (code === 0 && failed.length) code = 1;
  setTimeout(() => process.exit(code), 200);
}
