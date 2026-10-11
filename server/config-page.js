'use strict';
// Builds the CONFIG_TEMPLATE_RESPONSE body shown on the HCUweb plugin page.
//
// Layout (see PLAN section 7):
//   Group "webui":  WEBLINK property -> link to the plugin WebUI
//   Group "conn":   READONLY connection/status summary
//   Group "maps":   one READONLY property per mapped Bosch -> HCU device
//   Group "conf":   editable settings (subset)
//
// The template is rebuilt on every CONFIG_TEMPLATE_REQUEST so the device list
// reflects the current state when the user opens the dialog.

// Map our offered device types to short German labels for the mapping list.
const TYPE_LABEL = {
  CONTACT_SENSOR: 'Kontakt',
  SWITCH: 'Schalter',
  LIGHT: 'Licht',
  THERMOSTAT: 'Thermostat',
  WINDOW_COVERING: 'Rollladen',
  OCCUPANCY_SENSOR: 'Praesenz',
  SMOKE_ALARM: 'Rauchwarn.',
  WATER_SENSOR: 'Wasser',
  SWITCH_INPUT: 'Taster',
  CLIMATE_SENSOR: 'Klima',
  ENERGY_METER: 'Energie',
};

function shortFeatureSummary(features) {
  if (!Array.isArray(features) || !features.length) return '';
  const parts = [];
  for (const f of features) {
    switch (f.type) {
      case 'switchState': parts.push(f.on ? 'AN' : 'AUS'); break;
      case 'contactSensorState': parts.push(f.triggered ? 'geoeffnet' : 'geschlossen'); break;
      case 'shutterLevel':
        parts.push(typeof f.shutterLevel === 'number' ? `Pos ${Math.round(f.shutterLevel * 100)}%` : '');
        break;
      case 'setPointTemperature':
        if (typeof f.setPointTemperature === 'number') parts.push(`${f.setPointTemperature.toFixed(1)}C`);
        break;
      case 'actualTemperature':
        if (typeof f.actualTemperature === 'number') parts.push(`ist ${f.actualTemperature.toFixed(1)}C`);
        break;
      case 'presenceDetected': parts.push(f.presenceDetected ? 'aktiv' : 'ruhig'); break;
      case 'smokeAlarm': parts.push(f.smokeAlarm ? 'ALARM' : 'ok'); break;
      case 'waterlevelDetected': parts.push(f.waterlevelDetected ? 'WASSER!' : 'trocken'); break;
      case 'dimming':
        if (typeof f.dimLevel === 'number') parts.push(`${Math.round(f.dimLevel * 100)}%`);
        break;
      case 'currentPower':
        if (typeof f.currentPower === 'number') parts.push(`${f.currentPower.toFixed(0)}W`);
        break;
      default: break;
    }
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * @param {object} ctx { pluginId, webuiUrl, hcuIp, registry, hcu, pkgVersion, boschStatus() }
 */
function buildConfigTemplate(ctx) {
  const groups = {
    webui: { friendlyName: 'WebUI', description: 'Erweiterte Konfiguration im Browser', order: 1 },
    conn: { friendlyName: 'Verbindung', description: 'Status der Verbindungen', order: 2 },
    maps: { friendlyName: 'Zugeordnete Gerate', description: 'Bosch-Gerate und ihre HCU-Zwillinge', order: 3 },
    conf: { friendlyName: 'Einstellungen', description: 'Wichtige Optionen (mehr im WebUI)', order: 4 },
  };

  const properties = {};

  // --- WebUI link (WEBLINK: currentValue=URL, defaultValue=link text) -----
  properties.webui_link = {
    dataType: 'WEBLINK',
    groupId: 'webui',
    order: 1,
    friendlyName: 'Bosch-Bridge WebUI',
    description: 'Pairing, Mapping und Live-Status',
    currentValue: ctx.webuiUrl,
    defaultValue: 'WebUI oeffnen',
    required: false,
  };

  // --- Connection status ----------------------------------------------------
  const bs = ctx.boschStatus ? ctx.boschStatus() : { paired: false, host: '' };
  const hcuState = ctx.hcu && ctx.hcu.connected ? 'verbunden' : 'getrennt';
  properties.hcu_status = {
    dataType: 'READONLY',
    groupId: 'conn',
    order: 1,
    friendlyName: 'HCU Connect API',
    currentValue: `Plugin ${ctx.pluginId} v${ctx.pkgVersion} - WebSocket ${hcuState}` +
      (ctx.hcuIp ? ` - HCU ${ctx.hcuIp}` : ''),
    required: false,
  };
  properties.bosch_status = {
    dataType: 'READONLY',
    groupId: 'conn',
    order: 2,
    friendlyName: 'Bosch Smart Home',
    currentValue: bs.paired
      ? `Gepairt mit SHC ${bs.host}`
      : `Nicht gepairt - WebUI oeffnen (${ctx.webuiUrl})`,
    required: false,
  };

  // --- Mapping list (READONLY per device) ----------------------------------
  const rows = ctx.registry ? ctx.registry.mappingRows() : [];
  rows.forEach((row, i) => {
    const key = `map_${row.boschId}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
    const state = row.included
      ? `HCU-Zwilling${row.room ? ` in ${row.room}` : ''}`
      : (row.enabled ? 'wartet in der Inbox' : 'deaktiviert (geparkt)');
    const type = TYPE_LABEL[row.deviceType] || row.deviceType;
    const feat = shortFeatureSummary(row.features);
    properties[key] = {
      dataType: 'READONLY',
      groupId: 'maps',
      order: i + 1,
      friendlyName: row.name || row.boschId,
      description: `${type} - ${state}`,
      currentValue: feat || '-',
      required: false,
    };
  });

  // --- A few editable settings ---------------------------------------------
  const store = ctx.store;
  if (store) {
    properties.enableScenarios = {
      dataType: 'BOOLEAN',
      groupId: 'conf',
      order: 1,
      friendlyName: 'Bosch-Szenen anbieten',
      description: 'Bosch-Szenen als schaltbare HCU-Gerate',
      currentValue: String(!!store.get('enableScenarios')),
      required: false,
    };
    properties.enableIntrusion = {
      dataType: 'BOOLEAN',
      groupId: 'conf',
      order: 2,
      friendlyName: 'Alarmanlage anbieten',
      description: 'Bosch-Alarmanlage als HCU-Schalter (scharf/unscharf)',
      currentValue: String(!!store.get('enableIntrusion')),
      required: false,
    };
    properties.enableEnergyMeters = {
      dataType: 'BOOLEAN',
      groupId: 'conf',
      order: 3,
      friendlyName: 'Energie-Zweitgerate',
      description: 'PowerMeter-Daten als ENERGY_METER-Gerate anbieten',
      currentValue: String(!!store.get('enableEnergyMeters')),
      required: false,
    };
  }

  return { groups, properties };
}

/** Handle CONFIG_UPDATE_REQUEST values coming from the HCUweb dialog. */
function applyConfigUpdate(store, properties) {
  const patch = {};
  for (const [key, value] of Object.entries(properties || {})) {
    if (key === 'enableScenarios' || key === 'enableIntrusion' || key === 'enableEnergyMeters') {
      patch[key] = value === true || value === 'true' || value === 'on';
    }
    // map_*/status properties are READONLY and are ignored on purpose.
  }
  if (Object.keys(patch).length) store.setMany(patch);
  return patch;
}

module.exports = { buildConfigTemplate, applyConfigUpdate, shortFeatureSummary };
