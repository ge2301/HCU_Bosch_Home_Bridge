# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-11

First public release. Connects a Bosch Smart Home controller (SHC) to a
Homematic IP Home Control Unit (HCU) through the Homematic IP Connect API.

### Added

- **Connect API client** (`server/hcu-client.js`): JSON-RPC over WebSocket with
  `STARTED`/READY handshake, reconnect with backoff, plugin token auth as
  provided by the HCU.
- **System state cache** (`server/hmip-cache.js`): merges `HMIP_SYSTEM_EVENT`
  pushes, resolves `PLUGIN_EXTERNAL` twins.
- **Device registry** (`server/registry.js`): idempotent offering via
  `data/offered.json`, inclusion tracking, `STATUS_EVENT` propagation,
  parking of removed devices through `maintenance.unreach` instead of deletion
  (avoids duplicate devices on re-offer), `EXCLUSION_EVENT` handling.
- **Bosch SHC client** (`server/bosch/shc-client.js`): mTLS REST access to the
  Local API, inventory and service-state polling, long-poll event subscription
  with automatic restart, port overrides for testing.
- **Bosch pairing** (`server/bosch/pairing.js`): self-signed client certificate,
  `POST /smarthome/clients` with the user's pairing PIN, unpair via `DELETE`.
  The client id uses the mandated `oss_` prefix.
- **Mapping catalogue** (`server/mapping/`): declarative Bosch-to-HCU type
  mapping (window contact, switch, dimmer, thermostat, blind with slats, smoke
  detector, water detector, motion, push button) plus optional secondary
  devices (energy, brightness, air quality) and virtual switches for Bosch
  scenes and the alarm system.
- **Control path**: `CONTROL_REQUEST` translated to Bosch `PUT` calls, Bosch
  events forwarded as `STATUS_EVENT`; newly detected Bosch devices trigger an
  incremental re-discovery.
- **HCUweb configuration page** (`server/config-page.js`): link to the WebUI,
  live status, read-only device mapping list.
- **WebUI** (`webui-src/`, React + Vite, served by `server/webui/`): tabs for
  dashboard, Bosch devices, HCU mapping, settings and live log, plus a
  comprehensive user guide. Light and dark theme, mobile layout, optional
  WebUI PIN, server-sent-events based refresh.
- **Tooling**: `scripts/build-plugin.ps1` (arm64 image plus uploadable
  `dist/*.tar.gz`), `scripts/get-dev-token.ps1` (developer mode token),
  `scripts/mock-shc.js` (mTLS SHC simulator with scenes and events),
  `scripts/demo-ui.js` (self-contained demo: mock SHC + mock HCU + plugin),
  mock-based protocol and end-to-end smoke tests.
- **Legal**: GPL-3.0 license file, `THIRD-PARTY-NOTICES.md` for dependencies,
  font and trademark usage.

### Known limitations

- Field test against a physical HCU and a physical SHC is still pending; the
  current test evidence comes from the mock HCU and mock SHC stacks.
- Motion impulse auto-off, WRC2 edge cases, real scene/alarm endpoints and
  `powerMeterState` key matching are not yet verified against real devices.
- Bosch Home Connect appliances (washing machine and similar) are not part of
  the SHC Local API and are therefore not exposed.
- Remote access to the WebUI should be tunneled (WireGuard or similar); it is
  designed for the local network.

[0.1.0]: https://github.com/ge2301/HCU_Bosch_Home_Bridge/releases/tag/v0.1.0
