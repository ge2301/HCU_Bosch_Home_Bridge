import React, { useEffect, useState } from 'react';
import { api } from './api.js';

function summarize(states) {
  const parts = [];
  for (const [sid, st] of Object.entries(states || {})) {
    if (!st || typeof st !== 'object') continue;
    if (sid === 'powerSwitch') parts.push(st.switchState === 'ON' ? 'AN' : 'AUS');
    else if (sid === 'climateControl' && typeof st.setpointTemperature === 'number') parts.push(`Soll ${st.setpointTemperature}°C`);
    else if (sid === 'contactDetection') parts.push(st.contactDetection === 'opened' ? 'geöffnet' : 'geschlossen');
    else if (sid === 'shutterControl' && typeof st.shutterLevel === 'number') parts.push(`Pos ${Math.round(st.shutterLevel * 100)}%`);
    else if (sid === 'powerMeter' && typeof st.power === 'number') parts.push(`${st.power.toFixed(0)} W`);
    else if (sid === 'smokeAlarm') parts.push(st.smokeAlarmDetection === 'ALARM' ? 'ALARM' : 'rauchfrei');
    else if (sid === 'latestMotion') parts.push(st.motionDetected ? 'Bewegung' : 'ruhig');
    else if (sid === 'waterLevelDetection') parts.push(st.waterLeakageDetected ? 'WASSER!' : 'trocken');
    else if (sid === 'safe') parts.push(st.overallState === 'IDLE' ? 'unscharf' : 'scharf');
  }
  return parts.join(' · ');
}

export default function BoschDevices({ tick, boschStatus }) {
  const [devices, setDevices] = useState([]);
  const [err, setErr] = useState(null);
  const [toggles, setToggles] = useState({});

  useEffect(() => {
    if (!boschStatus.connected) return;
    api.boschDevices().then((r) => setDevices(r.devices || [])).catch((e) => setErr(e.message));
  }, [tick, boschStatus.connected]);

  async function toggle(dev) {
    const cur = dev.states && dev.states.powerSwitch && dev.states.powerSwitch.switchState === 'ON';
    setToggles((t) => ({ ...t, [dev.id]: true }));
    try {
      await api.boschControl(dev.id, 'powerSwitch', { '@type': 'powerSwitchState', switchState: cur ? 'OFF' : 'ON' });
    } catch (e) { setErr(e.message); }
    setTimeout(() => setToggles((t) => ({ ...t, [dev.id]: false })), 1200);
  }

  if (!boschStatus.connected) {
    return <div className="card"><h2>Bosch-Geräte</h2><p className="hint">Nicht mit einem Bosch Smart Home Controller verbunden. Bitte im Dashboard koppeln.</p></div>;
  }

  return (
    <div className="card">
      <h2>Bosch-Geräte ({devices.length})</h2>
      {err && <p className="error">{err}</p>}
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr><th>Name</th><th>Raum</th><th>Typ</th><th>Dienste</th><th>Zustand</th><th></th></tr>
          </thead>
          <tbody>
            {devices.map((d) => {
              const switchable = (d.services || []).some((s) => (s.definedServices || []).includes('powerSwitch'));
              return (
                <tr key={d.id}>
                  <td>{d.name}<br /><span className="hint">{d.id}</span></td>
                  <td>{d.room || '–'}</td>
                  <td>{d.deviceType || '–'}</td>
                  <td>{(d.services || []).flatMap((s) => s.definedServices || []).join(', ')}</td>
                  <td className="state-summary">{summarize(d.states)}</td>
                  <td>
                    {switchable && (
                      <button className="action secondary" onClick={() => toggle(d)} disabled={!!toggles[d.id]}><span className="msi">power</span>
                        {toggles[d.id] ? '…' : 'Schalten'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="hint">Szenen und Alarmanlage erscheinen als virtuelle Geräte in der HCU-Zuordnung.</p>
    </div>
  );
}
