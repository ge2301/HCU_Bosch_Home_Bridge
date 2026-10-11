import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const TOGGLES = [
  ['enableScenarios', 'Bosch-Szenen anbieten', 'Jede Bosch-Szene wird als schaltbares HCU-Gerät „Szene: …“ angeboten.'],
  ['enableIntrusion', 'Alarmanlage anbieten', 'Die Bosch-Alarmanlage erscheint als HCU-Schalter (Ein = scharf).'],
  ['requirePinToDisarm', 'PIN zum Unscharfschalten im WebUI verlangen', 'Unscharfschalten über die HCU bleibt möglich; das WebUI fragt die PIN ab.'],
  ['enableEnergyMeters', 'Energie-Zweitgeräte anbieten', 'Steckdosen mit Leistungsmessung bekommen ein zusätzliches Energie-Mess-Gerät.'],
  ['enableIlluminanceSensors', 'Helligkeits-Zweitgeräte', 'Bewegungsmelder mit Helligkeitssensor erhalten ein extra Klima-Sensor-Gerät.'],
  ['enableTwinguardPm', 'Twinguard-Luftgüte', 'Twinguard zusätzlich als Klima-Sensor (Luftgüte/Feuchte) anbieten.'],
  ['keypadAsMomentarySwitch', 'Wandtaster als Impulsschalter', 'Fallback: Bosch-Taster als normaler Schalter statt Taster-Gerät (HCU-Kompatibilität).'],
];

export default function Settings({ status }) {
  const [settings, setSettings] = useState(null);
  const [msg, setMsg] = useState(null);
  const [pin, setPin] = useState('');
  const impulseTimer = useRef(null);

  useEffect(() => {
    api.settings().then((r) => setSettings(r.settings)).catch(() => {});
  }, [status && status.uptimeSec]);

  if (!settings) return <div className="card">Lade Einstellungen …</div>;

  async function savePatch(patch) {
    try {
      await api.saveSettings(patch);
    } catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }

  // Changes are applied immediately; the number field is debounced while typing.
  function set(key, value) {
    setSettings((s) => ({ ...s, [key]: value }));
    if (key === 'motionImpulseSeconds') {
      clearTimeout(impulseTimer.current);
      impulseTimer.current = setTimeout(() => savePatch({ motionImpulseSeconds: Number(value) || 10 }), 600);
    } else {
      savePatch({ [key]: value });
    }
  }

  async function savePin() {
    try { await api.setPin(pin, true); setPin(''); }
    catch (e) { setMsg({ kind: 'err', text: e.message }); }
  }

  async function togglePinReq(e) {
    const enabled = e.target.checked;
    try {
      await api.setPin(undefined, enabled);
      setSettings((s) => ({ ...s, webuiPinEnabled: enabled }));
    }
    catch (err) { setMsg({ kind: 'err', text: err.message }); }
  }

  return (
    <div className="grid">
      <div className="card">
        <h2>Funktionen</h2>
        {TOGGLES.map(([key, label, help]) => (
          <div key={key}>
            <label className="toggle">
              <input type="checkbox" checked={!!settings[key]} onChange={(e) => set(key, e.target.checked)} />
              <span>{label}</span>
            </label>
            <div className="hint" style={{ marginLeft: 28, marginBottom: 6 }}>{help}</div>
          </div>
        ))}
        <div className="row" style={{ marginTop: 10 }}>
          <label className="toggle">
            Bewegungsimpuls (Sekunden)
            <input type="number" min="2" max="120" style={{ width: 70 }}
              value={settings.motionImpulseSeconds}
              onChange={(e) => set('motionImpulseSeconds', e.target.value)} />
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {msg && <span className={msg.kind === 'err' ? 'error' : 'okmsg'}>{msg.text}</span>}
        </div>
      </div>
      <div className="card">
        <h2>Zugangs-PIN (WebUI)</h2>
        <p className="hint">
          Die PIN schützt sensible Aktionen im WebUI (z.&nbsp;B. Unscharfschalten der Alarmanlage),
          wenn diese Option aktiv ist. Sie wird ausschließlich lokal im Plugin gespeichert.
        </p>
        <div className="row">
          <input type="password" placeholder="Neue PIN (mind. 4 Zeichen)" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="action" onClick={savePin} disabled={pin.length < 4}><span className="msi">pin</span>PIN setzen</button>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <label className="toggle">
            <input type="checkbox" checked={!!settings.webuiPinEnabled} onChange={togglePinReq} />
            <span>PIN-Pflicht aktiv</span>
          </label>
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Aktuell: {settings.webuiPinEnabled ? 'PIN-Pflicht aktiv' : 'keine PIN-Pflicht'}
        </p>
      </div>
    </div>
  );
}
