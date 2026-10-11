# Entwickler-Dokumentation

Diese Datei richtet sich an Entwickler, die den Quellcode ändern, Tests
ausführen oder das Plugin selbst bauen wollen. Die Benutzer-Dokumentation
steht im [README](../README.md), die Hintergrund-Entscheidungen im
[PLAN](PLAN-hcu-bosch-plugin.md).

## Projektstand (Meilensteine)

- [x] M0 Scaffold: Connect-API-Client (READY, Discover/Status/Control/Config-Flows, Reconnect), HMIP-Systemstate-Cache mit Twin-Erkennung (PLUGIN_EXTERNAL), Geraete-Registry mit Idempotenz-Marker und unreach-Parking, HCUweb-Konfigseite (WEBLINK/READONLY), WebUI-Geruest (Express, Status-API, Logs, SSE)
- [x] M1 Bosch-Anbindung: SHC-Client (mTLS-REST, Inventar, Service-States, Long-Poll-Events), Pairing (selbstsigniertes Zertifikat, `oss_`-Pflicht), BoschManager-Lifecycle, Mock-SHC mit 10 Geraeten, Szenen und Events
- [x] M2 Mapping-Katalog: deklarative Typzuordnung (Kontakt, Schalter, Dimmer/Licht, Thermostat, Rollladen+Lamellen, Rauch, Wasser, Bewegung, Taster/SWITCH_INPUT), Bonus-Zweitgeraete (Energie/Helligkeit/Luftguete), Szenen und Alarmanlage als virtuelle HCU-Schalter
- [x] M3 Pipeline: Bosch-Ereignisse -> STATUS_EVENT; CONTROL_REQUEST -> Bosch-PUT (inkl. Szenen-Trigger und Alarm scharf/unscharf); automatische Neu-Discovery neuer Bosch-Geraete (idempotent)
- [x] M4 React-WebUI (`webui-src/`, Vite-Build nach `server/webui/public`): Dashboard, Bosch-Geraete inkl. Direktschalten, HCU-Zuordnung mit Aktivieren/Parken, Einstellungen, Live-Protokoll, Anleitung; SSE-Aktualisierung; Deep-Link-Fallback
- [x] M5 Demo-Stack und Feinschliff (`npm run demo`)
- [ ] M6 Feldtest an echter HCU, Edge-Cases (Bewegungsimpuls-AutoOff, WRC2, reale Szenen-/Alarm-Endpunkte, powerMeterState-Key-Matching)

## Testumgebung

```
npm test                              # Mapping-Katalog Unit-Tests
node scripts/smoke-mock-hcu.js        # HCU-Protokollstrecke (Mock-HCU-WebSocket)
node scripts/smoke-mock-shc.js        # Bosch-Strecke: Pairing, Inventar, Control, Events
node scripts/smoke-e2e.js             # Kompletter Durchstich HCU <-> Plugin <-> Bosch
node scripts/mock-shc.js --tick       # Mock-SHC manuell starten (PIN 12345678901234567890)
npm run demo                          # Kompletter Demo-Stack inkl. WebUI auf :8347
```

Tests der WebUI-API (Server muss laufen): `/api/status|devices|settings|pin|logs`
werden ueber `scripts/smoke-e2e.js` bzw. manuell gegen `http://localhost:8341` geprueft.

## Entwicklung (Remote-Modus gegen echte HCU)

1. HCUweb: Entwicklermodus aktivieren, Connect-API-WebSocket freigeben.
2. Aktivierungscode erzeugen, dann:
   `.\scripts\get-dev-token.ps1 -HcuHost hcu1-XXXX.local -ActivationKey ABCDEF`
3. `npm install`
4. `node server/index.js de.essers.gerrit.plugin.boschbridge hcu1-XXXX.local ./data/dev-authtoken.txt`
5. HCUweb -> Plugins: Plugin erscheint, READY. Konfigurations-Dialog zeigt
   WebUI-Link (http://<hcu-ip>:8341) und Status.

Ohne HCU laeuft der Server ebenfalls (WebUI erreichbar, WebSocket versucht
Reconnect alle 3 s): `npm start`.

### WebUI entwickeln (Hot-Reload)

```
npm install --prefix webui-src         # einmalig
npm run webui:dev                      # Vite-Dev-Server :5173, Proxy /api -> :8341
npm run webui:build                    # Produktions-Build nach server/webui/public
```

### Entwicklung gegen den Mock-SHC (ohne Bosch-Hardware)

```
node scripts/mock-shc.js --tick                # optional, simuliert Aktivitaet
$env:BOSCH_PAIR_PORT='18443'; $env:BOSCH_API_PORT='18444'; $env:BOSCH_INFO_PORT='18446'
node server/index.js                           # dann im WebUI auf http://localhost:8341 pairen
```

Pairing-PIN des Mocks: `12345678901234567890`, Host `127.0.0.1`.

## Build & Installation auf der HCU (aus Quellcode)

Voraussetzung: Docker Desktop (Linux/arm64-Unterstuetzung).

```
.\scripts\build-plugin.ps1            # erzeugt dist\bosch-hcu-bridge-<version>.tar.gz
```

HCUweb -> **Plugins** -> Datei hochladen. Nach der Installation stellt die HCU
automatisch `/TOKEN`, `/CLIENTID`, `/SGTIN` und `/data` bereit; das Plugin
verbindet sich selbsttaetig (weder Pairing noch manuelle Tokens noetig).

## Projektstruktur

```
server/
  index.js          Bootstrap (Args: pluginId hcuHost tokenFile)
  hcu-client.js     Connect-API-WebSocket-Client (Envelope, RPC, Provider)
  hmip-cache.js     Systemstate-Cache + HMIP_EVENT-Merge + Twin-Lookup
  registry.js       Plugin-Geraete: Discover-Idempotenz, Inclusion, STATUS_EVENT
  config-page.js    CONFIG_TEMPLATE (WEBLINK/READONLY/BOOLEAN) + Update
  config-store.js   /data-Persistenz (config/offered/state, atomar)
  applog.js         Log-Ring fuer WebUI
  bosch/
    index.js        BoschManager: Lifecycle, Inventar, States, Events, Pairing
    shc-client.js   mTLS-REST + Long-Poll-Events (Port-Overrides fuer Tests)
    pairing.js      Client-Zertifikat + POST/DELETE :8443/smarthome/clients
  webui/            Express-Server (REST /api/*, SSE /api/events, Static)
    public/         Build-Ausgabe des SPA (generiert, im Image enthalten)
webui-src/          React+Vite-Quellcode der WebUI
  src/              App, Dashboard, BoschDevices, Mapping, Settings, Logs, Anleitung
  vite.config.js    outDir = ../server/webui/public, Dev-Proxy /api -> :8341
scripts/
  build-plugin.ps1  Image-Build + dist/*.tar.gz
  get-dev-token.ps1 Dev-Auth-Token (Remote-Modus)
  mock-shc.js       Mock Bosch SHC (mTLS, 10 Geraete, Szenen, Events)
  mock-hcu.js       Mock HCU (Connect-API-WebSocket) fuer Tests/Demo
  demo-ui.js        Kompletter Demo-Stack (Mock-SHC + Mock-HCU + Plugin)
  smoke-mock-hcu.js Protokolltest gegen Mock-HCU
  smoke-mock-shc.js E2E-Test Pairing/Inventar/Control/Events gegen Mock-SHC
  smoke-e2e.js      Durchstich HCU <-> Plugin <-> Bosch
docs/
  PLAN-hcu-bosch-plugin.md        Architektur- und Planungsstand
  ENTWICKLUNG.md                  diese Datei
```
