// Central API helper: REST calls + SSE subscription.

async function req(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

export const api = {
  status: () => req('GET', '/api/status'),
  boschStatus: () => req('GET', '/api/bosch/status'),
  boschDevices: () => req('GET', '/api/bosch/devices'),
  boschPair: (host, pin) => req('POST', '/api/bosch/pair', { host, pin }),
  boschUnpair: () => req('POST', '/api/bosch/unpair', {}),
  boschRefresh: () => req('POST', '/api/bosch/refresh', {}),
  boschControl: (deviceId, serviceId, state) => req('POST', '/api/bosch/control', { deviceId, serviceId, state }),
  devices: () => req('GET', '/api/devices'),
  setDeviceEnabled: (id, enabled) => req('PATCH', '/api/devices', { id, enabled }),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PATCH', '/api/settings', patch),
  setPin: (pin, enabled) => req('POST', '/api/pin', { pin, enabled }),
  rediscover: () => req('POST', '/api/rediscover', {}),
  logs: (since) => req('GET', `/api/logs?since=${since || 0}`),
};

// Subscribe to server-sent events. onEvent(name, data).
export function subscribe(onEvent) {
  const es = new EventSource('/api/events');
  const names = ['status', 'devices', 'hcu', 'hmip', 'bosch', 'settings'];
  for (const n of names) {
    es.addEventListener(n, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch { /* ignore */ }
      onEvent(n, data);
    });
  }
  return () => es.close();
}
