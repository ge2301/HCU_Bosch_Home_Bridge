'use strict';
// Bosch SHC pairing (official flow, bosch-shc-api-docs "Pairing"):
//   1. Generate a self-signed 2048-bit client certificate (CN = clientId).
//   2. Press the physical pairing button on the SHC front.
//   3. POST https://<shc>:8443/smarthome/clients with header
//        Systempassword: base64(<pairing PIN from Bosch Companion App>)
//      body { clientId:'oss_...', clientKey:<32 hex random>, name, role:'ROLE_RESTRICTED_CLIENT' }
//   4. Keep cert/key/clientKey - unpairing needs DELETE with Basic auth clientId:clientKey.
//
// ToS: private, non-commercial use only; clientId MUST start with 'oss_'.

const crypto = require('crypto');
const https = require('https');
const selfsigned = require('selfsigned');

const PAIR_PORT = 8443;
const CLIENT_ID_PREFIX = 'oss_';

function assertOssClientId(clientId) {
  if (!clientId || !clientId.startsWith(CLIENT_ID_PREFIX)) {
    throw new Error(`clientId must start with '${CLIENT_ID_PREFIX}' (Bosch ToS)`);
  }
  if (!/^[a-zA-Z0-9_-]{4,64}$/.test(clientId)) {
    throw new Error('clientId must be 4-64 chars of [A-Za-z0-9_-]');
  }
}

/** Generate a self-signed client certificate valid for 10 years. */
async function generateClientCert(clientId) {
  assertOssClientId(clientId);
  const attrs = [{ name: 'commonName', value: clientId }];
  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
  });
  return { cert: pems.cert, key: pems.private, clientId };
}

function randomClientKey() {
  return crypto.randomBytes(16).toString('hex');
}

function postPair({ host, port = PAIR_PORT, pin, clientId, clientKey, name, timeoutMs = 65000 }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      clientId,
      clientKey,
      name: name || 'HCU Bosch Bridge',
      role: 'ROLE_RESTRICTED_CLIENT',
    });
    const req = https.request({
      host,
      port,
      method: 'POST',
      path: '/smarthome/clients',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        // Bosch expects the base64 of the raw pairing PIN
        Systempassword: Buffer.from(String(pin), 'utf8').toString('base64'),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('pairing request timed out')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function deleteClient({ host, port = PAIR_PORT, clientId, clientKey, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${clientId}:${clientKey}`).toString('base64');
    const req = https.request({
      host,
      port,
      method: 'DELETE',
      path: `/smarthome/clients/${encodeURIComponent(clientId)}`,
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { Authorization: `Basic ${auth}` },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('unpair request timed out')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Full pairing round. Call while the SHC pairing button was pressed recently
 * (window is ~2 minutes). Returns material to persist for the ShcClient.
 */
async function pair({ host, pin, clientId, name, port = PAIR_PORT }) {
  const cid = clientId || `${CLIENT_ID_PREFIX}hcu-bosch-bridge`;
  assertOssClientId(cid);
  const { cert, key } = await generateClientCert(cid);
  const clientKey = randomClientKey();
  const res = await postPair({ host, port, pin, clientId: cid, clientKey, name });
  if (res.statusCode === 401) {
    throw new Error('Pairing abgelehnt (401): PIN falsch');
  }
  if (res.statusCode !== 200 && res.statusCode !== 201) {
    const hint = res.statusCode === 403 ? ' - Pairingstaste am Controller druecken und erneut versuchen' : '';
    throw new Error(`Pairing fehlgeschlagen (HTTP ${res.statusCode})${hint}`);
  }
  return { clientId: cid, clientKey, cert, key, response: res.body };
}

module.exports = { pair, unpair: deleteClient, generateClientCert, assertOssClientId, PAIR_PORT, CLIENT_ID_PREFIX };
