# Plan: HCU-Plugin "Bosch Smart Home Bridge"

Bosch-Smart-Home-Geräte (SHC) als native Geräte in die Homematic-IP-Home-Control-Unit (HCU) integrieren - anzeigen, steuern, konfigurieren über eigenes WebUI.

> Recherche-Basis: Connect-API-Doku 1.0.1 (Workspace `connect-api-main/`), Analyse des Beispielprojekts `HomematicFluidUI/homematic-plugin - Kopie`, offizielle Bosch-Doku `BoschSmartHome/bosch-shc-api-docs` (inkl. Postman-Collection) und `tschamm/boschshcpy` (Gerätekatalog, Praxiswissen).

---

## 1. Ziel und Lieferumfang

- **Plugin-Container** (`linux/arm64`), installierbar über HCUweb -> Plugins (Hochladen einer `.tar.gz`).
- **Brücke HCU <-> Bosch SHC** vollständig **lokal** (kein Bosch-Cloud-Zugriff):
  - Bosch-Geräte erscheinen in der HCU-Inbox, werden wie native HMIP-Geräte in Räume einsortiert und sind in Szenen/Automationen der HMIP-Welt nutzbar.
  - Statusänderungen aus Bosch werden in Echtzeit in die HCU gepusht; Bedienungen aus HCUweb/App werden an Bosch durchgereicht.
- **Eigenes WebUI** im Container (HTTP, Port wird von der HCU 1:1 nach außen gemappt): Pairing, Mapping-Verwaltung, Live-Status, Einstellungen.
- **HCUweb-Plugin-Konfigurationsseite**:
  - **WEBLINK-Eigenschaft** mit Link auf das WebUI (`http://<hcu-ip>:<port>`),
  - **READONLY-Eigenschaften** mit der Liste der zugeordneten Geräte (Bosch-Gerät -> HCU-Gerät, Typ, Status),
  - Verbindungsstatus (SHC erreichbar? N Geräte eingebunden).

### Nicht in v1
- Bosch-Kameras (eigene Kamera-API, kein passender HCU-Archetyp) - nur Auflistung im WebUI.
- Rückrichtung "Bosch-App steuert HCU-Geräte" (bietet weder Bosch-API noch HCU-API an).

### Festlegungen aus der Rueckfrage (Details in Abschnitt 12)
- pluginId `de.essers.gerrit.plugin.boschbridge`, WebUI React+Vite auf Port 8341, **voller Geraeteumfang inkl. Bonus-Geraeten, Bosch-Szenen und Alarmanlage** (Unscharfschalten optional PIN-geschuetzt).
- Kein realer Bosch-SHC vorhanden -> **Mock-SHC** als Entwicklungs-Meilenstein (M1M).

---

## 2. Rechercheergebnis A: Homematic IP Connect API (HCU-Seite)

### 2.1 Verbindung
| Thema | Fakt |
|---|---|
| Transport | WebSocket `wss://host.containers.internal:9001` (installiertes Plugin) bzw. `wss://hcu1-XXXX.local:9001` (Remote-Entwicklung) |
| Header | `authtoken`, `plugin-id`, `hmip-system-events: true` (Push-Events abonnieren) |
| Token | Installiert: Datei **`/TOKEN`** wird von der HCU beim Installieren automatisch erzeugt. Remote (Dev): Activation-Key aus HCUweb-Entwicklermodus -> `POST https://hcu1-XXXX.local:6969/hmip/auth/requestConnectApiAuthToken` -> `confirmConnectApiAuthToken` -> `authToken` + `clientId` |
| Zertifikate | HCU nutzt selbstsignierte Zertifikate -> Client-Validierung deaktivieren |
| Envelope | Jede Nachricht: `{ id (UUID), pluginId, type, body }`; Antworten verwenden die Request-`id` |
| Weitere Container-Pfade | `/CLIENTID`, `/SGTIN`, persistenter Datenordner `/data` |

### 2.2 Nachrichten
**Plugin -> HCU:** `PLUGIN_STATE_RESPONSE` (READY/CONFIG_REQUIRED/...), `DISCOVER_RESPONSE`, `STATUS_RESPONSE`, `STATUS_EVENT`, `CONTROL_RESPONSE`, `CONFIG_TEMPLATE_RESPONSE`, `CONFIG_UPDATE_RESPONSE`, `HMIP_SYSTEM_REQUEST`, `SYSTEM_INFO_REQUEST`, `CREATE/DELETE/LIST_USER_MESSAGES_REQUEST`

**HCU -> Plugin:** `PLUGIN_STATE_REQUEST`, `DISCOVER_REQUEST`, `INCLUSION_EVENT`, `EXCLUSION_EVENT`, `STATUS_REQUEST`, `CONTROL_REQUEST`, `CONFIG_TEMPLATE_REQUEST`, `CONFIG_UPDATE_REQUEST`, `HMIP_SYSTEM_RESPONSE`, `HMIP_SYSTEM_EVENT`, `SYSTEM_INFO_RESPONSE`, `ERROR_RESPONSE`, `USER_MESSAGE_ACKNOWLEDGEMENT_EVENT`

### 2.3 Geräte-Inklusion (Ablauf)
```
Plugin startet -> PLUGIN_STATE_RESPONSE {READY}
HCU  -> DISCOVER_REQUEST              (Discovery kann NUR die HCU anstossen!)
Plugin -> DISCOVER_RESPONSE { success, devices: [Device] }
HCU legt Geraete in die Inbox -> INCLUSION_EVENT { deviceIds }
Plugin -> STATUS_RESPONSE { devices: [Device inkl. Feature-Werte] }
... bei Aenderung: Plugin -> STATUS_EVENT { deviceId, features (partial) }
HCU will steuern -> CONTROL_REQUEST { deviceId, features (soll) }
Plugin -> CONTROL_RESPONSE { deviceId, success } + STATUS_EVENT (Echo)
HCU -> STATUS_REQUEST -> Plugin -> STATUS_RESPONSE (Vollstatus)
HCU -> EXCLUSION_EVENT -> Plugin sendet keinen Status mehr fuer diese Geraete
```
**Wichtige Erkenntnisse aus dem Beispielprojekt:**
- Discovery ist **idempotent** zu gestalten: bereits eingebundene Geräte erneut in `DISCOVER_RESPONSE` zu melden erzeugt Duplikate -> Registration über Marker-Datei in `/data` persistent machen; "abmelden" von Geräten über `STATUS_EVENT { type:"maintenance", unreach:true }` statt Entfernen.
- Nach Inklusion erscheint das Gerät im HCU-Systemstate als **Zwilling** mit HCU-eigener UUID (`type: "PLUGIN_EXTERNAL"`, `pluginDeviceId` = unsere ID) -> für die Geräte-Liste der Konfigseite Twins über `getSystemState` ermitteln.
- "Neue Bosch-Geräte später": Re-Discovery erreicht man durch kurzzeitiges Schließen des WebSockets (READY -> DISCOVER_REQUEST-Zyklus läuft dann erneut).

### 2.4 Device-Schema und Archetypen
`Device = { deviceId*, deviceType*, features[], firmwareVersion?, friendlyName?, modelType? }`

**HCU-Archetypen (DeviceType) mit Required/Optional-Features (relevanten):**
| Archetyp | Required | Optional |
|---|---|---|
| `CONTACT_SENSOR` | contactSensorState | maintenance |
| `SWITCH` | switchState | onTime, maintenance |
| `LIGHT` | switchState | dimming, color, colorTemperature, onTime, maintenance |
| `THERMOSTAT` | setPointTemperature | actualTemperature, humidity, co2, maintenance |
| `WINDOW_COVERING` | shutterLevel | slatsLevel, shutterDirection, maintenance |
| `OCCUPANCY_SENSOR` | presenceDetected | maintenance |
| `SMOKE_ALARM` | smokeAlarm | maintenance |
| `WATER_SENSOR` | waterlevelDetected | moistureDetected, maintenance |
| `SWITCH_INPUT` | - (Button) | maintenance |
| `CLIMATE_SENSOR` | - | actualTemperature, humidity, illumination, co2, raining, ... |
| `ENERGY_METER` | currentPower | energyCounter, maintenance |

Feature-Wert-Formate (Auszug): `switchState {on}`, `contactSensorState {triggered}`, `shutterLevel {shutterLevel: 0..1, 1=zu}`, `slatsLevel {slatsLevel}`, `shutterDirection {shadingDirection: DARKER|LIGHTER}`, `dimming {dimLevel}`, `maintenance {unreach, ...}` -> je Feature exakt in Doku 6.7, beim Implementieren abgleichen.

### 2.5 HCU steuern/monitoren (falls benötigt)
- `HMIP_SYSTEM_REQUEST { path, body }` -> `HMIP_SYSTEM_RESPONSE { code, body }`; z. B. `/hmip/home/getSystemState`, `/hmip/device/control/setSwitchState`.
- Push: Header `hmip-system-events: true` -> `HMIP_SYSTEM_EVENT` (DEVICE_CHANGED, GROUP_CHANGED, HOME_CHANGED, ...) -> SystemState-Cache inkrementell führen.
- `SYSTEM_INFO_REQUEST` -> **`ipAddress` der HCU** -> ideal für den WEBLINK (Fallback: SGTIN-Ende aus `/SGTIN` -> `http://hcu1-xxxx.local:<port>`).

### 2.6 Konfigurationsseite (HCUweb)
- `CONFIG_TEMPLATE_REQUEST` -> `CONFIG_TEMPLATE_RESPONSE { groups, properties }`; `properties` = Map aus `PropertyTemplate` (`dataType`, `friendlyName`, `currentValue`, `description`, `groupId`, `order`, `pattern`, `values`, `min/max` ...).
- **dataType-Arten:** `STRING, PASSWORD, BOOLEAN, INTEGER, NUMBER, ENUM, TYPEAHEAD, READONLY, QRCODE, WEBLINK`.
- **WEBLINK:** `currentValue` = URL, `defaultValue` = Linktext/Info -> **genau damit entsteht der gewünschte Link zur WebUI auf der Plugin-Konfigurationsseite** (im Beispielprojekt bewährt).
- READONLY-Eigenschaften eignen sich, um dort **die Liste der zugeordneten Geräte anzuzeigen** (Snapshot beim Öffnen des Dialogs; live nur im eigenen WebUI).
- `CONFIG_UPDATE_REQUEST { properties }` -> anwenden -> `CONFIG_UPDATE_RESPONSE { status: APPLIED|PENDING|..., message }` (PENDING-Muster für mehrstufige Konfig, z. B. Pairing mit Tastendruck).
- **Kein Iframe-/Page-Embedding** in HCUweb möglich - eigene Seiten immer über WebUI + WEBLINK.

### 2.7 Container-Anforderungen
- `linux/arm64`; Base-Image-Empfehlung `ghcr.io/homematicip/alpine-node-simple` (vom Beispielprojekt genutzt, Node-basiert).
- Image-Label **`de.eq3.hmip.plugin.metadata`** (JSON): `pluginId, issuer, version, hcuMinVersion (1.4.7), scope: "LOCAL", friendlyName {de,en}, description, image (Base64-Logo), settings [], changelog, logsEnabled`.
- Distribution: `docker save <img> | gzip > <name>-<version>.tar.gz` -> HCUweb-Upload.
- `EXPOSE` nur Ports **> 1024**, ausgenommen 1883/6969/8428/8888/9000/9001/9293/9294/26969 (tcp) und 5353/43439 (udp) -> **WebUI-Port-Vorschlag: 8341** (HCU mappt 1:1 nach außen).
- ENTRYPOINT-Konvention: `["node","server/index.js","<pluginId>","host.containers.internal","/TOKEN"]`.

---

## 3. Rechercheergebnis B: Bosch Smart Home Controller (SHC)

### 3.1 Kommunikation
| Thema | Fakt |
|---|---|
| REST-API | `https://<shc-ip>:8444/smarthome/...` (mTLS: **TLS-Client-Zertifikat** erforderlich; selbstsignierte Server-Zertifikate) |
| Registrierung | `POST https://<shc-ip>:8443/smarthome/clients` mit Header **`Systempassword: base64(Systemkennwort)`**, Body `{ "@type":"client", "id":"oss_<name>", "name":"OSS <name>", "primaryRole":"ROLE_RESTRICTED_CLIENT", "certificate":"<selbst erzeugtes, selbstsigniertes 2048-Bit-Zertifikat>" }`. **Reihenfolge: erst Front-Taste am SHC drücken (Controller II: kurz, bis LEDs blinken; älteres Modell: lang halten), dann Request senden.** |
| Öffentlich | `GET https://<shc-ip>:8446/smarthome/public/information` (ohne Auth; Erreichbarkeits-/Versionscheck) |
| Events | Long-Polling JSON-RPC an `https://<shc-ip>:8444/remote/json-rpc`: `[{"jsonrpc":"2.0","method":"RE/subscribe","params":["com/bosch/sh/remote/*", null]}]` -> pollId; dann Dauerschleife `RE/longPoll [pollId, 30]`; Ende mit `RE/unsubscribe`. State-Pushes kommen mit Topic `smarthome/devices/<id>/services/<service>/state` |
| Ressourcen | `/smarthome/devices`, `/rooms`, `/groups`, `/scenarios` (+ `POST /scenarios/{id}/triggers`), `/messages`, `/userdefinedstates`, `/doors-windows/openwindows`; Intrusion: `/intrusion/states/system`, `/intrusion/actions/arm|disarm|mute` |
| Geräte-State | `GET /devices/{id}/state` (alle Services) bzw. `GET/PUT /devices/{id}/services/{serviceId}/state` |
| Best Practice (Bosch) | Long-Polling statt Short-Polling; Request-Rate begrenzen; bei Abbruch neu abonnieren; aggressive Poll-Intervalle vermeiden |
| Cloud | Cloud-Connect-API wurde eingestellt -> **lokale API ist der einzige offizielle Weg** |

### 3.2 Rechtliche Rahmenbedingungen (wichtig!)
Bosch-Local-API-Nutzung laut Nutzungsbedingungen: **nur privat, nicht kommerziell**; Client-ID/Name **muss mit `oss_` beginnen**; Rolle `ROLE_RESTRICTED_CLIENT`; Doku steht unter CC BY-NC-ND. -> Plugin als kostenloses Open Source ist konform; Verkauf/commerzielle Nutzung nicht. Bosch-Logos / "works with Bosch" nicht verwenden.

### 3.3 Bosch-Gerätekatalog (Model-Keys, Stand boschshcpy 0.6.x)
Fenster-/Türkontakt `SWD / SWD2 / SWD2_PLUS / SWD2_DUAL`, Rollladenaktor `BBL / MICROMODULE_SHUTTER / MICROMODULE_AWNING / MICROMODULE_BLINDS` (Behang + Kippen), `PSM` (Smart Plug), `PLUG_COMPACT(_DUAL)`, Lichtschalter `BSM`, Unterputz-Module `MICROMODULE_LIGHT_CONTROL / _ATTACHED / _DIMMER / _RELAY`, Rauchmelder `SD / SMOKE_DETECTOR2 (+ SMOKE_DETECTION_SYSTEM)`, Thermostate `TRV / TRV_GEN2(_DUAL)`, Wandthermostate `THB / BWTH / BWTH24 / RTH2_BAT / RTH2_230`, Raumklima-Gruppen `ROOM_CLIMATE_CONTROL`, Bewegungsmelder `MD / MD2 (+M)`, Universal-Taster `WRC2 / SWITCH2`, Wassermelder `WLS`, `TWINGUARD` (Rauch + Luftgüte), Sirenen `OUTDOOR_SIREN`, Kameras `CAMERA_EYES / 360 / OUTDOOR`, LEDVANCE/Hue-Lampen (via SHC), `HEATING_CIRCUIT`, `BOILER`.

**Services (State-Dienste je Gerät):** `ShutterContact`, `ShutterControl` (position 0..1 + driveState), `BlindsControl`/`BlindsSceneControl` (angle), `PowerSwitch` (switchState ON/OFF), `PowerMeter` (currentPower W, energyCounter), `MultiLevelSwitch` (level 0..1), `RoomClimateControl` (setpointTemperature, actualTemperature, ventilationState, operationMode, enable, openWindowDetected, ...), `TemperatureLevel`, `HumidityLevel`, `LatestMotion`, `MultiLevelSensor` (Helligkeit), `Keypad` (Tastenerkennung WRC2), `SmokeDetectorCheck`/`DetectionTest`, `BatteryLevel`, `WaterLeakageSensor` (+`WaterLeakageSensorTilt`), `AirQualityLevel` (Twinguard), `Bypass` (Kontakt II), `VibrationSensor` (Kontakt II Plus), `PrivacyMode` (Kamera), `HeatingCircuit`, ...

---

## 4. Geräte-Mapping Bosch -> HCU (Design)

Primärzuordnung (ein Bosch-Gerät -> ein HCU-Gerät). Bonus-Geräte (Meter/Zweit-Sensor) optional per Schalter im WebUI, da ein Bosch-Gerät nur auf **einen** Archetyp abgebildet werden kann:

| Bosch-Gerät | Bosch-Service -> Wert | HCU-Typ | HCU-Features (Status) | Steuerung (CONTROL_REQUEST -> Bosch PUT) |
|---|---|---|---|---|
| Fenster-/Tuerkontakt (SWD/SWD2...) | ShutterContact (OPEN/CLOSED); BatteryLevel | `CONTACT_SENSOR` | contactSensorState `{triggered: state==="OPEN"}`; maintenance (Batterie/unreach) | - |
| Rollladen (BBL, MicroModule Shutter/Awning) | ShutterControl (position, driveState) | `WINDOW_COVERING` | shutterLevel (Konvention identisch: 1 = zu) | shutterLevel -> `{"@type":"shutterControlState","level":x}`; Stopp via operationState STOPPED |
| Jalousie (MICROMODULE_BLINDS) | + BlindsControl (angle) | `WINDOW_COVERING` | + slatsLevel | shutterLevel + slatsLevel (blindsControlState.targetAngle) |
| Stecker/Lichtschalter (PSM, PLUG_COMPACT, BSM, MicroModule Relay/Light) | PowerSwitch | `SWITCH` | switchState `{on}` | `{"@type":"powerSwitchState","switchState":"ON"/"OFF"}` |
| Dimmer (MICROMODULE_DIMMER), Hue/LEDVANCE | MultiLevelSwitch | `LIGHT` | switchState + dimming `{dimLevel}` | multiLevelSwitchState (0 = aus) |
| Thermostate (TRV...RTH2) | RoomClimateControl | `THERMOSTAT` | setPointTemperature, actualTemperature, humidity (falls vorhanden), maintenance | climateControlState {setpointTemperature} |
| Rauchmelder (SD/SMOKE_DETECTOR2) | SmokeDetectorCheck / Alarm | `SMOKE_ALARM` | smokeAlarm, maintenance | - |
| Twinguard | SmokeDetectorCheck (+ AirQualityLevel) | `SMOKE_ALARM` | smokeAlarm; optional Zweit-Geraet `PARTICULATE_MATTER_SENSOR` | - |
| Bewegungsmelder (MD/MD2) | LatestMotion (Impuls!) | `OCCUPANCY_SENSOR` | presenceDetected + zeitgesteuerte Ruecksetzung (~10 s, da Bosch keinen "keine Bewegung"-State liefert) | - |
| Wassermelder (WLS) | WaterLeakageSensor (+Tilt) | `WATER_SENSOR` | waterlevelDetected, maintenance | - |
| Universal-Taster/Wandschalter (WRC2/SWITCH2) | Keypad (lastKeyEvents) | `SWITCH_INPUT` (Fallback: `SWITCH` mit 1-s-Impuls) | Tastendruck -> Event | siehe Risiko R3 |
| (optional) Bosch-Szenen | Scenario | `SWITCH` (virtuell) | switchState nach Trigger + Auto-Off | switchState=on -> `POST /scenarios/{id}/triggers` |
| (optional) Alarmanlage | /intrusion/states/system | `SWITCH` | switchState = scharf | on/off -> arm/disarm |
| (optional) Energy-Metering zu PSM/BSM/... | PowerMeter | `ENERGY_METER` (Zweit-Gerät "... (Energie)") | currentPower, energyCounter | - |
| Kameras | - | **nicht abgebildet** (nur WebUI-Liste) | | |

Die Mapping-Tabelle wird **deklarativ** in `mapping/catalog.js` gepflegt: `{ boschType, matchServices, hcu: { deviceType, mapState(serviceJson), control(featureJson) } }` -> neuer Gerätetyp = eine Tabellenzeile.

---

## 5. Architektur

```
+---------------- HCU ----------------+      +----------- Container: hcu-bosch-bridge -----------+
| HCUweb / HMIP-App / Szenen-Logik    | wss  | +--------------+  +-----------+  +--------------+ |  mTLS   +--------+
| Connect API :9001 ----------------------+->| hcu-client.js  |->| registry/ |->| bosch/       |-+------->| Bosch  |
|  Discover/Include/Control/SystemState|     | Connect-WS +   |  | mapper    |  | shc-client + |+-------- | SHC    |
|  getSystemState / HMIP-Events       |      | hmip-cache     |  | (Bosch<-> |  | pairing +   |  :8444/  | :8443/ |
+-------------------------------------+      +--------------+  |  HCU)     |  | longpoll    |   8443     | 8444/  |
        ^                                                      +-----------+  +--------------+   :8446    |  8446  |
        | WEBLINK: http://<hcu-ip>:8341                          |        ^                            +--------+
        +---- Browser ------> Express :8341 (SPA + REST + SSE)  |        |  Event-Bus
                                                /data (persist, persistent ueber Updates)
```

### Module (Node.js >= 20, CommonJS, bewusst ohne Transpilierung)
```
hcu-bosch-bridge/
|-- Dockerfile                     # arm64 Multi-Stage, LABEL, EXPOSE 8341
|-- package.json                   # ws, uuid, express, selfsigned (Pairing-Zertifikate), ...
|-- server/
|   |-- index.js                   # Bootstrap (Args wie Beispiel: pluginId host /TOKEN; DATA_DIR)
|   |-- hcu-client.js              # WS-Client: READY, RPC-Map (HMIP_SYSTEM_REQUEST, Timeout 15 s),
|   |                              #   Reconnect 3 s, Provider fuer DISCOVER/CONFIG_TEMPLATE,
|   |                              #   Handler CONTROL/STATUS/INCLUSION/EXCLUSION/CONFIG_UPDATE
|   |-- hmip-cache.js              # getSystemState-Cache + HMIP_SYSTEM_EVENT-Merge (Twin-Erkennung PLUGIN_EXTERNAL)
|   |-- bosch/shc-client.js        # mTLS-REST (cert/key-Agent), Retry, Rate-Limit, Geraete-Enumerator
|   |-- bosch/pairing.js           # Zertifikat erzeugen (selfsigned), Register-Flow (8443, Systempassword-Header),
|   |                              #   Status-Machine fuer WebUI-Wizard ("Taste druecken" -> PENDING)
|   |-- bosch/longpoll.js          # RE/subscribe/longPoll-Loop, Re-Subscribe mit Backoff, Topic -> Service-Event-Bus
|   |-- mapping/catalog.js         # Mapping-Tabelle (Abschnitt 4)
|   |-- mapping/mapper.js          # Bosch-State -> IFeature[] ; ControlRequest -> Bosch-PUT ; Deadband
|   |-- registry.js                # angebotene Geraete (persist.), Idempotenz-Marker, Excluded-Set, Twin-Map,
|   |                              #   unreach-Parken deaktivierter Geraete
|   |-- config-store.js            # /data/config.json + AES-256-GCM fuer Systemkennwort (optional)
|   |-- webui/server.js            # Express: Static SPA + REST + SSE; optionale PIN-Auth
|   `-- webui/api.js               # Endpoints siehe Abschnitt 6
|-- frontend/                      # Vite+React SPA (bewaehrter Stack aus dem Beispielprojekt)
`-- scripts/build-plugin.ps1       # docker build --platform=linux/arm64; docker save|gzip -> bosch-hcu-bridge-<v>.tar.gz
```

### Persistenz in `/data`
`config.json` (SHC-IP, Flags, PIN-Hash), `bosch/cert.pem|key.pem` (0600), `offered-devices.json` (Idempotenz), `mapping-overrides.json` (enabled,umbenannt,Bonus-Flags), `log.jsonl` (rotierend), ggf. `systempassword.enc`.

---

## 6. WebUI (Port 8341)

**Seiten:**
1. **Dashboard** - SHC-Verbindung (Public-Info-Ping), Pairing-Status, Plugin-Status (READY/CONFIG_REQUIRED), Anzahl eingebundener/geparkter Geräte, Log-Auszug.
2. **Pairing-Wizard** - SHC-IP -> Verbindungstest -> Kennwort -> Anleitung "Taste drücken" -> `POST /api/bosch/pair` -> PENDING-Fenster -> Erfolg/Fehler; Re-Pairing/Entfernen (Zertifikat löschen + Hinweis auf Client-Verwaltung in der Bosch-App).
3. **Geräte & Mapping** - Tabelle: Bosch-Gerät (Name, Raum, Typ) | HCU-Typ (auto) | an/aus "in HCU anbieten" | Umbenennen | Live-Status | Test-Stellen | Zwilling-Status (in HCU eingebunden? Raum?).
4. **Einstellungen** - Bonus-Geräte (Energie/Zweit-Sensoren) je Kategorie, Impuls-Längen (Bewegungsmelder/Taster), Fallback-Poll-Intervall, Log-Level, WebUI-PIN.
5. **Live-Ereignisse** - SSE-Stream `GET /api/events` (Statusänderungen in beide Richtungen, Control-Audit-Log).

**REST:** `GET /api/status` - `GET /api/bosch/devices` - `POST /api/bosch/pair` - `DELETE /api/bosch/pair` - `PATCH /api/mapping/:boschId` - `POST /api/test/:boschId` - `GET /api/logs` - `GET /api/events (SSE)`

Kameras/Szenen: nur lesende Auflistung.

---

## 7. HCUweb-Konfigurationsseite (konkretes Template)

Gruppen & Eigenschaften (bei jedem `CONFIG_TEMPLATE_REQUEST` frisch generiert):

| Gruppe | Eigenschaft | dataType | Inhalt |
|---|---|---|---|
| **WebUI** | `webui_link` | `WEBLINK` | `currentValue: http://<hcu-ip-aus-SYSTEM_INFO>:8341` (Fallback `hcu1-<sgtin4>.local`), `defaultValue: "Bosch-Bridge WebUI oeffnen"` |
| **Verbindung** | `bosch_status` | `READONLY` | "Verbunden - SHC 192.168.x.x - 23 Gerate" bzw. "Nicht gepairt - WebUI oeffnen" |
| | `plugin_status` | `READONLY` | "READY - 18 Gerate eingebunden, 3 geparkt" |
| **Zugeordnete Gerate** | `map_<boschId>` je Geraet | `READONLY` | friendlyName = Bosch-Name; currentValue = "-> HCU: <Zwillingsname> (<Raum>) - WINDOW_COVERING - Position 0 %" |
| **Einstellungen** (Auszug) | `enableEnergySensors`, `motionImpulseSeconds` | `BOOLEAN` / `INTEGER` | sofort wirksam (ConfigUpdateResponse APPLIED) |

`CONFIG_UPDATE_REQUEST` -> speichern -> `CONFIG_UPDATE_RESPONSE {status:"APPLIED"}`.

---

## 8. Betriebs-Abläufe

1. **Erster Start:** kein Pairing -> `PLUGIN_STATE_RESPONSE {CONFIG_REQUIRED}`; WebUI und Konfigseite verweisen auf Wizard.
2. **Nach Pairing:** `READY` -> `getSystemState` (Twin-Ermittlung) -> Bosch-Geräte enumerieren -> auf `DISCOVER_REQUEST` antworten (nur aktive; deaktivierte als `unreach` geparkt -> kein Duplikat-Risiko beim Re-Aktivieren) -> `INCLUSION_EVENT` -> Vollstatus senden.
3. **Laufend:** Long-Poll-Event -> Mapper -> `STATUS_EVENT` (Deadband gegen Flattern); `CONTROL_REQUEST` -> Bosch-PUT (Timeout 10 s) -> `CONTROL_RESPONSE` + Echo-`STATUS_EVENT`; Long-Poll-Fehler -> Backoff + Re-Subscribe + kurzer Full-Resync `GET /devices`.
4. **SHC offline:** alle Twins via `maintenance.unreach=true`; WebUI-Statusseite; Auto-Recover.
5. **Neue Bosch-Geräte:** WebUI-Button "Erneut entdecken" -> WS-Reconnect (triggert neuen Discovery-Zyklus).
6. **Plugin-Update:** Container-Neustart; alles aus `/data`; Bosch-Zertifikat bleibt gültig -> kein erneuter Tastendruck nötig.

---

## 9. Packaging & Deployment

- Dockerfile (Multi-Stage): Stage 1 Node-Build (`vite build`); Stage 2 Runtime `ghcr.io/homematicip/alpine-node-simple`, `npm ci --omit=dev`, `EXPOSE 8341`, `ENV DATA_DIR=/data`, `ENTRYPOINT ["node","server/index.js","<pluginId>","host.containers.internal","/TOKEN"]`.
- Label `de.eq3.hmip.plugin.metadata`: `pluginId`, `issuer`, `version`, `hcuMinVersion:"1.4.7"`, `scope:"LOCAL"`, `friendlyName {de:"Bosch Smart Home Bridge", en:...}`, `description`, `image` (Base64-Logo), `logsEnabled:true`.
- Build (Docker Desktop, Windows) mit `--platform=linux/arm64` -> `docker save | gzip` -> `bosch-hcu-bridge-1.0.0.tar.gz` -> HCUweb -> Plugins.
- **Versionsbump = Label-Version UND Dateiname.**

## 10. Meilensteine & Teststrategie

| Phase | Inhalt | Abnahmekriterium |
|---|---|---|
| M0 | Projektgerüst, `hcu-client.js` (verallgemeinert aus Beispiel), Dockerfile, Build-Script | Plugin erscheint im **Remote-Modus** (Developer-Mode) auf der HCUweb-Plugin-Seite mit READY |
| M1 | Bosch-Client + Pairing (Testskript + `selfsigned`) | `GET /devices` gegen echten SHC liefert Geräteliste |
| M2 | Mapping-Catalog + Mapper (Unit-Tests mit JSON-Fixtures) | Fixture-Tests State/Control grün |
| M3 | Discovery/Inclusion/Control/Status E2E (1 Kontakt, 1 Rollladen, 1 Stecker, 1 TRV) | Geräte in HCU-Inbox -> Raum -> Bedienung in beide Richtungen |
| M4 | WebUI-SPA + REST/SSE + Pairing-Wizard + Mapping-Verwaltung | Pairing komplett ohne manuelle Dateien möglich |
| M5 | HCUweb-Konfigseite (WEBLINK + READONLY-Geräteliste + Einstellungs-Props) | Link funktioniert; Geräteliste korrekt |
| M6 | Restliche Gerätetypen + Bonus-Geräte + Edge-Cases (SHC offline, WRC2, MD2-Impuls) | Alle Typen aus Abschnitt 4 verifiziert |
| M7 | Feinschliff: Log-Ring, User-Messages bei Fehlern (`CreateUserMessageRequest`), README/Installations-Doku | Upload-reif |
| M8 | Release-Build 1.0.0 + Installation auf echter HCU | Dauerbetrieb stabil (>= 24 h), keine Duplikate nach Neustarts/Updates |

**Testinfrastruktur:** HCU-seitig: Remote-Modus (Developer-Mode + selbst erzeugtes Auth-Token) -> Entwicklung ohne Container-Rebuild. Bosch-seitig: **Mock-SHC** (lokaler HTTPS-Server mit mTLS und JSON-Fixtures + simulierten Long-Poll-Events), damit M2/M3 auch ohne Hardware laufen.

## 11. Risiken / offene technische Punkte

| # | Risiko | Maßnahme |
|---|---|---|
| R1 | **Bosch-ToS: nur privat/nicht-kommerziell, `oss_`-Pflicht** | OSS-Distribution kostenlos; Bosch-Client-Id `oss_hcu-bosch-bridge`; kein Bosch-Branding |
| R2 | Discovery nur HCU-gesteuert -> neue Bosch-Geräte erst nach Reconnect | Reconnect-Button + automatische Neu-Discovery bei Geräteliste-Änderung |
| R3 | **`SWITCH_INPUT`-Triggerverhalten ist in der Doku nicht im Detail beschrieben** (Required-Features: keine; unklar wie Tastensignal in HMIP-System gelangt) | In M6 gegen echte HCU verifizieren; Fallback: `SWITCH` mit kurzem Impuls (szene-tauglich) |
| R4 | MD/MD2 senden nur "Motion"-Impuls ohne Rückfall | zeitgesteuerte Selbst-Zurücksetzung (Default 10 s, konfigurierbar) |
| R5 | Ein Bosch-Gerät -> nur ein HCU-Archetyp (z. B. PSM: Schalter ODER Energie) | Aktor hat Priorität; optionale Zweit-Geräte |
| R6 | Selbstsignierte Zertifikate beidseits | `rejectUnauthorized:false` bewusst + Hinweis im WebUI |
| R7 | Bosch-API kann sich ohne Ankündigung ändern | API-Versions-Ping; User-Message bei API-Fehlern |
| R8 | HCU-Ressourcen (USB-Stick, ARM-CPU) begrenzt | schlanker Runtime-Stack; Frontend-Build nur im Builder-Stage |

## 12. Entscheidungen (geklaert)

| # | Frage | Entscheidung |
|---|---|---|
| 1 | pluginId | **`de.essers.gerrit.plugin.boschbridge`**, Issuer "Gerrit Essers"; Bosch-Client-Id zusaetzlich `oss_hcu-bosch-bridge` (ToS-Pflicht) |
| 2 | WebUI-Stack | **React + Vite SPA** (wie Beispielprojekt), Express liefert Build + REST + SSE auf Port 8341 |
| 3 | Geraete-Umfang v1 | **Vollumfang**: Kern-Geraetetypen + Bonus-Geraete (Energie-Meter, Twinguard-Luftguede, Helligkeits-Zweitgeraete) + **Bosch-Szenen** und **Alarmanlage** als virtuelle HCU-Schalter |
| 4 | Alarmanlage scharf/unscharf | **Beides per HCU-Schalter**, mit WebUI-Option "PIN-Pflicht fuer Unscharfschalten" (PIN im WebUI gesetzt; ohne korrekten PIN verweigert das Plugin `CONTROL_REQUEST` auf "aus") |
| 5 | Testumfeld | **Reale HCU vorhanden** (Remote-Mod/Developer-Mode fuer M0/M3/M5); **kein Bosch-SHC** -> Pflicht-Meilenstein **M1M: Mock-SHC** (Node/mTLS-HTTPS-Server mit Pairing-Flow, /devices-Fixtures, RE/longPoll-Event-Simulation, Szenen + Intrusion) fuer M2-M7; spaeter Feldtest an realer Hardware |
| 6 | WebUI-Sprache | Deutsch zuerst, Textstrang i18n-ready (en folgt) |
| 7 | Projektordner | `c:\Users\ge230\Documents\Homematic\Bosch\hcu-bosch-bridge` |
| 8 | WebUI-Port | **8341** (HCU-allowlist-konform, >1024, nicht auf der Blacklist) |

### Anpassung Meilenstein-Plan durch Entscheidung 5
- **M1M (Mock-SHC)** wird zwischen M1 und M2 eingeschoben und ist Startvoraussetzung fuer M2/M3-Tests. Der produktive `bosch/shc-client.js` wird gegen den Mock AND gegen die echte API getestet (identische Spec aus `bosch-shc-api-docs`/Postman-Collection; Fixtures aus `boschshcpy`).
- Alarmanlagen-PIN: PinHash in `/data/config.json`; Pruefung im Plugin vor `disarm`; Status-Anzeige im WebUI + HCUweb READONLY.

