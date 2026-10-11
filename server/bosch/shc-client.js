'use strict';
// Bosch Smart Home Controller (SHC) local REST client.
//
// Protocol (official BoschSmartHome/bosch-shc-api-docs):
//   - All device/service endpoints live on https://<shc>:8444/smarthome/...
//     and require a TLS CLIENT certificate (mTLS); the SHC certificate itself
//     is self-signed -> rejectUnauthorized=false.
//   - Unauthenticated public info on https://<shc>:8446/smarthome/public/information.
//   - Change events use JSON-RPC long-polling on https://<shc>:8444/remote/json-rpc:
//       POST {method:'RE/subscribe', params:['com/bosch/sh/remote/*', null]}  -> subscriptionId
//       POST {method:'RE/longPoll',  params:[subscriptionId, seconds]}        -> [notifications]
//
// This client is transport-only; device semantics live in ../bosch (manager)
// and the mapping catalog (M2).

const https = require('https');
const EventEmitter = require('events');

const API_PORT = 8444;
const INFO_PORT = 8446;
const JSONRPC_PATH = '/remote/json-rpc';

class ShcClient extends EventEmitter {
  /**
   * @param {object} opts { host, cert, key, clientId, apiPort?, infoPort? }
   *   cert/key: PEM strings (client certificate from pairing)
   */
  constructor(opts) {
    super();
    this.host = opts.host;
    this.cert = opts.cert || null;
    this.key = opts.key || null;
    this.clientId = opts.clientId || null;
    this.apiPort = opts.apiPort || API_PORT;
    this.infoPort = opts.infoPort || INFO_PORT;
    this.eventsActive = false;
    this._subscriptionId = null;
    this._longPollAbort = null;
    this._rpcId = 0;
    this.lastError = null;
    this.connectedAt = null;
    this._reqs = new Set();
  }

  get configured() {
    return !!(this.host && this.cert && this.key);
  }

  // ---- low-level transport --------------------------------------------------

  _request({ port, method, path, body, timeoutMs = 10000, withCert = true }) {
    return new Promise((resolve, reject) => {
      const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
      const headers = { Accept: 'application/json' };
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const options = {
        host: this.host,
        port,
        method,
        path,
        rejectUnauthorized: false, // SHC uses a self-signed certificate
        timeout: timeoutMs,
        headers,
      };
      if (withCert && this.cert && this.key) {
        options.cert = this.cert;
        options.key = this.key;
      }
      const req = https.request(options, (res) => {
        this._reqs.delete(req);        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed = null;
          if (data.length) {
            try { parsed = JSON.parse(data); } catch { parsed = data; }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else {
            const err = new Error(`HTTP ${res.statusCode} on ${method} ${path}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            reject(err);
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error(`timeout on ${method} ${path}`)));
      req.on('error', (e) => { this._reqs.delete(req); reject(e); });
      this._reqs.add(req);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path) { return this._request({ port: this.apiPort, method: 'GET', path }); }
  put(path, body) { return this._request({ port: this.apiPort, method: 'PUT', path, body }); }

  /** Unauthenticated controller info (model, serial, firmware, IP settings). */
  async getPublicInfo() {
    return this._request({ port: this.infoPort, method: 'GET', path: '/smarthome/public/information', withCert: false });
  }

  // ---- inventory ------------------------------------------------------------

  async getDevices() {
    const list = await this.get('/smarthome/devices');
    return Array.isArray(list) ? list : [];
  }

  async getServices(deviceId) {
    const list = await this.get(`/smarthome/devices/${encodeURIComponent(deviceId)}/services`);
    return Array.isArray(list) ? list : [];
  }

  /** All devices with their services: [{ id, device, services:[{id, definedServices...}] }] */
  async getInventory() {
    const devices = await this.getDevices();
    const out = [];
    for (const d of devices) {
      try {
        d._services = await this.getServices(d.id);
      } catch (err) {
        d._services = [];
        d._servicesError = err.message;
      }
      out.push(d);
    }
    return out;
  }

  async getServiceState(deviceId, serviceId) {
    return this.get(`/smarthome/devices/${encodeURIComponent(deviceId)}/services/${encodeURIComponent(serviceId)}/state`);
  }

  /** body is the state document, e.g. { '@type':'powerSwitchState', switchState:'ON' } */
  async setServiceState(deviceId, serviceId, body) {
    return this.put(`/smarthome/devices/${encodeURIComponent(deviceId)}/services/${encodeURIComponent(serviceId)}/state`, body);
  }

  // ---- event long-polling -----------------------------------------------------

  _rpc(method, params, timeoutMs) {
    const id = ++this._rpcId;
    return this._request({
      port: this.apiPort,
      method: 'POST',
      path: JSONRPC_PATH,
      body: { jsonrpc: '2.0', id, method, params },
      timeoutMs,
    });
  }

  /** Start the event loop. Resolves once the subscription is active. */
  async startEvents() {
    if (this.eventsActive) return;
    const res = await this._rpc('RE/subscribe', ['com/bosch/sh/remote/*', null]);
    if (res && res.error) throw new Error(`RE/subscribe failed: ${JSON.stringify(res.error)}`);
    this._subscriptionId = res.result;
    this.eventsActive = true;
    this.emit('eventsStarted', this._subscriptionId);
    this._pollLoop();
  }

  stopEvents() {
    this.eventsActive = false;
    this._subscriptionId = null;
    // Abort the in-flight long-poll so the loop exits immediately.
    for (const q of this._reqs) { try { q.destroy(new Error('events stopped')); } catch { /* ignore */ } }
    this._reqs.clear();
  }

  async _pollLoop() {
    while (this.eventsActive) {
      try {
        // Long-poll max 30 s; we add client-side slack on the socket timeout.
        const res = await this._rpc('RE/longPoll', [this._subscriptionId, 30], 45000);
        if (!this.eventsActive) break;
        if (res && res.error) throw new Error(`RE/longPoll error: ${JSON.stringify(res.error)}`);
        const notifications = (res && Array.isArray(res.result)) ? res.result : [];
        for (const n of notifications) this._dispatch(n);
        this.lastError = null;
      } catch (err) {
        if (!this.eventsActive) break;
        this.lastError = err.message;
        this.emit('eventError', err);
        // Backoff, then try to re-subscribe (session may be gone after SHC restart).
        await new Promise((r) => setTimeout(r, 5000));
        if (!this.eventsActive) break;
        try {
          const res = await this._rpc('RE/subscribe', ['com/bosch/sh/remote/*', null]);
          if (res && res.result !== undefined) this._subscriptionId = res.result;
        } catch (err2) {
          this.emit('eventError', err2);
        }
      }
    }
  }

  _dispatch(n) {
    // JSON-RPC notification: { jsonrpc, method:'RE/notify', params:[subId, {source, data}] }
    const p = n && n.params;
    if (!Array.isArray(p) || p.length < 2) return;
    const payload = p[1] || {};
    const source = payload.source || '';
    const data = payload.data || null;
    // source looks like 'com/bosch/sh/remote/devices/<deviceId>/...'
    const m = /devices\/([^/]+)/.exec(source);
    const deviceId = m ? m[1] : null;
    this.emit('notify', { source, deviceId, data });
    if (deviceId && data && data['@type']) {
      this.emit('stateChanged', { deviceId, source, state: data });
    }
  }
}

module.exports = ShcClient;
