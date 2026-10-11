'use strict';
// Unit tests for the mapping catalog and mapper (M2 acceptance).
// Run: node --test server/mapping/

const test = require('node:test');
const assert = require('node:assert/strict');

const { findEntry, findSecondaries } = require('../server/mapping/catalog');
const { sourceDevices, resolveControl, SCENE_PREFIX, INTRUSION_ID } = require('../server/mapping');

// Minimal fake store with the documented defaults.
function fakeStore(overrides = {}) {
  const data = Object.assign({
    enableScenarios: true,
    enableIntrusion: true,
    enableEnergyMeters: false,
    enableTwinguardPm: false,
    enableIlluminanceSensors: false,
    keypadAsMomentarySwitch: false,
  }, overrides);
  return { get: (k) => data[k], _data: data };
}

// Fake BoschManager with the same surface the mapper uses.
function fakeBosch(devices, scenes = [], intrusion = null) {
  return { devices: () => devices, scenes, intrusion };
}

const dev = (id, name, definedServices, states) => ({
  id, name, room: '', states,
  services: [{ id, deviceType: 'X', definedServices }],
});

test('power switch maps to SWITCH with switchState feature', () => {
  const e = findEntry(['powerSwitch', 'powerMeter']);
  assert.equal(e.id, 'powerSwitch');
  assert.equal(e.hcu.deviceType, 'SWITCH');
  const feats = e.mapState({ powerSwitch: { '@type': 'powerSwitchState', switchState: 'ON' } });
  assert.deepEqual(feats, [{ type: 'switchState', on: true }]);
});

test('switch control produces Bosch powerSwitchState PUT', () => {
  const e = findEntry(['powerSwitch']);
  const r = e.control([{ type: 'switchState', on: false }]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].serviceId, 'powerSwitch');
  assert.deepEqual(r.calls[0].body, { '@type': 'powerSwitchState', switchState: 'OFF' });
});

test('dimmer maps to LIGHT with switchState + dimming', () => {
  const e = findEntry(['multilevelSwitch']);
  assert.equal(e.hcu.deviceType, 'LIGHT');
  const feats = e.mapState({ multilevelSwitch: { switchState: 'ON', dimLevel: 0.6 } });
  assert.deepEqual(feats, [
    { type: 'switchState', on: true },
    { type: 'dimming', dimLevel: 0.6 },
  ]);
  const r = e.control([{ type: 'dimming', dimLevel: 0.5 }]);
  assert.deepEqual(r.calls[0].body, { '@type': 'multiLevelSwitchState', dimLevel: 0.5, switchState: 'ON' });
});

test('thermostat maps to THERMOSTAT with flat temperature features', () => {
  const e = findEntry(['climateControl', 'humidityLevel']);
  assert.equal(e.hcu.deviceType, 'THERMOSTAT');
  const feats = e.mapState({ climateControl: { setpointTemperature: 21.5, temperature: 22.1, humidity: 47.2 } });
  assert.deepEqual(feats, [
    { type: 'setPointTemperature', setPointTemperature: 21.5 },
    { type: 'actualTemperature', actualTemperature: 22.1 },
    { type: 'humidity', humidity: 47 },
  ]);
  const r = e.control([{ type: 'setPointTemperature', setPointTemperature: 18 }]);
  assert.deepEqual(r.calls[0].body, { '@type': 'climateControlState', setpointTemperature: 18 });
});

test('window covering maps shutterLevel and slatsLevel (0..1, 1=closed)', () => {
  const e = findEntry(['shutterControl']);
  const feats = e.mapState({ shutterControl: { shutterLevel: 0.25 }, blindsControl: { targetAngle: 0.5 } });
  assert.deepEqual(feats, [
    { type: 'shutterLevel', shutterLevel: 0.25 },
    { type: 'slatsLevel', slatsLevel: 0.5 },
  ]);
  const r = e.control([{ type: 'shutterLevel', shutterLevel: 2 }, { type: 'slatsLevel', slatsLevel: -1 }]);
  assert.equal(r.calls[0].body.shutterLevel, 1); // clamped
  assert.equal(r.calls[1].body.targetAngle, 0);  // clamped
});

test('contact sensor: opened -> triggered=true', () => {
  const e = findEntry(['contactDetection']);
  assert.equal(e.hcu.deviceType, 'CONTACT_SENSOR');
  assert.deepEqual(e.mapState({ contactDetection: { contactDetection: 'opened' } }),
    [{ type: 'contactSensorState', triggered: true }]);
  assert.equal(e.control([]), null);
});

test('smoke alarm, water and motion sensors map to their archetypes', () => {
  assert.equal(findEntry(['smokeAlarm']).hcu.deviceType, 'SMOKE_ALARM');
  assert.deepEqual(findEntry(['smokeAlarm']).mapState({ smokeAlarm: { smokeAlarmDetection: 'ALARM' } }),
    [{ type: 'smokeAlarm', smokeAlarm: true }]);
  assert.equal(findEntry(['waterLevelDetection']).hcu.deviceType, 'WATER_SENSOR');
  assert.deepEqual(findEntry(['waterLevelDetection']).mapState({ waterLevelDetection: { waterLeakageDetected: true } }),
    [{ type: 'waterlevelDetected', waterlevelDetected: true }]);
  assert.equal(findEntry(['latestMotion', 'brightness']).hcu.deviceType, 'OCCUPANCY_SENSOR');
  assert.deepEqual(findEntry(['latestMotion']).mapState({ latestMotion: { motionDetected: true } }),
    [{ type: 'presenceDetected', presenceDetected: true }]);
});

test('keypad defaults to SWITCH_INPUT, falls back to SWITCH via setting', () => {
  const e = findEntry(['keypad']);
  assert.equal(e.hcu.deviceType, 'SWITCH_INPUT');
  const bosch = fakeBosch([dev('isycyf:0', 'Taster', ['keypad'], {})]);
  const asInput = sourceDevices(bosch, fakeStore());
  assert.equal(asInput[0].deviceType, 'SWITCH_INPUT');
  const asSwitch = sourceDevices(bosch, fakeStore({ keypadAsMomentarySwitch: true }));
  assert.equal(asSwitch[0].deviceType, 'SWITCH');
});

test('secondary energy meter is gated by enableEnergyMeters', () => {
  const secs = findSecondaries(['powerSwitch', 'powerMeter']);
  assert.equal(secs.length, 1);
  const bosch = fakeBosch([dev('isypm:0', 'Waschmaschine', ['powerSwitch', 'powerMeter'],
    { powerSwitch: { switchState: 'ON' }, powerMeter: { power: 120, energyCounterKwh: 3.5 } })]);

  const off = sourceDevices(bosch, fakeStore({ enableEnergyMeters: false }));
  assert.equal(off.length, 1);
  const on = sourceDevices(bosch, fakeStore({ enableEnergyMeters: true }));
  assert.equal(on.length, 2);
  const energy = on.find((d) => d.id === 'isypm:0:energy');
  assert.equal(energy.deviceType, 'ENERGY_METER');
  assert.equal(energy.friendlyName, 'Waschmaschine (Energie)');
  assert.deepEqual(energy.features, [
    { type: 'currentPower', currentPower: 120 },
    { type: 'energyCounter', in: 3.5, out: 0 },
  ]);
});

test('brightness secondary gated by enableIlluminanceSensors', () => {
  const bosch = fakeBosch([dev('isymd:0', 'Bewegungsmelder', ['latestMotion', 'brightness'],
    { latestMotion: { motionDetected: false }, brightness: { brightness: 42 } })]);
  const on = sourceDevices(bosch, fakeStore({ enableIlluminanceSensors: true }));
  const lux = on.find((d) => d.id.endsWith(':lux'));
  assert.equal(lux.deviceType, 'CLIMATE_SENSOR');
  assert.deepEqual(lux.features, [{ type: 'illumination', illumination: 42 }]);
  const off = sourceDevices(bosch, fakeStore());
  assert.ok(!off.find((d) => d.id.endsWith(':lux')));
});

test('scenes become virtual SWITCH devices; ON triggers scene action', () => {
  const bosch = fakeBosch([], [{ id: 'SCENES/1', name: 'Kino' }]);
  const src = sourceDevices(bosch, fakeStore());
  assert.equal(src.length, 1);
  assert.equal(src[0].id, SCENE_PREFIX + 'SCENES/1');
  assert.equal(src[0].deviceType, 'SWITCH');
  assert.match(src[0].friendlyName, /Kino/);

  const r = resolveControl(bosch, fakeStore(), SCENE_PREFIX + 'SCENES/1', [{ type: 'switchState', on: true }]);
  assert.deepEqual(r.action, { name: 'scene', args: { sceneId: 'SCENES/1' } });
  const off = resolveControl(bosch, fakeStore(), SCENE_PREFIX + 'SCENES/1', [{ type: 'switchState', on: false }]);
  assert.equal(off, null);
});

test('intrusion becomes one virtual SWITCH; on/off maps to arm/disarm action', () => {
  const bosch = fakeBosch([], [], { deviceId: 'isyhsg:0', '@type': 'safeState', overallState: 'IDLE' });
  const src = sourceDevices(bosch, fakeStore());
  const alarm = src.find((d) => d.id === INTRUSION_ID);
  assert.equal(alarm.deviceType, 'SWITCH');
  assert.equal(alarm.features[0].on, false);

  const armed = fakeBosch([], [], { deviceId: 'isyhsg:0', '@type': 'safeState', overallState: 'INTRUSION_ARMED' });
  const src2 = sourceDevices(armed, fakeStore());
  assert.equal(src2.find((d) => d.id === INTRUSION_ID).features[0].on, true);

  const r = resolveControl(bosch, fakeStore(), INTRUSION_ID, [{ type: 'switchState', on: true }]);
  assert.deepEqual(r.action, { name: 'intrusion', args: { armed: true } });
});

test('resolveControl fills deviceId for real devices and rejects unknown ids', () => {
  const bosch = fakeBosch([dev('isymos:0', 'Stehlampe', ['powerSwitch'], { powerSwitch: { switchState: 'OFF' } })]);
  const r = resolveControl(bosch, fakeStore(), 'isymos:0', [{ type: 'switchState', on: true }]);
  assert.equal(r.calls[0].deviceId, 'isymos:0');
  assert.deepEqual(r.calls[0].body, { '@type': 'powerSwitchState', switchState: 'ON' });
  assert.equal(resolveControl(bosch, fakeStore(), 'gibts-nicht', [{ type: 'switchState', on: true }]), null);
});

test('unmapped devices (e.g. cameras) produce no source entries', () => {
  const bosch = fakeBosch([dev('iscam:0', 'Kamera', ['camera'], {})]);
  assert.equal(sourceDevices(bosch, fakeStore()).length, 0);
});

