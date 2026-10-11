# hcu-bosch-bridge

HCU-Plugin: **Bosch Smart Home Bridge** – bindet Geraete des Bosch Smart Home Controllers (SHC)
lokals als native Gerate in das Homematic IP System (HCU) ein.

Grundlage: Homematic IP **Connect API 1.0.1** (WebSocket) und die offizielle
**Bosch SHC Local API** (mTLS-REST, Long-Polling). Details im
[PLAN-hcu-bosch-plugin.md](../PLAN-hcu-bosch-plugin.md).

## Status

**Meilensteine M0–M3 abgeschlossen** (Tests: 14 Unit + 17 Mock-HCU + 17 Mock-SHC + 20 E2E, alle gruen):

- [x] Connect-API-Client (READY, Discover/Status/Control/Config-Flows, Reconnect)
- [x] HMIP-Systemstate-Cache mit Twin-Erkennung (PLUGIN_EXTERNAL)
- [x] Geraete-Registry mit Idempotenz-Marker und unreach-Parking
- [x] HCUweb-Konfigseite: WEBLINK zur WebUI, Status, READONLY-Zuordnungsliste
- [x] WebUI-Geruest (Express, Status-API, Logs, SSE) auf Port 8341
- [x] Dockerfile (arm64) + Build-Skript + Dev-Token-Skript
- [x] **Bosch SHC-Client** (`server/bosch/shc-client.js`): mTLS-REST, Inventar,
      Service-States, Long-Poll-Events (RE/subscribe + RE/longPoll) mit Auto-Restart
- [x] **Pairing** (`server/bosch/pairing.js`): selbstsigniertes Client-Zertifikat,
      `POST :8443/smarthome/clients`, `oss_`-Pflicht durchgesetzt, Unpair per DELETE
- [x] **BoschManager** (`server/bosch/index.js`): Verbinden -> Inventar -> States ->
      Events; Retry (60 s); WebUI-Endpunkte `/api/bosch/status|devices|pair|unpair|refresh|control`
- [x] **Mock-SHC** (`scripts/mock-shc.js`): echter HTTPS-Stack mit mTLS, Pairing,
      10 Geraeten (Heizkoerper, Steckdose, Fensterkontakt, Rollladen, Twinguard,
      Alarmsirene, Zwischenstecker, Bewegungs- und Wassermelder), Locations-Baum,
      Long-Poll-Events, `--tick` fuer simulierte Aktivitaet
- [x] **M2 Mapping-Katalog** (`server/mapping/`): deklarative Typzuordnung
      (Kontakt, Schalter, Dimmer/Licht, Thermostat, Rollladen+Lamellen, Rauch,
      Wasser, Bewegung, Taster/SWITCH_INPUT mit Fallback), Bonus-Zweitgeraete
      (Energie/Helligkeit/Luftguete) per Schalter, **Szenen** und **Alarmanlage**
      als virtuelle HCU-Schalter; 14 Unit-Tests (`npm test`)
- [x] **M3 Pipeline**: Bosch-Ereignisse -> STATUS_EVENT an die HCU;
      CONTROL_REQUEST -> Bosch-PUT (inkl. Szenen-Trigger und Alarm scharf/unscharf);
      neue Bosch-Geraete loesen automatische Neu-Discovery aus (idempotent,
      nur das neue Geraet wird nachgereicht)
- [x] **M4 React-WebUI** (`webui-src/`, Vite-Build nach `server/webui/public`):
      Dashboard (HCU-/Bosch-Status, Pairing-Wizard), Bosch-Geräte inkl. Direktschalten,
      HCU-Zuordnung mit Aktivieren/Parken, Einstellungen (Funktionsschalter,
      Bewegungs-Impulsdauer, WebUI-PIN), Live-Protokoll; SSE-gesteuerte Aktualisierung;
      Deep-Link-Fallback im Express-Server
- [ ] M5/M6: Feldtest an echter HCU, Edge-Cases (Bewegungsimpuls-AutoOff, WRC2,
      reale Szenen-/Alarm-Endpunkte, powerMeterState-Key-Matching)

### Smoke-Tests

```
npm test                              # Mapping-Katalog Unit-Tests
node scripts/smoke-mock-hcu.js        # HCU-Protokollstrecke (Mock-HCU-WebSocket)
node scripts/smoke-mock-shc.js        # Bosch-Strecke: Pairing, Inventar, Control, Events
node scripts/smoke-e2e.js             # Kompletter Durchstich HCU <-> Plugin <-> Bosch
node scripts/mock-shc.js --tick       # Mock-SHC manuell starten (PIN 12345678901234567890)
```

Tests der WebUI-API (Server muss laufen): `/api/status|devices|settings|pin|logs`
werden über `scripts/smoke-e2e.js` bzw. manuell gegen `http://localhost:8341` geprüft.

## Entwicklung (Remote-Modus gegen echte HCU)

1. HCUweb: Entwicklermodus aktivieren, Connect-API-WebSocket freigeben.
2. Aktivierungscode erzeugen, dann:
   `.\scripts\get-dev-token.ps1 -HcuHost hcu1-XXXX.local -ActivationKey ABCDEF`
3. `npm install`
4. `node server/index.js de.essers.gerrit.plugin.boschbridge hcu1-XXXX.local ./data/dev-authtoken.txt`
5. HCUweb -> Plugins: Plugin erscheint, READY. Konfiguration-Dialog zeigt
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

## Build & Installation auf der HCU

Voraussetzung: Docker Desktop (Linux/arm64-Unterstuetzung).

```
.\scripts\build-plugin.ps1            # erzeugt dist\bosch-hcu-bridge-<version>.tar.gz
```

HCUweb -> **Plugins** -> Datei hochladen. Nach der Installation stellt die HCU
automatisch `/TOKEN`, `/CLIENTID`, `/SGTIN` und `/data` bereit; das Plugin
verbindet sich selbsttaetig (weder Pairing noch manuelle Tokens noetig).

## Bosch-Pairing

Bosch verlangt ein TLS-Client-Zertifikat und einen Tastendruck am Controller:

1. WebUI oeffnen (Link auf der HCUweb-Pluginseite) -> Bosch-Pairing.
2. IP/Hostname des SHC + Pairing-PIN (aus der Bosch Companion App:
   Einstellungen -> Systemsteuerung -> Systemdaten -> Pairing-PIN) eingeben.
3. Pairingstaste am Controller druecken (leuchtet), dann "Pairen".
4. Zertifikat + Key liegen unter `/data/bosch/`, die Client-Id lautet
   `oss_hcu-bosch-bridge` (Bosch-ToS: Client-Id muss mit `oss_` beginnen).

**Rechtlicher Hinweis:** Die Bosch Local API ist laut Nutzungsbedingungen nur fuer
private, nicht-kommerzielle Nutzung zugaendlich; die Verteilung dieses Plugins
erfolgt entsprechend kostenlos als Open Source.

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
  src/              App, Dashboard, BoschDevices, Mapping, Settings, Logs
  vite.config.js    outDir = ../server/webui/public, Dev-Proxy /api -> :8341
scripts/
  build-plugin.ps1  Image-Build + dist/*.tar.gz
  get-dev-token.ps1 Dev-Auth-Token (Remote-Modus)
  mock-shc.js       Mock Bosch SHC (mTLS, 10 Geraete, Szenen, Events)
  smoke-mock-hcu.js Protokolltest gegen Mock-HCU
  smoke-mock-shc.js E2E-Test Pairing/Inventar/Control/Events gegen Mock-SHC
```

## Lizenz

Apache-2.0 (Code). Connect-API-Doku (c) eQ-3 AG; Bosch-API-Doku (c) Robert
Bosch Smart Home GmbH (CC BY-NC-ND) – jeweils nur Referenz, nicht Teil dieses
Pakets.
