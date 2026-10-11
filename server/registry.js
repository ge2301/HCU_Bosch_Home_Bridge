'use strict';
// Plugin device registry.
//
// Owns the set of plugin devices that are currently OFFERED to the HCU and
// tracks which of them are INCLUDED (twins). Implements the idempotency rules
// learned from the reference plugin:
//   * A device must only appear in DISCOVER_RESPONSE exactly once per HCU
//     lifetime cycle; re-offering included devices creates duplicates.
//   * "Removing" a device is done by parking it with maintenance.unreach=true,
//     never by silently dropping it.
//   * New devices discovered later require a WS reconnect so the HCU starts a
//     fresh READY -> DISCOVER_REQUEST cycle.
//
// Bosch source devices are registered by the bosch module via setSource().
// In M0 the source is empty, so the plugin offers nothing and simply reports
// state (which already exercises the whole HCU message flow).

const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const UNREACH_FEATURE = { type: 'maintenance', unreach: true };

class Registry extends EventEmitter {
  /**
   * @param {HcuClient} hcu
   * @param {Store} store
   * @param {HmipCache} cache
   */
  constructor(hcu, store, cache) {
    super();
    this.hcu = hcu;
    this.store = store;
    this.cache = cache;

    // boschId -> { boschId, hcuDeviceId (our offered id), deviceType, modelType,
    //              friendlyName, firmwareVersion, enabled, lastFeatures, included }
    this.devices = new Map();
    this._source = null; // () => sourceDeviceDescriptors[] provided by bosch module

    this._wireHcuEvents();
  }

  /** Provide live device sources from the Bosch side.
   *  Each descriptor: { id, deviceType, modelType, friendlyName, features } */
  setSource(fn) { this._source = fn; }

  _wireHcuEvents() {
    this.hcu.on('inclusionEvent', ({ deviceIds }) => {
      let changed = false;
      for (const id of deviceIds) {
        const dev = this._byHcuId(id);
        if (dev && !dev.included) { dev.included = true; changed = true; }
      }
      if (changed) this.emit('changed');
      // Docs 3.2: answer inclusion by (re)sending full states. A STATUS_RESPONSE
      // may be sent unsolicited, so a fresh uuid is fine here.
      this._pushAllStatus();
    });

    this.hcu.on('exclusionEvent', ({ deviceIds }) => {
      for (const id of deviceIds) {
        const dev = this._byHcuId(id);
        if (dev) {
          dev.included = false;
          this.store.clearTwin(dev.boschId);
          // HCU removed the device -> forget the offer marker so a later
          // resync/reconnect may legally offer it again (no duplicates, the
          // old twin is gone). No auto-reconnect here on purpose: the user
          // just deleted it and must not see it pop back instantly.
          this.store.clearOffered(dev.boschId);
        }
      }
      this.emit('changed');
    });

    // Twin resolution needs fresh system state after inclusion changes.
    this.hcu.on('connected', async () => {
      await this.hcu.requestSystemState();
      this._resolveTwins();
    });
    this.hcu.on('systemState', () => this._resolveTwins());
  }

  _byHcuId(hcuDeviceId) {
    for (const dev of this.devices.values()) {
      if (dev.hcuDeviceId === hcuDeviceId) return dev;
    }
    return null;
  }

  /** Rebuild this.devices from the Bosch source; offers not-yet-offered devices.
   *  Returns true if new devices appeared that require a re-discovery. */
  syncFromSource() {
    if (!this._source) return false;
    const sources = this._source() || [];
    let needsRediscovery = false;

    for (const src of sources) {
      let dev = this.devices.get(src.id);
      if (!dev) {
        dev = {
          boschId: src.id,
          hcuDeviceId: src.id, // our offered plugin device id == bosch id
          deviceType: src.deviceType,
          modelType: src.modelType,
          friendlyName: src.friendlyName,
          firmwareVersion: src.firmwareVersion || '1.0.0',
          enabled: src.enabled !== false,
          lastFeatures: src.features || [],
          included: false,
        };
        this.devices.set(dev.boschId, dev);
      } else {
        dev.deviceType = src.deviceType;
        dev.friendlyName = src.friendlyName || dev.friendlyName;
        if (Array.isArray(src.features)) dev.lastFeatures = src.features;
      }
      if (dev.enabled && !this.store.wasOffered(dev.boschId)) needsRediscovery = true;
    }
    this.emit('changed');
    return needsRediscovery;
  }

  /** Provider for DISCOVER_RESPONSE: only devices never offered before. */
  getDevicesForDiscover() {
    const out = [];
    for (const dev of this.devices.values()) {
      if (!dev.enabled) continue;
      if (this.store.wasOffered(dev.boschId)) continue; // already registered once
      out.push(this._descriptor(dev));
      this.store.markOffered(dev.boschId);
    }
    return out;
  }

  /** Provider for STATUS_RESPONSE (full status of requested/all devices). */
  getDevicesForStatus(deviceIds) {
    const out = [];
    for (const dev of this.devices.values()) {
      if (deviceIds && !deviceIds.includes(dev.hcuDeviceId)) continue;
      out.push(this._descriptor(dev, true));
    }
    return out;
  }

  _descriptor(dev, withState) {
    return {
      deviceId: dev.hcuDeviceId,
      deviceType: dev.deviceType,
      modelType: dev.modelType,
      firmwareVersion: dev.firmwareVersion,
      friendlyName: dev.friendlyName,
      features: withState ? this._featuresWithMaintenance(dev) : dev.lastFeatures,
    };
  }

  _featuresWithMaintenance(dev) {
    const feats = (dev.lastFeatures || []).slice();
    if (!dev.enabled || dev.unreachable) {
      if (!feats.some((f) => f.type === 'maintenance')) feats.push({ ...UNREACH_FEATURE });
    }
    return feats;
  }

  /** Push a STATUS_EVENT for one device (called by bosch state pipeline). */
  pushDeviceStatus(boschId, features) {
    const dev = this.devices.get(boschId);
    if (!dev) return;
    dev.lastFeatures = features;
    if (!dev.included) return;
    this.hcu.sendRaw({
      id: uuidv4(),
      pluginId: this.hcu.pluginId,
      type: 'STATUS_EVENT',
      body: { deviceId: dev.hcuDeviceId, features: this._featuresWithMaintenance(dev) },
    });
  }

  /** Park/unpark a device: park = maintenance.unreach=true so it shows
   *  "not reachable" instead of creating duplicates on re-enable. */
  setDeviceEnabled(boschId, enabled) {
    const dev = this.devices.get(boschId);
    if (!dev) return;
    dev.enabled = enabled;
    if (dev.included) this.pushDeviceStatus(boschId, dev.lastFeatures);
    this.emit('changed');
  }

  /** Park every known device (used when the Bosch pairing is removed). */
  parkAll() {
    let any = false;
    for (const dev of this.devices.values()) {
      if (dev.enabled) { dev.enabled = false; dev.parkedByUnpair = true; any = true; }
    }
    if (any) this._pushAllStatus();
    this.emit('changed');
  }

  /** Undo parkAll() after a successful re-pair (manual parks are kept). */
  unparkPairedDevices() {
    let any = false;
    for (const dev of this.devices.values()) {
      if (dev.parkedByUnpair) { dev.enabled = true; delete dev.parkedByUnpair; any = true; }
    }
    if (any) this._pushAllStatus();
    this.emit('changed');
  }

  setDeviceUnreachable(boschId, unreachable) {
    const dev = this.devices.get(boschId);
    if (!dev) return;
    dev.unreachable = unreachable;
    if (dev.included) this.pushDeviceStatus(boschId, dev.lastFeatures);
  }

  _pushAllStatus() {
    const devices = [];
    for (const dev of this.devices.values()) {
      if (dev.included) devices.push(this._descriptor(dev, true));
    }
    if (!devices.length) return;
    this.hcu.sendRaw({
      id: uuidv4(),
      pluginId: this.hcu.pluginId,
      type: 'STATUS_RESPONSE',
      body: { success: true, devices },
    });
  }

  _sendStatusResponse(_ignored, deviceIds) {
    // Placeholder: status is pushed via _pushAllStatus after twin resolution.
    void _ignored; void deviceIds;
  }

  /** Map included twins (HCU uuids) to our offered ids via the HMIP cache. */
  _resolveTwins() {
    const twins = this.cache.findPluginTwins();
    for (const t of twins) {
      const key = t.pluginDeviceId || t.id;
      const dev = this.devices.get(key);
      if (dev) {
        dev.included = true;
        if (this.store.getTwin(dev.boschId) !== t.id) this.store.setTwin(dev.boschId, t.id);
      }
    }
    this.emit('changed');
  }

  /** Summary for status pages / config page. */
  stats() {
    let included = 0, parked = 0, offered = 0;
    for (const dev of this.devices.values()) {
      if (this.store.wasOffered(dev.boschId)) offered++;
      if (dev.included) included++;
      if (!dev.enabled) parked++;
    }
    return { known: this.devices.size, offered, included, parked };
  }

  /** All device rows for the HCUweb config page mapping list. */
  mappingRows() {
    const rows = [];
    for (const dev of this.devices.values()) {
      const twin = this.store.getTwin(dev.boschId);
      let room = '';
      if (twin) room = this.cache.roomNameForDevice(twin);
      rows.push({
        boschId: dev.boschId,
        name: dev.friendlyName,
        deviceType: dev.deviceType,
        enabled: dev.enabled,
        included: dev.included,
        hcuUuid: twin || '',
        room,
        features: dev.lastFeatures || [],
      });
    }
    return rows;
  }
}

module.exports = Registry;
