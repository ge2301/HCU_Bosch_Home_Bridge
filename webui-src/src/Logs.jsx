import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export default function Logs() {
  const [lines, setLines] = useState([]);
  const lastId = useRef(0);
  const box = useRef(null);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    let stop = false;
    async function pump() {
      try {
        const r = await api.logs(lastId.current);
        if (stop || !r.entries || !r.entries.length) return;
        lastId.current = r.entries[r.entries.length - 1].id;
        setLines((prev) => [...prev, ...r.entries].slice(-1200));
      } catch { /* ignore */ }
    }
    pump();
    const t = setInterval(pump, 2000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (auto && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, auto]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Logs</h2>
        <label className="toggle">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-Scroll
        </label>
      </div>
      <div className="logs" ref={box}>
        {lines.map((l) => `${l.text}`).join('\n')}
      </div>
    </div>
  );
}
