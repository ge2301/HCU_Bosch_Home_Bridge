'use strict';
// Configuration and runtime-state persistence inside the /data directory.
//
// Files:
//  - config.json  : user-editable settings (WebUI / HCUweb config page)
//  - offered.json : idempotency marker for plugin devices already offered to
//                   the HCU (prevents duplicates after restart, see plan R2)
//  - state.json   : runtime state (Bosch id -> HCU twin uuid mappings)
//
// All writes are atomic (tmp file + rename) so that a container update
// interrupted mid-write cannot leave a half-written JSON behind.

const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./data-dir');

const DEFAULTS = {
  // Bosch connection
  boschHost: '',
  boschClientId: 'oss_hcu-bosch-bridge',
  boschClientName: 'OSS HCU Bosch Bridge',
  boschPaired: false,
  // Device behaviour / feature toggles
  motionImpulseSeconds: 10,
  enableEnergyMeters: false,
  enableTwinguardPm: false,
  enableIlluminanceSensors: false,
  enableScenarios: true,
  enableIntrusion: true,
  keypadAsMomentarySwitch: false,
  requirePinToDisarm: true,
  // WebUI
  webuiPinEnabled: false,
  webuiPin: '',
  // Misc
  logLevel: 'info',
};

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[config] Failed reading ${path.basename(file)}:`, e.message);
    }
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

class Store {
  constructor() {
    this.configFile = getDataPath('config.json');
    this.offeredFile = getDataPath('offered.json');
    this.stateFile = getDataPath('state.json');

    this.config = Object.assign({}, DEFAULTS, readJson(this.configFile, {}));
    // offered.json: { [boschDeviceId]: true }
    this.offered = readJson(this.offeredFile, {});
    // state.json: { twins: { [boschId]: hcuUuid } }
    this.state = readJson(this.stateFile, { twins: {} });
    if (!this.state.twins) this.state.twins = {};
  }

  // --- config -------------------------------------------------------------
  get(key) { return this.config[key]; }
  getAll() { return Object.assign({}, this.config); }

  setMany(patch) {
    Object.assign(this.config, patch);
    writeJsonAtomic(this.configFile, this.config);
  }

  // --- offered (idempotency marker) ---------------------------------------
  wasOffered(boschId) { return !!this.offered[boschId]; }
  markOffered(boschId) {
    if (!this.offered[boschId]) {
      this.offered[boschId] = true;
      writeJsonAtomic(this.offeredFile, this.offered);
    }
  }
  clearOffered(boschId) {
    if (this.offered[boschId]) {
      delete this.offered[boschId];
      writeJsonAtomic(this.offeredFile, this.offered);
    }
  }
  offeredIds() { return Object.keys(this.offered); }

  // --- state (HCU twins) ----------------------------------------------------
  setTwin(boschId, hcuUuid) {
    this.state.twins[boschId] = hcuUuid;
    writeJsonAtomic(this.stateFile, this.state);
  }
  getTwin(boschId) { return this.state.twins[boschId]; }
  allTwins() { return Object.assign({}, this.state.twins); }
  clearTwin(boschId) {
    if (this.state.twins[boschId]) {
      delete this.state.twins[boschId];
      writeJsonAtomic(this.stateFile, this.state);
    }
  }
}

let _instance = null;
function getStore() {
  if (!_instance) _instance = new Store();
  return _instance;
}

module.exports = { getStore, DEFAULTS };
