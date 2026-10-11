import React, { useEffect, useState } from 'react';
import { api, subscribe } from './api.js';
import Dashboard from './Dashboard.jsx';
import BoschLogo from './BoschLogo.jsx';
import HmipLogo from './HmipLogo.jsx';
import AddHomeIcon from './AddHomeIcon.jsx';
import BoschDevices from './BoschDevices.jsx';
import Mapping from './Mapping.jsx';
import Settings from './Settings.jsx';
import Logs from './Logs.jsx';
import Anleitung from './Anleitung.jsx';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: 'speed' },
  { id: 'bosch', label: 'Bosch-Geräte', icon: 'home_iot_device' },
  { id: 'mapping', label: 'HCU-Zuordnung', logo: 'hmip' },
  { id: 'settings', label: 'Einstellungen', icon: 'settings' },
  { id: 'logs', label: 'Logs', icon: 'article' },
  { id: 'guide', label: 'Anleitung', icon: 'help_center' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const [status, setStatus] = useState(null);
  const [tick, setTick] = useState(0); // bumped by SSE events to refresh lists
  const [theme, setTheme] = useState(() => localStorage.getItem('bb-theme') || 'light');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bb-theme', theme);
  }, [theme]);

  useEffect(() => {
    api.status().then(setStatus).catch(() => {});
    const poll = setInterval(() => api.status().then(setStatus).catch(() => {}), 15000);
    const close = subscribe((name) => {
      if (name === 'status') api.status().then(setStatus).catch(() => {});
      else if (name === 'devices' || name === 'bosch' || name === 'hcu') setTick((t) => t + 1);
    });
    return () => { clearInterval(poll); close(); };
  }, []);

  const s = status || {};
  const hcu = s.hcu || {};
  const devices = s.devices || {};
  const bosch = s.bosch || {};

  return (
    <>
      <header>
        <h1><BoschLogo /> Smart Home Bridge</h1>
        <div className="badges">
          <span className="badge hcu" title={hcu.connected ? 'HCU verbunden' : 'HCU getrennt'}>
            <span className="msi">{hcu.connected ? 'link' : 'link_off'}</span> HCU
          </span>
          <span className={`badge bosch${bosch.paired ? '' : ' unpaired'}`} title={bosch.connected ? 'Bosch verbunden' : 'Bosch getrennt'}>
            <span className="msi">{bosch.connected ? 'link' : 'link_off'}</span> BOSCH
          </span>
          <span className="badge" title={bosch.paired ? 'Mit Bosch-Controller gekoppelt' : 'Noch nicht mit Bosch-Controller gekoppelt'}>
            <span className="msi">{bosch.paired ? 'link' : 'link_off'}</span> {bosch.paired ? 'Gepairt' : 'Nicht gepairt'}
          </span>
          <span className="badge" title={`${devices.included ?? 0} von ${devices.known ?? 0} Geräten sind in die HCU eingebunden`}>
            <AddHomeIcon /> {devices.included ?? 0} | {devices.known ?? 0}
          </span>
          <button
            className="icon-btn"
            title={theme === 'dark' ? 'Zum hellen Design wechseln' : 'Zum dunklen Design wechseln'}
            aria-label="Design wechseln"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          >
            <span className="msi">{theme === 'dark' ? 'light_mode' : 'dark_mode'}</span>
          </button>
        </div>
      </header>
      <div className="header-stripe" aria-hidden="true"></div>
      <nav>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            title={t.label}
            aria-label={t.label}
            onClick={() => setTab(t.id)}
          >
            {t.logo === 'hmip' ? <HmipLogo /> : <span className="msi">{t.icon}</span>}
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      <main>
        {tab === 'dashboard' && <Dashboard status={status} statusSetter={setStatus} onTick={() => setTick((t) => t + 1)} />}
        {tab === 'bosch' && <BoschDevices tick={tick} boschStatus={bosch} />}
        {tab === 'mapping' && <Mapping tick={tick} />}
        {tab === 'settings' && <Settings status={status} />}
        {tab === 'logs' && <Logs />}
        {tab === 'guide' && <Anleitung />}
      </main>
      <footer className="imprint">
        Community-Projekt ohne Verbindung zu Bosch oder eQ-3.{' '}
        <span className="msi">info</span>{' '}
        Bosch Smart Home und Homematic IP sind Marken ihrer jeweiligen Inhaber.{' '}
        Lizenz: GPL-3.0, Nutzung auf eigene Gefahr.
      </footer>
    </>
  );
}
