'use strict';
// Persistent data directory resolver.
// On the HCU the Docker image sets DATA_DIR=/data (Connect API docs 4.2:
// contents survive plugin updates and restarts). For local development we
// fall back to ./data next to the project root.
const path = require('path');
const fs = require('fs');

let _resolved = null;

function getDataDir() {
  if (_resolved) return _resolved;
  if (process.env.DATA_DIR) {
    _resolved = process.env.DATA_DIR;
  } else {
    _resolved = path.join(__dirname, '..', 'data');
  }
  if (!fs.existsSync(_resolved)) {
    fs.mkdirSync(_resolved, { recursive: true });
  }
  return _resolved;
}

function getDataPath(...parts) {
  return path.join(getDataDir(), ...parts);
}

module.exports = { getDataDir, getDataPath };
