import React, { useEffect, useState } from 'react';
import { api } from './api.js';

export default function Mapping({ tick }) {
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    api.devices().then((r) => setRows(r.devices || [])).catch((e) => setErr(e.message));
  }, [tick]);

  async function toggle(row) {
    try {
      await api.setDeviceEnabled(row.boschId, !row.enabled);
      setMsg({ kind: 'ok', text: row.enabled ? `„${row.name}“ geparkt (deaktiviert).` : `„${row.name}“ aktiviert – ggf. kurze Neuverbindung zur HCU nötig.` });
      api.devices().then((r) => setRows(r.devices || [])).catch(() => {});
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }

  return (
    <div className="card">
      <h2>HCU-Zuordnung ({rows.length})</h2>
      {err && <p className="error">{err}</p>}
      {msg && <p className={msg.kind === 'err' ? 'error' : 'okmsg'}>{msg.text}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr><th>Bosch-Gerät</th><th>HCU-Typ</th><th>Status</th><th>HCU-Raum</th><th>Zwillings-Id</th><th></th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.boschId}>
                <td>{r.name}<br /><span className="hint">{r.boschId}</span></td>
                <td>{r.deviceType}</td>
                <td>
                  <span className={`pill ${r.included ? 'included' : !r.enabled ? 'parked' : 'offered'}`}>
                    {r.included ? 'eingebunden' : r.enabled ? 'in Inbox/angeboten' : 'geparkt'}
                  </span>
                </td>
                <td>{r.room || '–'}</td>
                <td><span className="hint">{r.hcuUuid || '–'}</span></td>
                <td><button className="action secondary" onClick={() => toggle(r)}>{r.enabled ? <><span className="msi">pause_circle</span>Deaktivieren</> : <><span className="msi">play_circle</span>Aktivieren</>}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">Deaktivierte Geräte bleiben als „nicht erreichbar“ erhalten (keine Duplikate); eine Reaktivierung stellt sie wieder scharf.</p>
    </div>
  );
}
