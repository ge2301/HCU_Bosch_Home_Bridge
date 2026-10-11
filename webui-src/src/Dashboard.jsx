import React, { useState } from 'react';
import { api } from './api.js';

function PairingCard({ status, onDone }) {
  const [host, setHost] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // {kind:'err'|'ok', text}

  const s = status || {};
  const bosch = s.bosch || {};

  async function pair() {
    setBusy(true);
    setMsg({ kind: 'ok', text: 'Pairing läuft – bitte jetzt die Pairing-Taste am Controller drücken!' });
    try {
      await api.boschPair(host.trim(), pin.trim());
      setMsg({ kind: 'ok', text: 'Pairing erfolgreich – Geräte werden geladen.' });
      onDone();
    } catch (err) {
      setMsg({ kind: 'err', text: err.message });
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  async function unpair() {
    if (!window.confirm('Pairing wirklich aufheben? Das Plugin entfernt seinen Client vom Controller.')) return;
    setBusy(true);
    try { await api.boschUnpair(); setMsg({ kind: 'ok', text: 'Entkoppelt.' }); onDone(); }
    catch (err) { setMsg({ kind: 'err', text: err.message }); }
    finally { setBusy(false); }
  }

  if (bosch.paired) {
    return (
      <div className="card">
        <h2>Bosch Smart Home Zentrale</h2>
        <div className="kv">
          <span className="k">Controller</span><span>{bosch.host}</span>
          <span className="k">Modell</span><span>{bosch.model || '–'} {bosch.firmware ? `(FW ${bosch.firmware})` : ''}</span>
          <span className="k">Seriennummer</span><span>{bosch.serial || '–'}</span>
          <span className="k">Client-Id</span><span>{bosch.clientId}</span>
          <span className="k">Status</span><span>{bosch.connected ? 'verbunden' : 'getrennt (Automatischer Wiedererkennung aktiv)'}{bosch.lastError ? ` – ${bosch.lastError}` : ''}</span>
          <span className="k">Geräte</span><span>{bosch.deviceCount ?? 0}</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="action secondary" onClick={unpair} disabled={busy}><span className="msi">link_off</span>Entkoppeln</button>
          {busy && <span className="spinner" />}
          {msg && <span className={msg.kind === 'err' ? 'error' : 'okmsg'}>{msg.text}</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Bosch Smart Home Zentrale</h2>
      <ol className="steps">
        <li>Pairing-PIN in der Bosch&nbsp;Companion&nbsp;App ermitteln: <em>Einstellungen → Systemsteuerung → Systemdaten → Pairing-PIN</em>.</li>
        <li>Hier Controller-Adresse und PIN eintragen.</li>
        <li>Auf „Koppeln“ klicken und danach die <strong>Pairing-Taste am Controller</strong> drücken (sie leuchtet kurz).</li>
      </ol>
      <div className="row">
        <input placeholder="IP oder Name des Controllers (SHC)" value={host} onChange={(e) => setHost(e.target.value)} style={{ minWidth: 240 }} />
        <input placeholder="Pairing-PIN" type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
        <button className="action" onClick={pair} disabled={busy || !host || !pin}><span className="msi">link</span>
          {busy ? 'Kopple… (Taste drücken!)' : 'Koppeln'}
        </button>
      </div>
      {msg && <p className={msg.kind === 'err' ? 'error' : 'okmsg'}>{msg.text}</p>}
      <p className="hint">Hinweis: Die Bosch Local API ist Privatnutzung vorbehalten; die Client-Id beginnt verpflichtend mit <code>oss_</code>.</p>
    </div>
  );
}

export default function Dashboard({ status, onTick }) {
  const s = status || {};
  const hcu = s.hcu || {};
  const bosch = s.bosch || {};
  const devices = s.devices || {};
  const [msg, setMsg] = useState(null);

  async function rediscover() {
    try { await api.rediscover(); setMsg({ kind: 'ok', text: 'Neuentdeckung angestoßen – Plugin verbindet sich neu.' }); onTick(); }
    catch (err) { setMsg({ kind: 'err', text: err.message }); }
  }
  async function refresh() {
    try { await api.boschRefresh(); setMsg({ kind: 'ok', text: 'Bosch-Inventar aktualisiert.' }); onTick(); }
    catch (err) { setMsg({ kind: 'err', text: err.message }); }
  }

  return (
    <div className="grid">
      <div className="card">
        <h2>Homematic IP (HCU)</h2>
        <div className="kv">
          <span className="k">WebSocket</span><span>{hcu.connected ? 'verbunden' : 'getrennt'}</span>
          <span className="k">Bereitschaft</span><span>{hcu.readiness || '–'}</span>
          <span className="k">HCU-Adresse</span><span>{hcu.hcuIp || '–'}</span>
          <span className="k">Laufzeit</span><span>{Math.floor((s.uptimeSec || 0) / 60)} min</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="action secondary" onClick={rediscover}><span className="msi">sync</span>HCU-Neuentdeckung</button>
        </div>
      </div>
      <PairingCard status={status} onDone={onTick} />
      <div className="card">
        <h2>Geräteübersicht</h2>
        <div className="kv">
          <span className="k">Bosch-Geräte bekannt</span><span>{bosch.deviceCount ?? 0}</span>
          <span className="k">HCU angeboten</span><span>{devices.offered ?? 0}</span>
          <span className="k">Eingebunden</span><span>{devices.included ?? 0}</span>
          <span className="k">Geparkt/deaktiviert</span><span>{devices.parked ?? 0}</span>
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="action secondary" onClick={refresh} disabled={!bosch.connected}><span className="msi">refresh</span>Bosch-Inventar aktualisieren</button>
          {msg && <span className={msg.kind === 'err' ? 'error' : 'okmsg'}>{msg.text}</span>}
        </div>
        <p className="hint">Neue Bosch-Geräte werden automatisch erkannt und nach einer kurzen Neuverbindung der HCU in der Inbox angeboten.</p>
      </div>
    </div>
  );
}
