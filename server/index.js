'use strict';
// hcu-bosch-bridge entrypoint.
//
// Launch convention (official example + reference plugin):
//   node server/index.js <pluginId> <hcuHost> <tokenFile>
// Installed on the HCU the args are:
//   de.essers.gerrit.plugin.boschbridge host.containers.internal /TOKEN
// Local remote-development against the HCU (developer mode):
//   node server/index.js <pluginId> hcu1-xxxx.local ./data/dev-authtoken.txt

const fs = require('fs');
const path = require('path');

const HcuClient = require('./hcu-client');
const HmipCache = require('./hmip-cache');
const Registry = require('./registry');
const BoschManager = require('./bosch');
const { sourceDevices, resolveControl } = require('./mapping');
const { getStore } = require('./config-store');
const { getDataDir } = require('./data-dir');
const { buildConfigTemplate, applyConfigUpdate } = require('./config-page');
const WebUiServer = require('./webui/server');
const applog = require('./applog');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const pluginId = args[0] || 'de.essers.gerrit.plugin.boschbridge';
const hcuHost = args[1] || 'host.containers.internal';
const tokenPath = args[2] || '/TOKEN';
const WEBUI_PORT = parseInt(process.env.WEBUI_PORT || '8341', 10);

function readToken() {
  try {
    return fs.readFileSync(tokenPath, 'utf8').trim();
  } catch (e) {
    applog.warn(`[main] token file ${tokenPath} not found (${e.code}) - starting without token ` +
      `(OK for local dev; on the HCU /TOKEN is always present)`);
    return '';
  }
}

function readSgtin() {
  for (const p of ['/SGTIN', path.join(getDataDir(), 'SGTIN')]) {
    try { return fs.readFileSync(p, 'utf8').trim(); } catch { /* next */ }
  }
  return process.env.DEV_SGTIN || '';
}

async function main() {
  applog.info(`[main] ${pkg.name} v${pkg.version} starting (node ${process.version})`);
  applog.info(`[main] pluginId=${pluginId} hcuHost=${hcuHost} dataDir=${getDataDir()}`);

  const store = getStore();
  const cache = new HmipCache(pluginId);
  const hcu = new HcuClient(pluginId, hcuHost, readToken());
  const registry = new Registry(hcu, store, cache);

  const sgtin = readSgtin();
  const boschPorts = {
    pairPort: process.env.BOSCH_PAIR_PORT ? parseInt(process.env.BOSCH_PAIR_PORT, 10) : undefined,
    apiPort: process.env.BOSCH_API_PORT ? parseInt(process.env.BOSCH_API_PORT, 10) : undefined,
    infoPort: process.env.BOSCH_INFO_PORT ? parseInt(process.env.BOSCH_INFO_PORT, 10) : undefined,
  };
  const bosch = new BoschManager({ store, ports: boschPorts });
  const ctx = {
    pluginId,
    pkgVersion: pkg.version,
    hcu,
    cache,
    registry,
    store,
    bosch,
    hcuIp: '',
    webuiUrl: '',
    boschStatus: () => bosch.status(),
  };

  // ---- HCUweb config page --------------------------------------------------
  hcu.setConfigTemplateProvider(() => buildConfigTemplate(ctx));
  hcu.setConfigUpdateHandler((requestId, body) => {
    try {
      applyConfigUpdate(store, body && body.properties);
      if (ctx.resync) ctx.resync();
      hcu.sendRaw({
        id: requestId,
        pluginId,
        type: 'CONFIG_UPDATE_RESPONSE',
        body: { status: 'APPLIED', message: '' },
      });
    } catch (err) {
      applog.error('[main] config update failed:', err);
      hcu.sendRaw({
        id: requestId,
        pluginId,
        type: 'CONFIG_UPDATE_RESPONSE',
        body: { status: 'FAILED', message: String(err.message || err) },
      });
    }
  });

  // ---- plugin devices ------------------------------------------------------
  hcu.setDiscoverDevicesProvider(() => registry.getDevicesForDiscover());
  hcu.setStatusDevicesProvider((deviceIds) => registry.getDevicesForStatus(deviceIds));

  // ---- Bosch -> registry pipeline (M3) --------------------------------------
  registry.setSource(() => (bosch.connected ? sourceDevices(bosch, store) : []));

  /** Re-read the Bosch side into the registry; reconnect HCU when new devices
   *  appeared (only the HCU can start a new DISCOVER cycle). */
  function resyncBosch() {
    let rows = [];
    try { rows = sourceDevices(bosch, store); } catch (err) { applog.warn('[main] source error:', err.message); return; }
    const needs = registry.syncFromSource();
    if (needs && hcu.connected) {
      applog.info('[main] new Bosch devices -> reconnect for re-discovery');
      hcu.reconnect('bosch-devices');
    } else {
      for (const row of rows) registry.pushDeviceStatus(row.id, row.features);
    }
  }

  function rowsForBoschDevice(boschId) {
    return sourceDevices(bosch, store).filter((r) =>
      r.id === boschId || r.id.startsWith(`${boschId}:`) ||
      (bosch.intrusion && bosch.intrusion.deviceId === boschId && r.id === 'bosch:intrusion'));
  }

  bosch.on('inventory', () => resyncBosch());
  bosch.on('stateChanged', ({ deviceId }) => {
    for (const row of rowsForBoschDevice(deviceId)) registry.pushDeviceStatus(row.id, row.features);
  });
  // Settings that add/remove (secondary) devices take effect immediately.
  ctx.resync = resyncBosch;

  // ---- control pipeline (M3) --------------------------------------------------
  hcu.setControlRequestHandler(async (requestId, body) => {
    const deviceId = body && body.deviceId;
    const respond = (success, error) => hcu.sendRaw({
      id: requestId,
      pluginId,
      type: 'CONTROL_RESPONSE',
      body: Object.assign({ deviceId, success }, error ? { error } : {}),
    });
    try {
      if (!bosch.connected) {
        const err = new Error('Bosch SHC ist nicht verbunden');
        err.code = 'BOSCH_UNREACHABLE';
        throw err;
      }
      const resolved = resolveControl(bosch, store, deviceId, (body && body.features) || []);
      if (!resolved) {
        const err = new Error('Gerat ist nicht steuerbar');
        err.code = 'NOT_CONTROLLABLE';
        throw err;
      }
      if (resolved.action) await bosch.runAction(resolved.action);
      else for (const c of resolved.calls) await bosch.setServiceState(c.deviceId, c.serviceId, c.body);
      respond(true);
      // Momentary devices (scenes) fall back to off after the trigger.
      if (resolved.action && resolved.action.name === 'scene') {
        setTimeout(() => registry.pushDeviceStatus(deviceId, [{ type: 'switchState', on: false }]), 800);
      }
    } catch (err) {
      respond(false, { code: err.code || 'BOSCH_ERROR', message: String(err.message || err) });
    }
  });

  // ---- HCU info (WebUI URL for the WEBLINK property) ------------------------
  // Convention (wie ReactFluid-Beispiel): stabiler .local-Name aus der SGTIN,
  // IP nur als Fallback. Der Link lebt ausschließlich auf der HCUweb-Seite.
  hcu.on('connected', async () => {
    if (sgtin.length >= 4) {
      ctx.webuiUrl = `http://hcu1-${sgtin.slice(-4).toLowerCase()}.local:${WEBUI_PORT}`;
    }
    try {
      const info = await hcu.requestSystemInfo();
      if (info && info.success && info.ipAddress) {
        ctx.hcuIp = info.ipAddress;
        if (!ctx.webuiUrl) ctx.webuiUrl = `http://${ctx.hcuIp}:${WEBUI_PORT}`;
        applog.info(`[main] HCU IP = ${ctx.hcuIp} -> WebUI link: ${ctx.webuiUrl}`);
      }
    } catch (err) {
      applog.warn('[main] SYSTEM_INFO_REQUEST failed:', err.message);
    }
  });
  hcu.on('systemEvent', (body) => {
    cache.applyEvent(body);
  });

  // ---- WebUI ----------------------------------------------------------------
  const webui = new WebUiServer(ctx);
  await webui.start(WEBUI_PORT);

  hcu.connect();
  bosch.start().catch((err) => applog.warn('[main] bosch startup error:', err.message));

  // Graceful shutdown (HCU stops the container on plugin update/remove)
  const shutdown = (sig) => {
    applog.info(`[main] ${sig} received, shutting down`);
    webui.stop();
    try { bosch.disconnect(); } catch { /* ignore */ }
    try { hcu.ws && hcu.ws.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => applog.error('[main] unhandled rejection:', e));
}

main().catch((err) => {
  applog.error('[main] fatal startup error:', err);
  process.exit(1);
});
