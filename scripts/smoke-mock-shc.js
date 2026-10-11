'use strict';
// Dev-only E2E smoke test for milestone M1/M1M:
// starts the Mock SHC in-process, then spawns the plugin pointed at it and
// walks pairing -> inventory -> control -> live events -> unpair over the
// plugin's own WebUI REST API.
//
// Run:  node scripts/smoke-mock-shc.js
// Exit code 0 = all checks passed.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { createMockShc } = require('./mock-shc');

const ROOT = path.join(__dirname, '..');
const WEBUI_PORT = 8343;
const PIN = '12345678901234567890';
const MOCK = { pairPort: 18443, apiPort: 18444, infoPort: 18446, pin: PIN };

const results = [];
let child;
let mock;
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`);
}
function finish(code) {
  try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
  try { mock && mock.stop(); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== smoke-mock-shc result: ${results.length - failed.length}/${results.length} passed ===`);
  setTimeout(() => process.exit(code || (failed.length ? 1 : 0)), 200);
}
function fail(name, detail) { check(name, false, detail); finish(1); }

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: WEBUI_PORT, method, path: urlPath,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
      timeout: 90000,
    }, (res) => {
      let acc = '';
      res.on('data', (c) => { acc += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = acc ? JSON.parse(acc) : null; } catch { parsed = acc; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    r.on('timeout', () => r.destroy(new Error('timeout ' + method + ' ' + urlPath)));
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWebui(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await req('GET', '/api/status');
      if (r.statusCode === 200) return true;
    } catch { /* not up yet */ }
    await sleep(400);
  }
  return false;
}

async function run() {
  mock = createMockShc(MOCK);
  await mock.start();

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'boschbridge-m1-'));
  child = spawn(process.execPath, [
    path.join(ROOT, 'server', 'index.js'),
    'de.essers.gerrit.plugin.boschbridge',
    'ws://127.0.0.1:19998', // no HCU here -> hcu client just retries, irrelevant
    path.join(tmpData, 'missing-token.txt'),
  ], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      DATA_DIR: tmpData,
      WEBUI_PORT: String(WEBUI_PORT),
      BOSCH_PAIR_PORT: String(MOCK.pairPort),
      BOSCH_API_PORT: String(MOCK.apiPort),
      BOSCH_INFO_PORT: String(MOCK.infoPort),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childLog = '';
  child.stdout.on('data', (d) => { childLog += d; });
  child.stderr.on('data', (d) => { childLog += d; });
  child.on('exit', (code) => {
    if (code !== 0 && results.length && results.every((r) => r.ok)) {
      console.log('plugin exited early (' + code + '):\n' + childLog);
      finish(1);
    }
  });

  if (!await waitForWebui()) return fail('plugin webui reachable', 'timeout');

  // 1. wrong PIN -> clean error
  let r = await req('POST', '/api/bosch/pair', { host: '127.0.0.1', pin: 'wrongpin' });
  check('pair with wrong PIN rejected', r.statusCode === 400 && /PIN/.test(String(r.body && r.body.error)), r.body && r.body.error);

  // 2. correct PIN -> paired + connected + inventory
  r = await req('POST', '/api/bosch/pair', { host: '127.0.0.1', pin: PIN });
  check('pairing accepted', r.statusCode === 200 && r.body.ok, JSON.stringify(r.body));
  const st = r.body && r.body.status;
  check('manager connected to mock SHC', st && st.paired && st.connected, JSON.stringify(st));
  check('inventory loaded (9 devices)', st && st.deviceCount === 9, st && `count=${st.deviceCount}`);

  // 3. pairing material persisted
  r = await req('GET', '/api/bosch/status');
  check('clientId is oss_*', /^oss_/.test(String(r.body.clientId || '')), r.body.clientId);
  const crt = path.join(tmpData, 'bosch', 'client.crt');
  check('client cert stored', fs.existsSync(crt));

  // 4. devices + initial states via WebUI API
  r = await req('GET', '/api/bosch/devices');
  const devs = r.body.devices || [];
  const plug = devs.find((d) => d.id === 'isymos:0');
  check('device list served', devs.length === 9, `n=${devs.length}`);
  check('device names resolved from locations',
    plug && plug.name === 'Stehlampe', plug && plug.name);
  check('powerSwitch initial state ON',
    plug && plug.states.powerSwitch && plug.states.powerSwitch.switchState === 'ON',
    plug && JSON.stringify(plug.states));

  // 5. control through the plugin (manager -> SHC PUT)
  r = await req('POST', '/api/bosch/control', {
    deviceId: 'isymos:0', serviceId: 'powerSwitch',
    state: { '@type': 'powerSwitchState', switchState: 'OFF' },
  });
  check('control PUT accepted', r.statusCode === 200 && r.body.ok, JSON.stringify(r.body));
  check('mock state changed', mock.state.states['isymos:0/powerSwitch'].switchState === 'OFF');

  // 6. live event delivery: mock change -> long-poll -> manager state cache
  await sleep(1500); // let the long-poll deliver the control echo first
  mock.simulateState('isyods:0/contactDetection', { contactDetection: 'opened' });
  mock.simulateState('isytho:0/climateControl', { setpointTemperature: 18.0 });
  await sleep(2000);
  r = await req('GET', '/api/bosch/devices');
  const dev2 = r.body.devices || [];
  const ews = dev2.find((d) => d.id === 'isyods:0');
  const ths = dev2.find((d) => d.id === 'isytho:0');
  check('contact event arrived via long-poll',
    ews && ews.states.contactDetection && ews.states.contactDetection.contactDetection === 'opened',
    ews && JSON.stringify(ews.states.contactDetection));
  check('thermostat setpoint event arrived',
    ths && ths.states.climateControl && ths.states.climateControl.setpointTemperature === 18.0,
    ths && JSON.stringify(ths.states.climateControl && ths.states.climateControl.setpointTemperature));

  // 7. HCU config page now shows real bosch status
  r = await req('GET', '/api/status');
  check('/api/status embeds bosch state', r.body.bosch && r.body.bosch.paired && r.body.bosch.connected);

  // 8. unpair removes client from SHC + local material
  r = await req('POST', '/api/bosch/unpair');
  check('unpair ok', r.statusCode === 200 && r.body.ok && r.body.status.paired === false);
  check('SHC client list empty again', mock.pairedClients.size === 0);
  check('cert material deleted', !fs.existsSync(crt));

  finish(0);
}

const guard = setTimeout(() => fail('global timeout', '90s'), 90000);
run().catch((e) => fail('run', e.stack || e.message)).finally(() => clearTimeout(guard));
