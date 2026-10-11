'use strict';
// BoschManager: owns the SHC connection lifecycle.
//
//   - persists pairing material under <DATA_DIR>/bosch/
//   - connect -> public info -> inventory (devices + services) -> initial states
//   - long-poll events keep the state cache fresh
//   - exposes status()/devices() for the WebUI and setServiceState() for the
//     control pipeline (M3) / onChange for the device registry (M2)
//
// A retry timer keeps trying every 60 s while pairing exists but the SHC is
// unreachable (typical: SHC reboots, DHCP changes).

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const ShcClient = require('./shc-client');
const pairing = require('./pairing');
const { getDataPath } = require('../data-dir');
const applog = require('../applog');

const BOSCH_DIR = 'bosch';
const RETRY_MS = 60000;

class BoschManager extends EventEmitter {
  /**
   * @param {object} ctx { store, ports? } ports = mock overrides { apiPort, infoPort, pairPort }
   */
  constructor(ctx) {
    super();
    this.ctx = ctx;
    this.store = ctx.store;
    this.ports = ctx.ports || {};
    this.client = null;
    this.info = null;
    this.inventory = [];           // [{ id, room, deviceType..., services:[...] }]
    this.states = new Map();       // deviceId -> { serviceId -> state }
    this.scenes = [];              // [{ id, name, active }]
    this.intrusion = null;         // safeState document or null
    this.nameMap = new Map();      // deviceId -> { name, room }
    this.lastInventoryAt = null;
    this.lastError = null;
    this.connected = false;
    this._retryTimer = null;
    this._connecting = false;
  }

  _dir() { return getDataPath(BOSCH_DIR); }
  _materialAvailable() {
    return fs.existsSync(path.join(this._dir(), 'client.crt')) &&
      fs.existsSync(path.join(this._dir(), 'client.key')) &&
      fs.existsSync(path.join(this._dir(), 'meta.json'));
  }

  isPaired() {
    return !!(this.store.get('boschPaired') && this._materialAvailable() && this.store.get('boschHost'));
  }

  status() {
    return {
      paired: this.isPaired(),
      host: this.store.get('boschHost') || '',
      connected: this.connected,
      eventsActive: !!(this.client && this.client.eventsActive),
      clientId: this._meta().clientId || '',
      model: this.info ? (this.info.deviceName || this.info.model || 'SHC') : '',
      serial: this.info ? (this.info.serial || this.info.deviceId || '') : '',
      firmware: this.info ? (this.info.firmwareVersion || '') : '',
      deviceCount: this.inventory.length,
      lastInventoryAt: this.lastInventoryAt,
      lastError: this.lastError,
    };
  }

  _meta() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._dir(), 'meta.json'), 'utf8'));
    } catch { return {}; }
  }

  // ---- pairing ----------------------------------------------------------------

  /** Pair with the SHC. The physical button must have been pressed before. */
  async pair(host, pin, name) {
    applog.info(`[bosch] pairing with ${host} ...`);
    const material = await pairing.pair({
      host,
      pin,
      name: name || 'HCU Bosch Bridge',
      port: this.ports.pairPort,
    });
    fs.mkdirSync(this._dir(), { recursive: true });
    fs.writeFileSync(path.join(this._dir(), 'client.crt'), material.cert);
    fs.writeFileSync(path.join(this._dir(), 'client.key'), material.key);
    fs.writeFileSync(path.join(this._dir(), 'meta.json'), JSON.stringify({
      clientId: material.clientId,
      clientKey: material.clientKey,
      pairedAt: new Date().toISOString(),
    }, null, 2));
    this.store.setMany({ boschHost: host, boschPaired: true });
    applog.info(`[bosch] paired with ${host} as ${material.clientId}`);
    await this.disconnect();
    await this.connect().catch((e) => applog.warn('[bosch] connect after pairing failed:', e.message));
    return this.status();
  }

  async unpair() {
    const meta = this._meta();
    const host = this.store.get('boschHost');
    if (meta.clientId && meta.clientKey && host) {
      try {
        await pairing.unpair({ host, port: this.ports.pairPort, clientId: meta.clientId, clientKey: meta.clientKey });
        applog.info('[bosch] client removed from SHC');
      } catch (err) {
        applog.warn('[bosch] unpair on SHC failed (removing local material anyway):', err.message);
      }
    }
    await this.disconnect();
    for (const f of ['client.crt', 'client.key', 'meta.json']) {
      try { fs.unlinkSync(path.join(this._dir(), f)); } catch { /* ignore */ }
    }
    this.store.setMany({ boschPaired: false });
    return this.status();
  }

  // ---- connection lifecycle ----------------------------------------------------

  async connect() {
    if (this._connecting) return;
    if (!this.isPaired()) throw new Error('nicht gepairt');
    this._connecting = true;
    try {
      const cert = fs.readFileSync(path.join(this._dir(), 'client.crt'), 'utf8');
      const key = fs.readFileSync(path.join(this._dir(), 'client.key'), 'utf8');
      const meta = this._meta();
      const client = new ShcClient({
        host: this.store.get('boschHost'),
        cert, key,
        clientId: meta.clientId,
        apiPort: this.ports.apiPort,
        infoPort: this.ports.infoPort,
      });
      this.info = await client.getPublicInfo();
      client.on('stateChanged', (ev) => this._onStateChanged(ev));
      client.on('eventError', (e) => { this.lastError = e.message; this.emit('error', e); });
      await client.startEvents();
      this.client = client;
      this.connected = true;
      this.lastError = null;
      applog.info(`[bosch] connected to SHC ${this.info.deviceName || this.store.get('boschHost')} (${this.info.firmwareVersion || '?'})`);
      await this.refreshInventory();      this.emit('connected');
      this._clearRetry();
    } catch (err) {
      this.lastError = err.message;
      this.connected = false;
      applog.warn(`[bosch] connect failed: ${err.message}`);
      this._scheduleRetry();
      throw err;
    } finally {
      this._connecting = false;
    }
  }

  async disconnect() {
    this._clearRetry();
    this.connected = false;
    if (this.client) {
      this.client.stopEvents();
      this.client = null;
    }
  }

  /** Startup helper: connect if paired, otherwise idle (WebUI drives pairing). */
  async start() {
    if (!this.isPaired()) {
      applog.info('[bosch] not paired - open the WebUI to pair with the SHC');
      return;
    }
    try { await this.connect(); } catch { /* retry timer armed */ }
  }

  _scheduleRetry() {
    if (this._retryTimer) return;
    this._retryTimer = setTimeout(async () => {
      this._retryTimer = null;
      if (this.isPaired() && !this.connected) {
        applog.info('[bosch] retrying connection ...');
        await this.connect().catch(() => { /* rescheduled inside connect */ });
      }
    }, RETRY_MS);
    if (this._retryTimer.unref) this._retryTimer.unref();
  }

  _clearRetry() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
  }

  // ---- inventory + states --------------------------------------------------------

  async refreshInventory() {
    if (!this.client) throw new Error('not connected');
    const devices = await this.client.getDevices();
    // Bulk services endpoint lists every service with its deviceUri.
    let services = [];
    try {
      services = await this.client.get('/smarthome/services');
      if (!Array.isArray(services)) services = [];
    } catch {
      for (const d of devices) {
        try {
          const list = await this.client.getServices(d.id);
          services.push(...list.map((s) => Object.assign({ deviceUri: `/devices/${d.id}` }, s)));
        } catch { /* keep going */ }
      }
    }
    const byDevice = new Map();
    for (const s of services) {
      const m = /\/devices\/([^/]+)$/.exec(s.deviceUri || '');
      if (!m) continue;
      if (!byDevice.has(m[1])) byDevice.set(m[1], []);
      byDevice.get(m[1]).push(s);
    }
    this.inventory = devices.map((d) => Object.assign({}, d, { services: byDevice.get(d.id) || [] }));
    // Bosch does not put names in /devices - they live in the location tree.
    try {
      const locations = await this.client.get('/smarthome/locations');
      this._collectNames(Array.isArray(locations) ? locations : [], '', null);
    } catch (err) {
      applog.warn('[bosch] locations unavailable:', err.message);
    }
    for (const d of this.inventory) {
      const n = this.nameMap.get(d.id);
      if (n) { d.name = n.name; d.roomName = n.room; }
    }
    // Scenes (virtual switch devices in the mapping layer).
    try {
      const scenes = await this.client.get('/smarthome/scenes');
      this.scenes = Array.isArray(scenes) ? scenes : [];
    } catch (err) {
      this.scenes = [];
      applog.warn('[bosch] scenes unavailable:', err.message);
    }
    // Initial state readout for every service that looks like a state holder.
    this.states.clear();
    for (const d of this.inventory) {
      const st = {};
      for (const s of d.services) {
        for (const def of (s.definedServices || [])) {
          try {
            const state = await this.client.getServiceState(d.id, def.id || s.id);
            if (state && typeof state === 'object') st[def.id || s.id] = state;
          } catch { /* some services (diagnostics...) may reject; ignore */ }
        }
      }
      this.states.set(d.id, st);
    }
    this.lastInventoryAt = new Date().toISOString();
    applog.info(`[bosch] inventory: ${this.inventory.length} devices, ${services.length} services, ${this.scenes.length} scenes`);
    this._extractIntrusion();
    this.emit('inventory', this.inventory);
    return this.inventory;
  }

  /** Recursively walk the Bosch location tree collecting device names/rooms. */
  _collectNames(nodes, roomName, self) {
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const m = /^\/devices\/(.+)$/.exec(node.deviceUri || '');
      if (m) {
        this.nameMap.set(decodeURIComponent(m[1]), { name: node.name || m[1], room: roomName || '' });
        continue;
      }
      const name = node.name || '';
      if (Array.isArray(node.children)) this._collectNames(node.children, name, node);
    }
    void self;
  }

  /** The alarm system state is the 'safe' service state of the HSG device. */
  _extractIntrusion() {
    this.intrusion = null;
    for (const [deviceId, st] of this.states.entries()) {
      if (st.safe && st.safe['@type'] === 'safeState') {
        this.intrusion = Object.assign({ deviceId }, st.safe);
        return;
      }
    }
  }

  deviceStates(deviceId) {
    return this.states.get(deviceId) || {};
  }

  _onStateChanged({ deviceId, state }) {
    if (!this.states.has(deviceId)) this.states.set(deviceId, {});
    const key = state && state['@type'] ? state['@type'].replace(/State$/, '') : 'unknown';
    this.states.get(deviceId)[key] = state;
    if (key === 'safe' && state && state['@type'] === 'safeState') {
      this.intrusion = Object.assign({ deviceId }, state);
    }
    this.emit('stateChanged', { deviceId, state });
  }

  // ---- actions for virtual devices (mapper resolveControl) ----------------------

  async runAction(action) {
    if (!this.client) throw new Error('not connected');
    if (action.name === 'scene') {
      // Mock + docs: PUT scene state active=true triggers it. Real SHC may use
      // POST /smarthome/scenes/{id}/triggers instead (field test M5/M6).
      return this.client.put(`/smarthome/scenes/${encodeURIComponent(action.args.sceneId)}/state`,
        { '@type': 'activeSceneState', active: true });
    }
    if (action.name === 'intrusion') {
      if (!this.intrusion || !this.intrusion.deviceId) throw new Error('keine Alarmanlage gefunden');
      // Mock models arm/disarm as safeState writes; real SHC exposes
      // /smarthome/intrusion/commands/{arm,disarm} (field test M5/M6).
      return this.client.setServiceState(this.intrusion.deviceId, 'safe', {
        '@type': 'safeState',
        overallState: action.args.armed ? 'INTRUSION_ARMED' : 'IDLE',
      });
    }
    throw new Error(`unknown action ${action.name}`);
  }

  // ---- control (used by M3 control pipeline) --------------------------------------

  async setServiceState(deviceId, serviceId, body) {
    if (!this.client) throw new Error('not connected');
    return this.client.setServiceState(deviceId, serviceId, body);
  }

  /** Full device list including latest known states (WebUI + M2 catalog input). */
  devices() {
    return this.inventory.map((d) => ({
      id: d.id,
      name: d.name || d.roomHint || d.id,
      room: d.roomName || d.roomId || d.roomHint || '',
      deviceType: d.deviceType || (d.services[0] && d.services[0].deviceType) || '',
      services: d.services.map((s) => ({
        id: s.id,
        deviceType: s.deviceType,
        definedServices: (s.definedServices || []).map((x) => x.id),
      })),
      states: this.deviceStates(d.id),
    }));
  }
}

module.exports = BoschManager;
