'use strict';
// Dev-only end-to-end smoke test (M3): full vertical slice
//   Mock HCU (WebSocket, Connect API) <-> plugin <-> Mock SHC (mTLS REST)
//
// Verifies: pairing -> offering via DISCOVER -> INCLUSION -> STATUS features ->
// CONTROL_REQUEST -> Bosch PUT -> live Bosch event -> STATUS_EVENT -> config
// page mapping rows -> new-device re-discovery.
//
// Run:  node scripts/smoke-e2e.js
// Exit code 0 = all checks passed.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const WebSocket = require('ws');
const { createMockShc } = require('./mock-shc');

const ROOT = path.join(__dirname, '..');
const HCU_WS_PORT = 19002;
const SHC = { pairPort: 18453, apiPort: 18454, infoPort: 18455, pin: '12345678901234567890' };
const WEBUI_PORT = 8344;
const PLUGIN_ID = 'de.essers.gerrit.plugin.boschbridge';
const HCU_IP = '192.168.99.60';

const results = [];
let wsServer;
let mockShc;
let child;
let pluginWs = null;

function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}
function finish(code) {
  try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
  try { mockShc && mockShc.stop(); } catch { /* ignore */ }
  try { wsServer && wsServer.close(); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== smoke-e2e result: ${results.length - failed.length}/${results.length} passed ===`);
  setTimeout(() => process.exit(code || (failed.length ? 1 : 0)), 200);
}
function fail(name, detail) { check(name, false, detail); finish(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- tiny HCU mock ----------------------------------------------------------
const pending = [];
function expect(type, timeoutMs = 15000, predicate = null) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
    pending.push({ type, predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
  });
}
let seq = 0;
function hcuSend(type, body) {
  const id = `hcu-${++seq}`;
  if (!pluginWs || pluginWs.readyState !== WebSocket.OPEN) throw new Error('plugin ws not connected');
  pluginWs.send(JSON.stringify({ id, pluginId: PLUGIN_ID, type, body }));
  return id;
}

wsServer = new WebSocket.Server({ port: HCU_WS_PORT, host: '127.0.0.1' });
wsServer.on('connection', (ws) => {
  pluginWs = ws; // latest connection wins (reconnects reuse the flow)
  attach(ws);
});
function attach(ws) {
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].type === m.type && (!pending[i].predicate || pending[i].predicate(m))) {
        const [p] = pending.splice(i, 1); p.resolve(m); break;
      }
    }
    if (m.type === 'SYSTEM_INFO_REQUEST') {
      ws.send(JSON.stringify({ id: m.id, pluginId: PLUGIN_ID, type: 'SYSTEM_INFO_RESPONSE',
        body: { success: true, isOnlineMode: true, ipAddress: HCU_IP } }));
    } else if (m.type === 'HMIP_SYSTEM_REQUEST') {
      ws.send(JSON.stringify({ id: m.id, pluginId: PLUGIN_ID, type: 'HMIP_SYSTEM_RESPONSE',
        body: { code: 200, body: { devices: {} } } }));
    } else if (m.type === 'PLUGIN_STATE_RESPONSE' && m.body.pluginReadinessStatus === 'READY') {
      // The real HCU starts a discovery cycle whenever the plugin reports ready.
      ws.send(JSON.stringify({ id: `hcu-${++seq}`, pluginId: PLUGIN_ID, type: 'DISCOVER_REQUEST', body: {} }));
    }
  });
}

// ---- WebUI REST helper --------------------------------------------------------
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
async function waitForWebui(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const s = await webui('GET', '/api/status'); if (s && s.pluginId) return true; } catch { /* retry */ }
    await sleep(400);
  }
  return false;
}

// ---- flow ---------------------------------------------------------------------
async function run() {
  mockShc = createMockShc(SHC);
  await mockShc.start();

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'boschbridge-e2e-'));
  fs.writeFileSync(path.join(tmpData, 'token.txt'), 'e2e-token');
  child = spawn(process.execPath, [
    path.join(ROOT, 'server', 'index.js'),
    PLUGIN_ID,
    `ws://127.0.0.1:${HCU_WS_PORT}`,
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
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  child.on('exit', (code) => {
    if (code !== 0 && results.every((r) => r.ok)) {
      console.log('plugin exited early (' + code + '):\n' + childLog);
      finish(1);
    }
  });

  // plugin connects to mock HCU and announces READY (expect queued early)
  const readyP = expect('PLUGIN_STATE_RESPONSE');
  if (!await waitForWebui()) return fail('webui up', 'timeout');
  const t0 = Date.now();
  while (!pluginWs && Date.now() - t0 < 10000) await sleep(200);
  check('plugin connected to mock HCU WS', !!pluginWs);
  const ready = await readyP;
  check('READY', ready.body.pluginReadinessStatus === 'READY');

  // pair with mock SHC over the WebUI
  const pair = await webui('POST', '/api/bosch/pair', { host: '127.0.0.1', pin: SHC.pin });
  check('paired with mock SHC', pair.ok === true && pair.status.connected, JSON.stringify(pair).slice(0, 120));

  // Pairing created new devices -> the plugin reconnects (3 s) and the mock's
  // fresh connection triggers DISCOVER_REQUEST automatically.
  const disc1 = await expect('DISCOVER_RESPONSE', 25000);
  const offeredIds = (disc1.body.devices || []).map((d) => d.deviceId);
  const expectedCore = ['isytho:0', 'isymos:0', 'isyods:0', 'isybrt:0', 'isywg:0', 'isymd:0', 'isywls:0'];
  const expectedVirtual = ['bosch:scene:SCENES/1', 'bosch:scene:SCENES/2', 'bosch:intrusion'];
  check('DISCOVER offers mapped devices',
    expectedCore.every((id) => offeredIds.includes(id)),
    `offered=${offeredIds.length}`);
  check('DISCOVER offers scenes + intrusion',
    expectedVirtual.every((id) => offeredIds.includes(id)),
    offeredIds.filter((i) => i.startsWith('bosch:')).join(','));
  const types = Object.fromEntries((disc1.body.devices || []).map((d) => [d.deviceId, d.deviceType]));
  check('device archetypes correct',
    types['isytho:0'] === 'THERMOSTAT' && types['isymos:0'] === 'SWITCH' &&
    types['isyods:0'] === 'CONTACT_SENSOR' && types['isybrt:0'] === 'WINDOW_COVERING' &&
    types['isymd:0'] === 'OCCUPANCY_SENSOR' && types['isywls:0'] === 'WATER_SENSOR' &&
    types['bosch:intrusion'] === 'SWITCH',
    JSON.stringify(types));

  // energy meter NOT offered yet (setting off)
  check('energy secondary hidden by default', !offeredIds.includes('isymos:0:energy'));

  // inclusion: HCU accepts the offered ids
  const statusAfterIncl = expect('STATUS_RESPONSE');
  hcuSend('INCLUSION_EVENT', { deviceIds: offeredIds });
  const incl = await statusAfterIncl;
  const inclDev = Object.fromEntries((incl.body.devices || []).map((d) => [d.deviceId, d.features]));
  check('INCLUSION_EVENT -> full STATUS_RESPONSE', incl.body.success === true && Object.keys(inclDev).length >= offeredIds.length);
  check('features are flat per Connect API',
    Array.isArray(inclDev['isymos:0']) &&
    inclDev['isymos:0'].some((f) => f.type === 'switchState' && typeof f.on === 'boolean') &&
    inclDev['isytho:0'].some((f) => f.type === 'setPointTemperature' && typeof f.setPointTemperature === 'number'),
    JSON.stringify(inclDev['isymos:0']));

  // config page mapping rows now filled (READONLY per device)
  const tplP = expect('CONFIG_TEMPLATE_RESPONSE');
  hcuSend('CONFIG_TEMPLATE_REQUEST', {});
  const tpl = await tplP;
  const mapKeys = Object.keys(tpl.body.properties).filter((k) => k.startsWith('map_'));
  check('config page lists mappings', mapKeys.length >= offeredIds.length, `rows=${mapKeys.length}`);
  const plugRow = Object.entries(tpl.body.properties).find(([k]) => k.includes('isymos_0'));
  check('plug row shows live state text', plugRow && /AN|AUS/.test(plugRow[1].currentValue), plugRow && plugRow[1].currentValue);

  // CONTROL_REQUEST from HCU -> Bosch PUT
  mockShc.state.states['isymos:0/powerSwitch'].switchState = 'ON';
  const ctrlP = expect('CONTROL_RESPONSE');
  hcuSend('CONTROL_REQUEST', { deviceId: 'isymos:0', features: [{ type: 'switchState', on: false }] });
  const ctrl = await ctrlP;
  check('CONTROL_RESPONSE success', ctrl.body.success === true, JSON.stringify(ctrl.body));
  check('Bosch state switched OFF via HCU', mockShc.state.states['isymos:0/powerSwitch'].switchState === 'OFF');

  // scene trigger via virtual device
  const sceneP = expect('CONTROL_RESPONSE');
  hcuSend('CONTROL_REQUEST', { deviceId: 'bosch:scene:SCENES/1', features: [{ type: 'switchState', on: true }] });
  const sceneCtrl = await sceneP;
  check('scene trigger success', sceneCtrl.body.success === true);
  check('scene active on SHC', mockShc.state.scenes[0].active === true);

  // intrusion arm via virtual device
  const armP = expect('CONTROL_RESPONSE');
  hcuSend('CONTROL_REQUEST', { deviceId: 'bosch:intrusion', features: [{ type: 'switchState', on: true }] });
  const armCtrl = await armP;
  check('intrusion arm success', armCtrl.body.success === true, JSON.stringify(armCtrl.body));
  check('SHC safe state armed', /ARMED/.test(mockShc.state.states['isyhsg:0/safe'].overallState || ''));

  // live Bosch event -> STATUS_EVENT pushed to HCU
  const evP = expect('STATUS_EVENT', 10000, (m) => m.body && m.body.deviceId === 'isyods:0');
  mockShc.simulateState('isyods:0/contactDetection', { contactDetection: 'opened' });
  const ev = await evP;
  check('STATUS_EVENT for contact sensor',
    ev.body.deviceId === 'isyods:0' &&
    ev.body.features.some((f) => f.type === 'contactSensorState' && f.triggered === true),
    JSON.stringify(ev.body.features));

  // new device appears on SHC -> refresh -> plugin reconnects for re-discovery
  const reconnectSeen = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 15000);
    wsServer.once('connection', () => { clearTimeout(t); resolve(true); });
  });
  mockShc.state.devices.push({ id: 'isync:0', roomHint: 'Buero' });
  mockShc.state.services.push({ id: 'isync:0', vendorHint: 'bosch', deviceType: 'PSCT', deviceUri: '/devices/isync:0', definedServices: [{ id: 'powerSwitch', version: 2 }] });
  mockShc.state.states['isync:0/powerSwitch'] = { '@type': 'powerSwitchState', switchState: 'ON' };
  await webui('POST', '/api/bosch/refresh', {});
  check('new device triggers reconnect', await reconnectSeen);
  const disc2 = await expect('DISCOVER_RESPONSE', 15000);
  const newIds = (disc2.body.devices || []).map((d) => d.deviceId);
  check('only NEW device re-offered', newIds.length === 1 && newIds[0] === 'isync:0', JSON.stringify(newIds));

  finish(0);
}

const guard = setTimeout(() => fail('global timeout', '120s'), 120000);
run().catch((e) => fail('run', e.stack || e.message)).finally(() => clearTimeout(guard));
