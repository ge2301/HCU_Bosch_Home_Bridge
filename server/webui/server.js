'use strict';
// WebUI HTTP server: static files + REST + Server-Sent-Events.
// Port is mapped 1:1 to the LAN by the HCU (Connect API docs 4.3), so the
// WEBLINK on the plugin config page can point straight at it.

const path = require('path');
const express = require('express');
const applog = require('../applog');

const SSE_TICK_MS = 15000;

class WebUiServer {
  /**
   * @param {object} ctx { pluginId, pkgVersion, hcu, registry, store, cache,
   *                       boschStatus(): object, boschActions?: {...} }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.app = express();
    this.app.use(express.json());
    this._sseClients = new Set();
    this._wireSseBroadcast();
    this._routes();
  }

  _statusPayload() {
    return {
      pluginId: this.ctx.pluginId,
      version: this.ctx.pkgVersion,
      uptimeSec: Math.round(process.uptime()),
      hcu: {
        host: this.ctx.hcu.host,
        connected: this.ctx.hcu.connected,
        readiness: this.ctx.hcu.readiness,
        hcuIp: this.ctx.hcuIp || '',
        lastConnectedAt: this.ctx.hcu.lastConnectedAt,
      },
      bosch: this.ctx.boschStatus ? this.ctx.boschStatus() : { paired: false, note: 'not implemented (M1)' },
      devices: this.ctx.registry ? this.ctx.registry.stats() : { known: 0, offered: 0, included: 0, parked: 0 },
      config: {
        boschHost: this.ctx.store.get('boschHost'),
        enableScenarios: this.ctx.store.get('enableScenarios'),
        enableIntrusion: this.ctx.store.get('enableIntrusion'),
        enableEnergyMeters: this.ctx.store.get('enableEnergyMeters'),
        motionImpulseSeconds: this.ctx.store.get('motionImpulseSeconds'),
      },
      webuiPort: process.env.WEBUI_PORT || 8341,
    };
  }

  _routes() {
    const api = express.Router();

    api.get('/status', (_req, res) => res.json(this._statusPayload()));

    api.get('/logs', (req, res) => {
      const sinceId = parseInt(req.query.since || '0', 10) || 0;
      res.json({ entries: applog.since(sinceId).slice(-200) });
    });

    api.get('/devices', (_req, res) => {
      const rows = this.ctx.registry ? this.ctx.registry.mappingRows() : [];
      res.json({ devices: rows });
    });

    // Enable/park one offered device (registry-level; resync handles rediscovery)
    api.patch('/devices', (req, res) => {
      const { id, enabled } = req.body || {};
      if (!id || typeof enabled !== 'boolean') return res.status(400).json({ error: 'id und enabled erforderlich' });
      if (!this.ctx.registry || !this.ctx.registry.devices.has(id)) return res.status(404).json({ error: 'unbekanntes Geraet' });
      this.ctx.registry.setDeviceEnabled(id, enabled);
      if (this.ctx.resync) this.ctx.resync();
      res.json({ ok: true });
    });

    // WebUI access PIN (optional gate for sensitive actions like disarm)
    api.post('/pin', (req, res) => {
      const { pin, enabled } = req.body || {};
      const patch = {};
      if (typeof enabled === 'boolean') patch.webuiPinEnabled = enabled;
      if (typeof pin === 'string' && pin.length >= 4) patch.webuiPin = pin;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'pin (mind. 4 Zeichen) oder enabled erforderlich' });
      this.ctx.store.setMany(patch);
      res.json({ ok: true });
    });

    // Settings read-back for the WebUI form
    api.get('/settings', (_req, res) => res.json({ settings: this.ctx.store.getAll() }));

    // Settings write-back from the WebUI (M4+ forms; store-level already works)
    api.patch('/settings', (req, res) => {
      const allowed = [
        'enableEnergyMeters', 'enableTwinguardPm', 'enableIlluminanceSensors',
        'enableScenarios', 'enableIntrusion', 'requirePinToDisarm',
        'keypadAsMomentarySwitch', 'webuiPinEnabled',
        'motionImpulseSeconds', 'logLevel',
      ];
      const patch = {};
      for (const k of allowed) {
        if (Object.prototype.hasOwnProperty.call(req.body || {}, k)) patch[k] = req.body[k];
      }
      this.ctx.store.setMany(patch);
      if (this.ctx.resync) this.ctx.resync();
      applog.info(`[webui] settings updated: ${Object.keys(patch).join(', ')}`);
      this._broadcast('settings', patch);
      res.json({ ok: true, applied: patch });
    });

    // Trigger a fresh HCU discovery cycle (new Bosch devices appeared)
    api.post('/rediscover', (_req, res) => {
      this.ctx.hcu.reconnect('webui');
      res.json({ ok: true });
    });

    // ---- Bosch SHC (M1) ----------------------------------------------------
    api.get('/bosch/status', (_req, res) => {
      res.json(this.ctx.bosch ? this.ctx.bosch.status() : { paired: false, note: 'bosch manager missing' });
    });

    api.get('/bosch/devices', (_req, res) => {
      res.json({ devices: this.ctx.bosch ? this.ctx.bosch.devices() : [] });
    });

    api.post('/bosch/pair', async (req, res) => {
      const { host, pin, name } = req.body || {};
      if (!host || !pin) return res.status(400).json({ error: 'host und pin erforderlich' });
      if (!this.ctx.bosch) return res.status(503).json({ error: 'bosch manager missing' });
      try {
        const status = await this.ctx.bosch.pair(host, pin, name);
        if (this.ctx.registry) this.ctx.registry.unparkPairedDevices();
        res.json({ ok: true, status });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });

    api.post('/bosch/unpair', async (_req, res) => {
      if (!this.ctx.bosch) return res.status(503).json({ error: 'bosch manager missing' });
      try {
        const status = await this.ctx.bosch.unpair();
        // No SHC access anymore -> park all HCU devices so they show as
        // "nicht erreichbar" instead of keeping stale live state.
        if (this.ctx.registry) this.ctx.registry.parkAll();
        res.json({ ok: true, status });
      }
      catch (err) { res.status(400).json({ error: err.message }); }
    });

    api.post('/bosch/refresh', async (_req, res) => {
      if (!this.ctx.bosch || !this.ctx.bosch.connected) return res.status(409).json({ error: 'nicht verbunden' });
      try { await this.ctx.bosch.refreshInventory(); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });

    // Direct service control (debug aid; the HCU control pipeline M3 uses the
    // same manager method).
    api.post('/bosch/control', async (req, res) => {
      const { deviceId, serviceId, state } = req.body || {};
      if (!deviceId || !serviceId || !state) return res.status(400).json({ error: 'deviceId, serviceId, state erforderlich' });
      if (!this.ctx.bosch || !this.ctx.bosch.connected) return res.status(409).json({ error: 'nicht verbunden' });
      try { await this.ctx.bosch.setServiceState(deviceId, serviceId, state); res.json({ ok: true }); }
      catch (err) { res.status(500).json({ error: err.message }); }
    });

    this.app.use('/api', api);

    // SSE stream: periodic heartbeat + event-driven pushes
    this.app.get('/api/events', (req, res) => {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.flushHeaders();
      const client = { res };
      this._sseClients.add(client);
      res.write(`event: status\ndata: ${JSON.stringify(this._statusPayload())}\n\n`);
      client.timer = setInterval(() => {
        res.write(`event: status\ndata: ${JSON.stringify(this._statusPayload())}\n\n`);
      }, SSE_TICK_MS);
      req.on('close', () => {
        clearInterval(client.timer);
        this._sseClients.delete(client);
      });
    });

    // Built React SPA (webui-src -> public). Deep links fall back to index.html.
    const publicDir = path.join(__dirname, 'public');
    this.app.use(express.static(publicDir));
    this.app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.includes('.')) return next();
      res.sendFile(path.join(publicDir, 'index.html'), (err) => { if (err) res.status(404).end('Not found'); });
    });
  }

  _wireSseBroadcast() {
    const emit = (event, data) => this._broadcast(event, data);
    if (this.ctx.registry) {
      this.ctx.registry.on('changed', () => emit('devices', this.ctx.registry.stats()));
    }
    this.ctx.hcu.on('connected', () => emit('hcu', { connected: true }));
    this.ctx.hcu.on('systemEvent', () => emit('hmip', { t: Date.now() }));
    if (this.ctx.bosch) {
      // Coalesce bursts of Bosch state changes into one UI refresh signal.
      let pending = null;
      const late = (payload) => {
        if (pending) return;
        pending = setTimeout(() => { pending = null; emit('bosch', payload); }, 1000);
        if (pending.unref) pending.unref();
      };
      this.ctx.bosch.on('stateChanged', (ev) => late({ deviceId: ev.deviceId }));
      this.ctx.bosch.on('inventory', () => late({ inventory: true }));
      this.ctx.bosch.on('connected', () => emit('bosch', { connected: true }));
    }
  }

  _broadcast(event, data) {
    for (const c of this._sseClients) {
      try { c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
    }
  }

  start(port, bindAddr) {
    return new Promise((resolve) => {
      const p = port || parseInt(process.env.WEBUI_PORT || '8341', 10);
      const addr = bindAddr || process.env.BIND_ADDR || '0.0.0.0';
      this.server = this.app.listen(p, addr, () => {
        applog.info(`[webui] listening on http://${addr}:${p}`);
        resolve({ port: p, addr });
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

module.exports = WebUiServer;
