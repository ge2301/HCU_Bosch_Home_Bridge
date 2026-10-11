'use strict';
// Declarative mapping catalog: Bosch service state -> HCU plugin device.
//
// One entry per HCU archetype (see PLAN section 4). An entry matches a Bosch
// device by the service ids present in its /smarthome/services entry
// (definedServices). For every match we produce:
//   - hcu.deviceType/modelType  (Connect API 6.6.7 DeviceTypes)
//   - mapState(states)          -> flat feature objects (Connect API 6.7)
//   - control(feature)          -> Bosch PUT calls or named manager actions
//
// Feature objects are FLAT per the Connect API, e.g.
//   { type: 'switchState', on: true }
//   { type: 'shutterLevel', shutterLevel: 0.5 }
//   { type: 'setPointTemperature', setPointTemperature: 21.5 }

// ---- helpers -----------------------------------------------------------------

const has = (svcIds, want) => svcIds.includes(want);

/** Bosch shutterLevel: 0 open .. 1 closed. HCU shutterLevel: 0 open .. 1 closed. */
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v)));

// ---- catalog entries -----------------------------------------------------------
// id:                unique catalog key
// match(serviceIds): does this entry own the device?
// hcu:               { deviceType, modelType }
// secondary:         true -> only offered when entry.setting is enabled
// mapState(states, device): -> features[]
// control(features, device): -> { calls?:[{deviceId,serviceId,body}], action?:{name,args} }

const CATALOG = [
  {
    id: 'powerSwitch',
    match: (s) => has(s, 'powerSwitch') && !has(s, 'multilevelSwitch'),
    hcu: { deviceType: 'SWITCH', modelType: 'BPS_SWITCH' },
    mapState: (st) => [{ type: 'switchState', on: st.powerSwitch && st.powerSwitch.switchState === 'ON' }],
    control: (features) => {
      const f = (features || []).find((x) => x.type === 'switchState');
      if (!f) return null;
      return { calls: [{ serviceId: 'powerSwitch', body: { '@type': 'powerSwitchState', switchState: f.on ? 'ON' : 'OFF' } }] };
    },
  },
  {
    id: 'multilevelSwitch',
    match: (s) => has(s, 'multilevelSwitch'),
    hcu: { deviceType: 'LIGHT', modelType: 'BPS_DIMMER' },
    mapState: (st) => {
      const s = st.multilevelSwitch || {};
      const feats = [{ type: 'switchState', on: s.switchState === 'ON' }];
      if (typeof s.dimLevel === 'number') feats.push({ type: 'dimming', dimLevel: s.dimLevel });
      return feats;
    },
    control: (features) => {
      const sw = (features || []).find((x) => x.type === 'switchState');
      const dim = (features || []).find((x) => x.type === 'dimming');
      const body = { '@type': 'multiLevelSwitchState' };
      if (dim && typeof dim.dimLevel === 'number') {
        body.dimLevel = clamp01(dim.dimLevel);
        body.switchState = dim.dimLevel > 0 ? 'ON' : 'OFF';
      } else if (sw) {
        body.switchState = sw.on ? 'ON' : 'OFF';
      } else return null;
      return { calls: [{ serviceId: 'multilevelSwitch', body }] };
    },
  },
  {
    id: 'shutterControl',
    match: (s) => has(s, 'shutterControl'),
    hcu: { deviceType: 'WINDOW_COVERING', modelType: 'BPS_SHUTTER' },
    mapState: (st) => {
      const s = st.shutterControl || {};
      const feats = [{ type: 'shutterLevel', shutterLevel: typeof s.shutterLevel === 'number' ? s.shutterLevel : 0 }];
      const blinds = st.blindsControl || st.blindControl;
      if (blinds && typeof blinds.targetAngle === 'number') feats.push({ type: 'slatsLevel', slatsLevel: blinds.targetAngle });
      return feats;
    },
    control: (features) => {
      const lvl = (features || []).find((x) => x.type === 'shutterLevel');
      const slats = (features || []).find((x) => x.type === 'slatsLevel');
      const calls = [];
      if (lvl) calls.push({ serviceId: 'shutterControl', body: { '@type': 'shutterControlState', shutterLevel: clamp01(lvl.shutterLevel) } });
      if (slats) calls.push({ serviceId: 'blindsControl', body: { '@type': 'blindsControlState', targetAngle: clamp01(slats.slatsLevel) } });
      return calls.length ? { calls } : null;
    },
  },
  {
    id: 'climateControl',
    match: (s) => has(s, 'climateControl'),
    hcu: { deviceType: 'THERMOSTAT', modelType: 'BPS_THM' },
    mapState: (st) => {
      const s = st.climateControl || {};
      const feats = [];
      if (typeof s.setpointTemperature === 'number') feats.push({ type: 'setPointTemperature', setPointTemperature: s.setpointTemperature });
      if (typeof s.temperature === 'number') feats.push({ type: 'actualTemperature', actualTemperature: s.temperature });
      if (typeof s.humidity === 'number') feats.push({ type: 'humidity', humidity: Math.round(s.humidity) });
      if (!feats.length) feats.push({ type: 'setPointTemperature', setPointTemperature: 0 });
      return feats;
    },
    control: (features) => {
      const f = (features || []).find((x) => x.type === 'setPointTemperature');
      if (!f) return null;
      return { calls: [{ serviceId: 'climateControl', body: { '@type': 'climateControlState', setpointTemperature: f.setPointTemperature } }] };
    },
  },
  {
    id: 'contactDetection',
    match: (s) => has(s, 'contactDetection'),
    hcu: { deviceType: 'CONTACT_SENSOR', modelType: 'BPS_WINDOW' },
    mapState: (st) => {
      const s = st.contactDetection || {};
      return [{ type: 'contactSensorState', triggered: s.contactDetection === 'opened' }];
    },
    control: () => null,
  },
  {
    id: 'smokeAlarm',
    match: (s) => has(s, 'smokeAlarm') || has(s, 'smokeAlarmDetector'),
    hcu: { deviceType: 'SMOKE_ALARM', modelType: 'BPS_SMOKE' },
    mapState: (st) => {
      const s = st.smokeAlarm || st.smokeAlarmDetector || {};
      const alarm = s.smokeAlarm === true || s.smokeAlarmDetection === 'ALARM' || s.alarm === true;
      return [{ type: 'smokeAlarm', smokeAlarm: alarm }];
    },
    control: () => null,
  },
  {
    id: 'waterDetection',
    match: (s) => has(s, 'waterLevelDetection') || has(s, 'waterlevelDetection'),
    hcu: { deviceType: 'WATER_SENSOR', modelType: 'BPS_WATER' },
    mapState: (st) => {
      const s = st.waterLevelDetection || st.waterlevelDetection || {};
      return [{ type: 'waterlevelDetected', waterlevelDetected: !!(s.waterLeakageDetected ?? s.waterlevelDetected) }];
    },
    control: () => null,
  },
  {
    id: 'motionDetection',
    match: (s) => has(s, 'latestMotion') || has(s, 'motionDetection'),
    hcu: { deviceType: 'OCCUPANCY_SENSOR', modelType: 'BPS_MOTION' },
    mapState: (st) => {
      const s = st.latestMotion || st.motionDetection || {};
      const detected = s.motionDetection === 'ON' || s.motionDetected === true || s.lastMotionDetected === true;
      return [{ type: 'presenceDetected', presenceDetected: detected }];
    },
    control: () => null,
  },
  // Bosch wall remote (WRC2) / keypad -> SWITCH_INPUT (R3: field test pending;
  // fallback mode offered via setting keypadAsMomentarySwitch).
  {
    id: 'keypad',
    match: (s) => has(s, 'keypad') || has(s, 'twoKeyPad') || has(s, 'fourKeyPad'),
    hcu: { deviceType: 'SWITCH_INPUT', modelType: 'BPS_REMOTE' },
    mapState: () => [],
    control: () => null,
    settingOverride: { key: 'keypadAsMomentarySwitch', on: { deviceType: 'SWITCH', modelType: 'BPS_REMOTE' } },
  },
  // Twinguard multilevel state is handled through smokeAlarm + secondary sensors.
];

// ---- secondary (bonus) devices ----------------------------------------------------
// Checked AFTER primary mapping; produce extra virtual devices from the same
// Bosch hardware. `setting` gates them (config-store boolean).

const SECONDARY = [
  {
    id: 'energyMeter',
    setting: 'enableEnergyMeters',
    match: (s) => has(s, 'powerMeter'),
    hcu: { deviceType: 'ENERGY_METER', modelType: 'BPS_METER' },
    suffix: ':energy',
    nameSuffix: ' (Energie)',
    mapState: (st) => {
      const s = st.powerMeter || {};
      const feats = [];
      if (typeof s.power === 'number') feats.push({ type: 'currentPower', currentPower: s.power });
      const inKwh = typeof s.energyCounterKwh === 'number' ? s.energyCounterKwh
        : (typeof s.energyCounter === 'number' ? s.energyCounter : undefined);
      if (inKwh !== undefined) feats.push({ type: 'energyCounter', in: inKwh, out: 0 });
      return feats;
    },
    control: () => null,
  },
  {
    // Bosch motion sensor built-in brightness -> simple climate sensor device
    id: 'brightness',
    setting: 'enableIlluminanceSensors',
    match: (s) => has(s, 'brightness'),
    hcu: { deviceType: 'CLIMATE_SENSOR', modelType: 'BPS_BRIGHT' },
    suffix: ':lux',
    nameSuffix: ' (Helligkeit)',
    mapState: (st) => {
      const s = st.brightness || {};
      const v = typeof s.brightness === 'number' ? s.brightness
        : (typeof s.level === 'number' ? s.level : undefined);
      return v === undefined ? [] : [{ type: 'illumination', illumination: v }];
    },
    control: () => null,
  },
  {
    // Twinguard air quality extras -> climate sensor (humidity/CO2 where present)
    id: 'twinguardAir',
    setting: 'enableTwinguardPm',
    match: (s) => has(s, 'hygrometer') || has(s, 'carbondioxide') || has(s, 'airQuality'),
    hcu: { deviceType: 'CLIMATE_SENSOR', modelType: 'BPS_AIR' },
    suffix: ':air',
    nameSuffix: ' (Luftgüte)',
    mapState: (st) => {
      const feats = [];
      const h = st.hygrometer;
      if (h && typeof h.humidity === 'number') feats.push({ type: 'humidity', humidity: Math.round(h.humidity) });
      const co2 = st.carbondioxide;
      if (co2 && typeof co2.carbonDioxide === 'number') feats.push({ type: 'co2Concentration', co2Concentration: co2.carbonDioxide });
      return feats;
    },
    control: () => null,
  },
];

// ---- lookup -----------------------------------------------------------------------

/** First catalog entry whose match() is satisfied by the service id list. */
function findEntry(serviceIds) {
  return CATALOG.find((e) => e.match(serviceIds)) || null;
}

function findSecondaries(serviceIds) {
  return SECONDARY.filter((e) => e.match(serviceIds));
}

module.exports = { CATALOG, SECONDARY, findEntry, findSecondaries, clamp01 };
