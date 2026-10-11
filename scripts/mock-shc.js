'use strict';
// Mock Bosch Smart Home Controller (milestone M1M).
//
// Simulates the local SHC API closely enough to develop and test the plugin
// without physical hardware:
//   :18446  GET /smarthome/public/information            (no client cert)
//   :18443  POST/DELETE /smarthome/clients               (pairing, Systempassword header)
//   :18444  /smarthome/** + /remote/json-rpc             (mTLS client cert required)
//
// Event model: every successful PUT on a service state broadcasts an
// RE/notify notification to all RE/subscribe subscribers, delivered through
// the next RE/longPoll call. Also a --tick mode flips the power switch every
// few seconds to simulate activity.
//
// Standalone:  node scripts/mock-shc.js [--pin PIN] [--tick]
// Programmatic: const { createMockShc } = require('./mock-shc'); await createMockShc({...}).start()

const https = require('https');
const selfsigned = require('selfsigned');

const DEFAULTS = { pairPort: 18443, apiPort: 18444, infoPort: 18446, pin: '12345678901234567890' };

// ---------------------------------------------------------------------------
// fake device inventory (deviceTypes + service ids mirror the real Bosch
// naming seen in boschshcpy / bosch-shc-api-docs; refined in M2)
// ---------------------------------------------------------------------------
function buildFakeState() {
  return {
    devices: [
      { id: 'isytho:0', roomHint: 'Wohnzimmer' },
      { id: 'isymos:0', roomHint: 'Wohnzimmer' },
      { id: 'isyods:0', roomHint: 'Flur' },
      { id: 'isybrt:0', roomHint: 'Schlafzimmer' },
      { id: 'isywg:0', roomHint: 'Kinderzimmer' },
      { id: 'isyhsg:0', roomHint: 'HOME' },
      { id: 'isypm:0', roomHint: 'Keller' },
      { id: 'isymd:0', roomHint: 'Flur' },
      { id: 'isywls:0', roomHint: 'Bad' },
    ],
    services: [
      { id: 'isytho:0', vendorHint: 'bosch', deviceType: 'HFSThermostat', deviceUri: '/devices/isytho:0', definedServices: [{ id: 'climateControl', version: 2 }, { id: 'humidityLevel', version: 1 }] },
      { id: 'isymos:0', vendorHint: 'bosch', deviceType: 'PSCT', deviceUri: '/devices/isymos:0', definedServices: [{ id: 'powerSwitch', version: 2 }, { id: 'powerMeter', version: 1 }] },
      { id: 'isyods:0', vendorHint: 'bosch', deviceType: 'ODS', deviceUri: '/devices/isyods:0', definedServices: [{ id: 'contactDetection', version: 1 }] },
      { id: 'isybrt:0', vendorHint: 'bosch', deviceType: 'BRT', deviceUri: '/devices/isybrt:0', definedServices: [{ id: 'shutterControl', version: 1 }] },
      { id: 'isywg:0', vendorHint: 'bosch', deviceType: 'TWGD', deviceUri: '/devices/isywg:0', definedServices: [{ id: 'multilevelToggle', version: 1 }, { id: 'airQuality', version: 1 }, { id: 'smokeAlarm', version: 1 }] },
      { id: 'isyhsg:0', vendorHint: 'bosch', deviceType: 'HSG', deviceUri: '/devices/isyhsg:0', definedServices: [{ id: 'safe', version: 2 }, { id: 'smokeAlarm', version: 1 }] },
      { id: 'isypm:0', vendorHint: 'bosch', deviceType: 'PSM', deviceUri: '/devices/isypm:0', definedServices: [{ id: 'powerSwitch', version: 2 }, { id: 'powerMeter', version: 1 }] },
      { id: 'isymd:0', vendorHint: 'bosch', deviceType: 'MD', deviceUri: '/devices/isymd:0', definedServices: [{ id: 'latestMotion', version: 1 }, { id: 'brightness', version: 1 }] },
      { id: 'isywls:0', vendorHint: 'bosch', deviceType: 'WLS', deviceUri: '/devices/isywls:0', definedServices: [{ id: 'waterLevelDetection', version: 1 }] },
    ],
    states: {
      'isytho:0/climateControl': { '@type': 'climateControlState', 'com.bosch.smartservice.hvac.ventilstate': 'CLOSED', displayBrightness: 0, ecoMode: 'ON', emergencyProgramState: 'INACTIVE', heating: false, humidity: 47, setpointTemperature: 21.5, temperature: 22.1 },
      'isytho:0/humidityLevel': { '@type': 'humidityLevelState', humidityLevel: 47 },
      'isymos:0/powerSwitch': { '@type': 'powerSwitchState', switchState: 'ON' },
      'isymos:0/powerMeter': { '@type': 'powerMeterElectricState', current: 0.34, frequency: 50, power: 79.2, voltage: 231.4 },
      'isyods:0/contactDetection': { '@type': 'contactDetectionState', contactDetection: 'closed' },
      'isybrt:0/shutterControl': { '@type': 'shutterControlState', primaryDirection: 'STOP', secondaryDirection: 'STOP', shutterLevel: 0.25 },
      'isywg:0/multilevelToggle': { '@type': 'multilevelState', 'com.bosch.shc.twinguard.ventilstate': 'LEVEL_2', primaryLevel: 'GREEN', secondaryLevel: null, tertiaryLevel: 'GOOD' },
      'isywg:0/airQuality': { '@type': 'airQualityState', airQuality: 'GOOD' },
      'isywg:0/smokeAlarm': { '@type': 'smokeAlarmState', smokeAlarmDetection: 'IDLE' },
      'isyhsg:0/safe': { '@type': 'safeState', overallState: 'IDLE', parentState: 'IDLE' },
      'isyhsg:0/smokeAlarm': { '@type': 'smokeAlarmState', smokeAlarmDetection: 'IDLE' },
      'isypm:0/powerSwitch': { '@type': 'powerSwitchState', switchState: 'OFF' },
      'isypm:0/powerMeter': { '@type': 'powerMeterElectricState', current: 0, frequency: 50, power: 0, voltage: 230.1 },
      'isymd:0/latestMotion': { '@type': 'latestMotionState', motionDetected: false },
      'isymd:0/brightness': { '@type': 'brightnessLevelState', brightness: 42 },
      'isywls:0/waterLevelDetection': { '@type': 'waterLeakageState', waterLeakageDetected: false },
    },
    locations: [
      {
        id: 'HOME', name: 'Zuhause', type: 'HOME',
        children: [
          {
            id: 'HOME/ROOM_0', name: 'Wohnzimmer', type: 'ROOM',
            children: [
              { name: 'Heizkoerper', deviceUri: '/devices/isytho:0', type: 'DEVICE' },
              { name: 'Stehlampe', deviceUri: '/devices/isymos:0', type: 'DEVICE' },
            ],
          },
          {
            id: 'HOME/ROOM_1', name: 'Flur', type: 'ROOM',
            children: [
              { name: 'Fensterkontakt', deviceUri: '/devices/isyods:0', type: 'DEVICE' },
              { name: 'Bewegungsmelder', deviceUri: '/devices/isymd:0', type: 'DEVICE' },
            ],
          },
          {
            id: 'HOME/ROOM_2', name: 'Schlafzimmer', type: 'ROOM',
            children: [{ name: 'Rollladen', deviceUri: '/devices/isybrt:0', type: 'DEVICE' }],
          },
          {
            id: 'HOME/ROOM_3', name: 'Kinderzimmer', type: 'ROOM',
            children: [{ name: 'Twinguard', deviceUri: '/devices/isywg:0', type: 'DEVICE' }],
          },
          {
            id: 'HOME/ROOM_4', name: 'Keller', type: 'ROOM',
            children: [{ name: 'Smart Plug', deviceUri: '/devices/isypm:0', type: 'DEVICE' }],
          },
          {
            id: 'HOME/ROOM_5', name: 'Bad', type: 'ROOM',
            children: [{ name: 'Wassermelder', deviceUri: '/devices/isywls:0', type: 'DEVICE' }],
          },
        ],
      },
    ],
    scenes: [
      { id: 'SCENES/1', name: 'Kino', active: false },
      { id: 'SCENES/2', name: 'Guten Nacht', active: false },
    ],
  };
}

class MockShc {
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULTS, opts);
    this.state = buildFakeState();
    this.pairedClients = new Map(); // clientId -> {clientKey, role}
    this.subscribers = new Map();   // subId -> queue[]
    this.pendingPolls = [];         // {resolve, queue}
    this.servers = [];
    this.tickTimer = null;
  }

  async _certs() {
    if (!this._cached) {
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'mock-shc.local' }], { keySize: 2048, days: 365, algorithm: 'sha256' });
      this._cached = { key: pems.private, cert: pems.cert };
    }
    return this._cached;
  }

  async start() {
    const tls = await this._certs();
    this.servers.push(await this._listen(this.opts.infoPort, tls, false, this._infoApp.bind(this)));
    this.servers.push(await this._listen(this.opts.pairPort, tls, false, this._pairApp.bind(this)));
    this.servers.push(await this._listen(this.opts.apiPort, tls, true, this._apiApp.bind(this)));
    if (this.opts.tick) this._startTick();
    return this;
  }

  async stop() {
    if (this.tickTimer) clearInterval(this.tickTimer);
    for (const { server, close } of this.servers) {
      try { close(); } catch { /* ignore */ }
      try { server.closeAllConnections && server.closeAllConnections(); } catch { /* ignore */ }
    }
    this.servers = [];
  }

  _listen(port, tls, requestCert, handler) {
    return new Promise((resolve, reject) => {
      const server = https.createServer({ key: tls.key, cert: tls.cert, requestCert, rejectUnauthorized: false }, handler);
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve({ server, close: () => server.close() }));
    });
  }

  // ---- helpers ------------------------------------------------------------

  _sendJson(res, code, obj) {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  _readBody(req) {
    return new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : null); } catch { resolve(data); }
      });
    });
  }

  _hasClientCert(req) {
    try {
      const cert = req.socket.getPeerCertificate();
      return cert && cert.raw && cert.raw.length > 0;
    } catch { return false; }
  }

  _broadcast(source, data) {
    for (const [, queue] of this.subscribers) {
      queue.push({ jsonrpc: '2.0', method: 'RE/notify', params: [null, { source, data }] });
    }
    // wake up any waiting long-poll immediately
    while (this.pendingPolls.length) {
      const poll = this.pendingPolls.pop();
      poll.drain();
    }
  }

  _startTick() {
    this.tickTimer = setInterval(() => {
      const key = 'isymos:0/powerSwitch';
      const st = this.state.states[key];
      st.switchState = st.switchState === 'ON' ? 'OFF' : 'ON';
      this._broadcast('com/bosch/sh/remote/devices/isymos:0/services/powerSwitch/state', Object.assign({}, st));
    }, 5000);
    if (this.tickTimer.unref) this.tickTimer.unref();
  }

  // ---- :8446-equivalent public info ----------------------------------------

  _infoApp(req, res) {
    if (req.method === 'GET' && req.url === '/smarthome/public/information') {
      return this._sendJson(res, 200, {
        '@type': 'information',
        deviceName: 'Mock SHC',
        firmwareVersion: '1.0.9.1125',
        model: 'BDC2',
        serial: 'CB0xMOCK1234',
        inlinePaymentState: 'NONE',
        isDefaultRuntimeMode: true,
        isUsingStunservers: true,
      });
    }
    this._sendJson(res, 404, { error: 'not found' });
  }

  // ---- :8443-equivalent pairing ---------------------------------------------

  async _pairApp(req, res) {
    if (req.method === 'POST' && req.url === '/smarthome/clients') {
      const sysPw = req.headers.systempassword || '';
      const expected = Buffer.from(this.opts.pin, 'utf8').toString('base64');
      if (sysPw !== expected) return this._sendJson(res, 401, { error: 'invalid system password' });
      const body = await this._readBody(req);
      if (!body || !body.clientId || !String(body.clientId).startsWith('oss_')) {
        return this._sendJson(res, 400, { error: 'clientId must start with oss_' });
      }
      if (body.role !== 'ROLE_RESTRICTED_CLIENT' && body.role !== 'ROLE_FULL_CLIENT') {
        return this._sendJson(res, 400, { error: 'invalid role' });
      }
      this.pairedClients.set(body.clientId, { clientKey: body.clientKey, role: body.role });
      return this._sendJson(res, 200, { id: this.pairedClients.size, clientId: body.clientId });
    }
    if (req.method === 'DELETE' && /^\/smarthome\/clients\//.test(req.url)) {
      const clientId = decodeURIComponent(req.url.split('/').pop());
      const auth = Buffer.from(String(req.headers.authorization || '').replace(/^Basic /, ''), 'base64').toString('utf8');
      const [id, key] = auth.split(':');
      const rec = this.pairedClients.get(clientId);
      if (id === clientId && rec && rec.clientKey === key) {
        this.pairedClients.delete(clientId);
        return this._sendJson(res, 200);
      }
      return this._sendJson(res, 401, { error: 'unauthorized' });
    }
    this._sendJson(res, 404, { error: 'not found' });
  }

  // ---- :8444-equivalent API + JSON-RPC ---------------------------------------

  async _apiApp(req, res) {
    if (!this._hasClientCert(req)) {
      return this._sendJson(res, 403, { error: 'client certificate required' });
    }
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/smarthome/devices') return this._sendJson(res, 200, this.state.devices);
    if (req.method === 'GET' && url === '/smarthome/services') return this._sendJson(res, 200, this.state.services);
    if (req.method === 'GET' && url === '/smarthome/scenes') return this._sendJson(res, 200, this.state.scenes);
    if (req.method === 'GET' && url === '/smarthome/locations') return this._sendJson(res, 200, this.state.locations);

    let m = /^\/smarthome\/devices\/([^/]+)\/services$/.exec(url);
    if (req.method === 'GET' && m) {
      const dev = decodeURIComponent(m[1]);
      return this._sendJson(res, 200, this.state.services.filter((s) => s.deviceUri === `/devices/${dev}`));
    }

    m = /^\/smarthome\/devices\/([^/]+)\/services\/([^/]+)\/state$/.exec(url);
    if (m) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      const st = this.state.states[key];
      if (!st) return this._sendJson(res, 404, { error: `unknown service state ${key}` });
      if (req.method === 'GET') return this._sendJson(res, 200, st);
      if (req.method === 'PUT') {
        const body = await this._readBody(req);
        if (!body || typeof body !== 'object') return this._sendJson(res, 400, { error: 'bad body' });
        Object.assign(st, body);
        const [devId, sid] = key.split('/');
        this._broadcast(`com/bosch/sh/remote/devices/${devId}/services/${sid}/state`, Object.assign({}, st));
        return this._sendJson(res, 200);
      }
    }

    m = /^\/smarthome\/scenes\/([^/]+)\/state$/.exec(url);
    if (m && (req.method === 'PUT' || req.method === 'GET')) {
      const sid = decodeURIComponent(m[1]);
      const scene = this.state.scenes.find((s) => s.id === sid);
      if (!scene) return this._sendJson(res, 404, { error: 'unknown scene' });
      if (req.method === 'GET') return this._sendJson(res, 200, { '@type': 'activeSceneState', active: scene.active });
      const body = await this._readBody(req);
      scene.active = !!(body && body.active);
      this._broadcast(`com/bosch/sh/remote/scenes/${encodeURIComponent(sid)}`, { '@type': 'activeSceneState', active: scene.active });
      return this._sendJson(res, 200);
    }

    if (req.method === 'POST' && url === '/remote/json-rpc') {
      const msg = await this._readBody(req);
      return this._jsonrpc(msg, res);
    }

    this._sendJson(res, 404, { error: `mock: unhandled ${req.method} ${url}` });
  }

  _jsonrpc(msg, res) {
    if (!msg || !msg.method) return this._sendJson(res, 400);
    if (msg.method === 'RE/subscribe') {
      const subId = Math.floor(Math.random() * 1e9);
      this.subscribers.set(subId, []);
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: subId });
    }
    if (msg.method === 'RE/unsubscribe') {
      this.subscribers.delete(msg.params[0]);
      return this._sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: true });
    }
    if (msg.method === 'RE/longPoll') {
      const [subId, seconds] = msg.params;
      const queue = this.subscribers.get(subId);
      if (!queue) return this._sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: [] });
      const drain = () => {
        clearTimeout(timer);
        const idx = this.pendingPolls.indexOf(entry);
        if (idx >= 0) this.pendingPolls.splice(idx, 1);
        const out = queue.splice(0, queue.length).map((n) => { n.params[0] = subId; return n; });
        this._sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, result: out });
      };
      const entry = { drain };
      const timer = setTimeout(drain, Math.min((seconds || 30) * 1000, 40000));
      if (queue.length) { drain(); return; }
      this.pendingPolls.push(entry);
      return;
    }
    this._sendJson(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }

  // ---- test helpers -----------------------------------------------------------

  /** Directly change a fake state and notify subscribers (bypasses REST). */
  simulateState(deviceServiceKey, patch) {
    const st = this.state.states[deviceServiceKey];
    if (!st) throw new Error(`unknown key ${deviceServiceKey}`);
    Object.assign(st, patch);
    const [devId, sid] = deviceServiceKey.split('/');
    this._broadcast(`com/bosch/sh/remote/devices/${devId}/services/${sid}/state`, Object.assign({}, st));
  }
}

function createMockShc(opts) { return new MockShc(opts); }

module.exports = { createMockShc, MockShc, DEFAULTS };

// ---- CLI ---------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const getArg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const mock = new MockShc({
    pairPort: parseInt(getArg('--pair') || DEFAULTS.pairPort, 10),
    apiPort: parseInt(getArg('--api') || DEFAULTS.apiPort, 10),
    infoPort: parseInt(getArg('--info') || DEFAULTS.infoPort, 10),
    pin: getArg('--pin') || DEFAULTS.pin,
    tick: args.includes('--tick'),
  });
  mock.start().then(() => {
    console.log(`Mock SHC listening:`);
    console.log(`  pairing : https://127.0.0.1:${mock.opts.pairPort}  (PIN: ${mock.opts.pin})`);
    console.log(`  api     : https://127.0.0.1:${mock.opts.apiPort}  (mTLS)`);
    console.log(`  info    : https://127.0.0.1:${mock.opts.infoPort}`);
    console.log(`Devices: ${mock.state.devices.map((d) => d.id).join(', ')}`);
  }).catch((e) => { console.error('mock startup failed:', e.message); process.exit(1); });
}
