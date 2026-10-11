# hcu-bosch-bridge - HCU plugin container image
# Build (from repo root, on a machine with Docker):
#   docker build --platform=linux/arm64 -t bosch-hcu-bridge:0.1.0 .
#   docker save bosch-hcu-bridge:0.1.0 -o bosch-hcu-bridge-0.1.0.tar   (+ gzip -> .tar.gz)
# Milestone M4 adds a frontend build stage (Vite/React) that replaces
# server/webui/public with the SPA bundle.

FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server/ ./server/

ENV DATA_DIR=/data
ENV WEBUI_PORT=8341

# HCU maps exposed ports 1:1 to the LAN (Connect API docs 4.3; must be >1024)
EXPOSE 8341

ENTRYPOINT ["node", "server/index.js", "de.essers.gerrit.plugin.boschbridge", "host.containers.internal", "/TOKEN"]

# Plugin manifest read by HCUweb (Connect API docs 4.1)
LABEL de.eq3.hmip.plugin.metadata=\
'{\
  "pluginId": "de.essers.gerrit.plugin.boschbridge",\
  "issuer": "Gerrit Essers",\
  "version": "0.1.0",\
  "hcuMinVersion": "1.4.7",\
  "scope": "LOCAL",\
  "friendlyName": { "en": "Bosch Smart Home Bridge", "de": "Bosch Smart Home Bridge" },\
  "description": {\
    "en": "Integrates Bosch Smart Home devices into your Homematic IP system via the local SHC API.",\
    "de": "Bindet Bosch Smart Home Ger\u00e4te \u00fcber die lokale SHC-API in das Homematic IP System ein."\
  },\
  "settings": [],\
  "changelog": "Version 0.1.0\n- Initiale Projektbasis (M0): HCU-Anbindung, WebUI-Geruest",\
  "logsEnabled": true\
}'
