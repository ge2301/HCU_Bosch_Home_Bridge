'use strict';
// Generic Homematic IP Connect API WebSocket client.
// Based on the official example (connect-api-main/examples/node) and the
// proven implementation of the ReAct-Fluid-WebUI reference plugin, generalized
// for reuse: readiness management, provider callbacks and a pending-request
// map for all request/response flows of Connect API 1.0.1.

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

class HcuClient extends EventEmitter {
  /**
   * @param {string} pluginId  reverse-dns plugin identifier
   * @param {string} host      'host.containers.internal' (installed) or 'hcu1-xxxx.local' (remote dev)
   * @param {string} authtoken content of /TOKEN (installed) or dev token file
   */
  constructor(pluginId, host, authtoken) {
    super();
    this.pluginId = pluginId;
    this.host = host;
    this.authtoken = (authtoken || '').trim();
    this.ws = null;
    this.reconnectDelayMs = 3000;
    this.requestTimeoutMs = 15000;
    this.connected = false;
    this.lastConnectedAt = null;
    this._readiness = 'READY';
    this._pendingRequests = new Map();

    // Provider / handler hooks (set by registry, config-page, control modules)
    this._discoverProvider = null;     // () => Device[]
    this._statusProvider = null;       // (deviceIds|null) => Device[]
    this._controlHandler = null;       // (requestId, body) => void
    this._configTemplateProvider = null; // () => { groups, properties }
    this._configUpdateHandler = null;  // (requestId, body) => void
  }

  setDiscoverDevicesProvider(fn) { this._discoverProvider = fn; }
  setStatusDevicesProvider(fn) { this._statusProvider = fn; }
  setControlRequestHandler(fn) { this._controlHandler = fn; }
  setConfigTemplateProvider(fn) { this._configTemplateProvider = fn; }
  setConfigUpdateHandler(fn) { this._configUpdateHandler = fn; }

  get readiness() { return this._readiness; }

  /** Change PLUGIN_STATE_RESPONSE readiness and report it immediately. */
  setReadiness(status) {
    this._readiness = status;
    if (this.connected) this._sendPluginReady(uuidv4());
  }

  connect() {
    // host may be a plain hostname (installed/remote dev -> wss://host:9001)
    // or a full URL (test harness with a local ws:// mock server).
    const url = /:\/\//.test(this.host) ? this.host : `wss://${this.host}:9001`;
    console.log(`[hcu] Connecting to ${url} ...`);

    this.ws = new WebSocket(url, {
      rejectUnauthorized: false, // HCU uses a self-signed certificate
      headers: {
        authtoken: this.authtoken,
        'plugin-id': this.pluginId,
        'hmip-system-events': 'true',
      },
    });

    this.ws.on('open', () => {
      console.log('[hcu] WebSocket connected');
      this.connected = true;
      this.lastConnectedAt = new Date().toISOString();
      this._sendPluginReady(uuidv4());
      this.emit('connected');
    });

    this.ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        console.error('[hcu] Cannot parse message:', err.message);
        return;
      }
      try {
        this._handleMessage(msg);
      } catch (err) {
        console.error(`[hcu] Error handling ${msg.type}:`, err);
      }
    });

    this.ws.on('error', (err) => {
      // Typical case: HCU unreachable (ENOTFOUND/ECONNREFUSED). Reconnect follows on close.
      console.error('[hcu] WebSocket error:', err.code || '', err.message || '');
    });

    this.ws.on('close', (code, reason) => {
      this.connected = false;
      const r = reason && reason.length ? ` (${reason})` : '';
      console.log(`[hcu] WebSocket closed (${code})${r}. Reconnect in ${this.reconnectDelayMs}ms`);
      setTimeout(() => this.connect(), this.reconnectDelayMs);
    });
  }

  /** Deliberately cycle the connection: forces the HCU to run
   *  READY -> DISCOVER_REQUEST again (only the HCU can start discovery). */
  reconnect(reason) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    console.log(`[hcu] Reconnect requested${reason ? ` (${reason})` : ''}`);
    this.ws.close(1000, 're-discover');
  }

  _handleMessage(msg) {
    const { type, id, body } = msg;

    switch (type) {
      case 'PLUGIN_STATE_REQUEST':
        this._sendPluginReady(id);
        break;

      case 'DISCOVER_REQUEST': {
        const devices = this._discoverProvider ? this._discoverProvider() : [];
        console.log(`[hcu] DISCOVER_REQUEST -> offering ${devices.length} device(s)`);
        this._send({
          id,
          pluginId: this.pluginId,
          type: 'DISCOVER_RESPONSE',
          body: { success: true, devices },
        });
        break;
      }

      case 'INCLUSION_EVENT': {
        const deviceIds = Array.isArray(body && body.deviceIds) ? body.deviceIds : [];
        console.log(`[hcu] INCLUSION_EVENT: ${deviceIds.length} device(s)`);
        this.emit('inclusionEvent', { id, deviceIds });
        break;
      }

      case 'EXCLUSION_EVENT': {
        const deviceIds = Array.isArray(body && body.deviceIds) ? body.deviceIds : [];
        console.log(`[hcu] EXCLUSION_EVENT: ${deviceIds.length} device(s)`);
        this.emit('exclusionEvent', { id, deviceIds });
        break;
      }

      case 'STATUS_REQUEST': {
        const deviceIds = Array.isArray(body && body.deviceIds) ? body.deviceIds : null;
        const devices = this._statusProvider ? this._statusProvider(deviceIds) : [];
        this._send({
          id,
          pluginId: this.pluginId,
          type: 'STATUS_RESPONSE',
          body: { success: true, devices },
        });
        break;
      }

      case 'CONTROL_REQUEST':
        this.emit('controlRequest', { id, body });
        if (this._controlHandler) this._controlHandler(id, body);
        break;

      case 'CONFIG_TEMPLATE_REQUEST': {
        const templateBody = this._configTemplateProvider
          ? this._configTemplateProvider()
          : { properties: {} };
        this._send({
          id,
          pluginId: this.pluginId,
          type: 'CONFIG_TEMPLATE_RESPONSE',
          body: templateBody,
        });
        break;
      }

      case 'CONFIG_UPDATE_REQUEST':
        this.emit('configUpdateRequest', { id, body });
        if (this._configUpdateHandler) this._configUpdateHandler(id, body);
        break;

      case 'HMIP_SYSTEM_RESPONSE': {
        const pending = this._pendingRequests.get(id);
        if (pending) {
          this._pendingRequests.delete(id);
          pending.resolve(body);
        }
        this.emit('systemResponse', { id, body });
        break;
      }

      case 'SYSTEM_INFO_RESPONSE': {
        const pending = this._pendingRequests.get(id);
        if (pending) {
          this._pendingRequests.delete(id);
          pending.resolve(body);
        }
        this.emit('systemInfoResponse', { id, body });
        break;
      }

      case 'HMIP_SYSTEM_EVENT':
        this.emit('systemEvent', body);
        break;

      case 'USER_MESSAGE_ACKNOWLEDGEMENT_EVENT':
        this.emit('userMessageAck', body);
        break;

      case 'ERROR_RESPONSE':
        console.error(`[hcu] ERROR_RESPONSE code=${body && body.error && body.error.code} ` +
          `msg=${body && body.error && body.error.message} ` +
          `orig=${body && body.originalMessage && body.originalMessage.type}`);
        this.emit('errorResponse', { id, body });
        break;

      default:
        console.log(`[hcu] Unhandled message type: ${type}`);
    }
  }

  _sendPluginReady(messageId) {
    this._send({
      id: messageId,
      pluginId: this.pluginId,
      type: 'PLUGIN_STATE_RESPONSE',
      body: { pluginReadinessStatus: this._readiness },
    });
    console.log(`[hcu] PLUGIN_STATE_RESPONSE (${this._readiness}) sent`);
  }

  /** Generic HMIP_SYSTEM_REQUEST with promise resolution via matching id.
   *  Resolves with the response body envelope: { code, body } . */
  sendSystemRequest(path, requestBody) {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error(`HMIP_SYSTEM_REQUEST ${path} timed out`));
      }, this.requestTimeoutMs);
      this._pendingRequests.set(id, {
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({
        id,
        pluginId: this.pluginId,
        type: 'HMIP_SYSTEM_REQUEST',
        body: { path, body: requestBody || {} },
      });
    });
  }

  /** Fetch /hmip/home/getSystemState and emit it as 'systemState'. */
  async requestSystemState() {
    try {
      const envelope = await this.sendSystemRequest('/hmip/home/getSystemState', {});
      if (envelope && envelope.code === 200 && envelope.body) {
        this.emit('systemState', envelope.body);
        return envelope.body;
      }
      console.error('[hcu] getSystemState failed, code=', envelope && envelope.code,
        envelope && envelope.body && envelope.body.errorCode);
      return null;
    } catch (err) {
      console.error('[hcu] getSystemState error:', err.message);
      return null;
    }
  }

  /** SYSTEM_INFO_REQUEST -> { ipAddress, isOnlineMode, success } */
  requestSystemInfo() {
    return new Promise((resolve, reject) => {
      const id = uuidv4();
      const timer = setTimeout(() => {
        this._pendingRequests.delete(id);
        reject(new Error('SYSTEM_INFO_REQUEST timed out'));
      }, this.requestTimeoutMs);
      this._pendingRequests.set(id, {
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ id, pluginId: this.pluginId, type: 'SYSTEM_INFO_REQUEST', body: {} });
    });
  }

  /** Convenience: control a HMIP device/group (documented paths only). */
  sendDeviceControl(path, controlBody) {
    return this.sendSystemRequest(path, controlBody);
  }

  sendRaw(msg) { this._send(msg); }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

module.exports = HcuClient;
