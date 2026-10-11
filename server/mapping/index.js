'use strict';
// Mapper: turns BoschManager data (devices + states + scenes + intrusion) into
// registry source descriptors and resolves HCU CONTROL_REQUEST features back
// into Bosch API calls. Pure functions of (boschManagerData, settings) so the
// whole mapping can be unit tested with JSON fixtures.

const { findEntry, findSecondaries } = require('./catalog');

const SCENE_PREFIX = 'bosch:scene:';
const INTRUSION_ID = 'bosch:intrusion';

/** All defined-service ids of a bosch device row (manager devices() shape). */
function serviceIdsOf(device) {
  const ids = new Set();
  for (const s of device.services || []) {
    for (const d of s.definedServices || []) ids.add(d);
    if (!s.definedServices || !s.definedServices.length) ids.add(s.id);
  }
  return [...ids];
}

/**
 * Build registry source descriptors.
 * @param {object} bosch  BoschManager instance (uses devices(), scenes, store settings)
 */
function sourceDevices(bosch, store) {
  const out = [];
  const get = (k) => store.get(k);

  for (const dev of bosch.devices()) {
    const svcIds = serviceIdsOf(dev);
    let entry = findEntry(svcIds);
    if (entry && entry.settingOverride && get(entry.settingOverride.key)) {
      entry = Object.assign({}, entry, { hcu: entry.settingOverride.on });
    }
    if (entry) {
      out.push({
        id: dev.id,
        deviceType: entry.hcu.deviceType,
        modelType: entry.hcu.modelType,
        friendlyName: dev.name || dev.id,
        features: entry.mapState(dev.states || {}),
      });
    }
    if (entry) {
      for (const sec of findSecondaries(svcIds)) {
        if (sec.setting && !get(sec.setting)) continue;
        const feats = sec.mapState(dev.states || {});
        if (!feats.length) continue; // nothing to report yet
        out.push({
          id: dev.id + sec.suffix,
          deviceType: sec.hcu.deviceType,
          modelType: sec.hcu.modelType,
          friendlyName: (dev.name || dev.id) + sec.nameSuffix,
          features: feats,
        });
      }
    }
  }

  // --- virtual devices: Bosch scenes ------------------------------------------
  if (get('enableScenarios')) {
    for (const scene of bosch.scenes || []) {
      out.push({
        id: SCENE_PREFIX + scene.id,
        deviceType: 'SWITCH',
        modelType: 'BPS_SCENE',
        friendlyName: `Szene: ${scene.name || scene.id}`,
        features: [{ type: 'switchState', on: false }], // momentary; auto-off
      });
    }
  }

  // --- virtual device: intrusion alarm system ----------------------------------
  if (get('enableIntrusion') && bosch.intrusion) {
    const armed = !!(bosch.intrusion.overallState && bosch.intrusion.overallState !== 'IDLE');
    out.push({
      id: INTRUSION_ID,
      deviceType: 'SWITCH',
      modelType: 'BPS_ALARM',
      friendlyName: 'Alarmanlage (Bosch)',
      features: [{ type: 'switchState', on: armed }],
    });
  }

  return out;
}

/**
 * Resolve CONTROL_REQUEST features for an offered device id.
 * @returns null | { calls:[{deviceId,serviceId,body}] } | { action:{name,args} }
 */
function resolveControl(bosch, store, offeredId, features) {
  if (offeredId.startsWith(SCENE_PREFIX)) {
    const f = (features || []).find((x) => x.type === 'switchState');
    if (!f || !f.on) return null; // scenes are trigger-on-ON only
    return { action: { name: 'scene', args: { sceneId: offeredId.slice(SCENE_PREFIX.length) } } };
  }
  if (offeredId === INTRUSION_ID) {
    const f = (features || []).find((x) => x.type === 'switchState');
    if (!f) return null;
    return { action: { name: 'intrusion', args: { armed: !!f.on } } };
  }
  const dev = bosch.devices().find((d) => d.id === offeredId);
  if (!dev) return null;
  const entry = findEntry(serviceIdsOf(dev));
  if (!entry) return null;
  const resolved = entry.control(features, dev);
  if (!resolved || !resolved.calls) return resolved;
  return {
    calls: resolved.calls.map((c) => Object.assign({ deviceId: dev.id }, c)),
  };
}

module.exports = { sourceDevices, resolveControl, serviceIdsOf, SCENE_PREFIX, INTRUSION_ID };
