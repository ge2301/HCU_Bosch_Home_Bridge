'use strict';
// HMIP system state cache.
// Filled with /hmip/home/getSystemState on connect and kept up to date by
// merging HMIP_SYSTEM_EVENT partial updates (docs 3.3: do NOT poll).
//
// Also resolves plugin-device "twins": after inclusion the HCU mirrors each
// plugin device into the home as a device with type 'PLUGIN_EXTERNAL', its own
// HCU uuid and our plugin id + pluginDeviceId pointing back to us.

const EventEmitter = require('events');

class HmipCache extends EventEmitter {
  constructor(pluginId) {
    super();
    this.pluginId = pluginId;
    this.raw = null; // { home, groups, devices, clients, ... }
  }

  initialize(systemStateBody) {
    this.raw = systemStateBody;
    this.emit('initialized', this);
  }

  /** Merge a HMIP_SYSTEM_EVENT body (docs 6.4.9). */
  applyEvent(eventBody) {
    if (!this.raw || !eventBody) return;
    const events = eventBody.eventTransaction && eventBody.eventTransaction.events;
    if (!Array.isArray(events)) return;
    for (const ev of events) {
      const t = ev.pushEventType;
      if (t === 'HOME_CHANGED') {
        if (ev.home) this.raw.home = ev.home;
      } else if (t === 'DEVICE_ADDED' || t === 'DEVICE_CHANGED' || t === 'DEVICE_REMOVED') {
        const list = Array.isArray(this.raw.devices) ? this.raw.devices : (this.raw.devices = []);
        const incoming = Array.isArray(ev.devices) ? ev.devices : [];
        for (const dev of incoming) {
          const idx = list.findIndex((d) => d.id === dev.id);
          if (t === 'DEVICE_REMOVED') {
            if (idx >= 0) list.splice(idx, 1);
          } else if (idx >= 0) {
            list[idx] = dev;
          } else if (t === 'DEVICE_ADDED') {
            list.push(dev);
          }
        }
        this.emit('devicesChanged', incoming, t);
      } else if (t === 'GROUP_ADDED' || t === 'GROUP_CHANGED' || t === 'GROUP_REMOVED') {
        const list = Array.isArray(this.raw.groups) ? this.raw.groups : (this.raw.groups = []);
        const incoming = Array.isArray(ev.groups) ? ev.groups : [];
        for (const grp of incoming) {
          const idx = list.findIndex((g) => g.id === grp.id);
          if (t === 'GROUP_REMOVED') {
            if (idx >= 0) list.splice(idx, 1);
          } else if (idx >= 0) {
            list[idx] = grp;
          } else if (t === 'GROUP_ADDED') {
            list.push(grp);
          }
        }
      }
    }
  }

  /** All devices this plugin owns inside HMIP (our HCU twins). */
  findPluginTwins() {
    const out = [];
    if (!this.raw || !Array.isArray(this.raw.devices)) return out;
    for (const d of this.raw.devices) {
      if (d.pluginId === this.pluginId || d.type === 'PLUGIN_EXTERNAL') out.push(d);
    }
    return out;
  }

  /** Twin for a specific plugin-side device id (our DiscoverResponse id). */
  findTwinByPluginDeviceId(pluginDeviceId) {
    return this.findPluginTwins().find(
      (d) => d.pluginDeviceId === pluginDeviceId || d.id === pluginDeviceId
    ) || null;
  }

  /** Room name for a twin device (via META room groups). */
  roomNameForDevice(deviceId) {
    if (!this.raw || !Array.isArray(this.raw.groups)) return '';
    for (const g of this.raw.groups) {
      if (g.type === 'META' && Array.isArray(g.deviceIds) && g.deviceIds.includes(deviceId)) {
        return g.roomMetadata ? (g.roomMetadata.caption || g.caption || '') : (g.caption || '');
      }
    }
    return '';
  }
}

module.exports = HmipCache;
