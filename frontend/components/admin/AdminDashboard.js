'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Car, ChevronDown, LogOut, RefreshCw } from 'lucide-react';
import ThemePicker from '@/components/admin/ThemePicker';

const when = iso => (iso ? new Date(iso).toLocaleString() : '—');

function Switch({ checked, busy, onChange, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={busy}
      className={`admin-switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}
    >
      <span className="admin-switch-knob" />
      <span className="admin-switch-text">{checked ? 'ON' : 'OFF'}</span>
    </button>
  );
}

function ModuleCard({ mod, busy, onToggleModule, onToggleSection }) {
  const [open, setOpen] = useState(false);
  const live = mod.sections.filter(s => s.is_enabled).length;
  return (
    <article className={`admin-module ${mod.is_enabled ? '' : 'off'}`}>
      <div className="admin-module-head">
        <button type="button" className="admin-expand" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <ChevronDown size={17} className={open ? 'open' : ''} />
          <span className="admin-module-title">
            <b>{mod.name}</b>
            <span className="nav-tag">{mod.identifier}</span>
          </span>
          <span className="admin-module-meta">
            <span className={`admin-status ${mod.is_enabled ? 'on' : ''}`}>{mod.is_enabled ? 'Active' : 'Disabled'}</span>
            <span className="muted small">{live} of {mod.sections.length} sections on · updated {when(mod.updated_at)}</span>
          </span>
        </button>
        <Switch checked={mod.is_enabled} busy={busy[`m:${mod.slug}`]} label={`${mod.name} module`} onChange={v => onToggleModule(mod, v)} />
      </div>
      {open && (
        <ul className="admin-sections">
          {mod.sections.map(s => (
            <li key={s.slug} className={s.is_enabled && mod.is_enabled ? '' : 'off'}>
              <div>
                <span>{s.name}</span>
                <span className="muted small">
                  {!mod.is_enabled && s.is_enabled ? 'Saved ON · unavailable while the module is off' : `Updated ${when(s.updated_at)}`}
                </span>
              </div>
              <Switch checked={s.is_enabled} busy={busy[`s:${mod.slug}/${s.slug}`]} label={`${s.name} section`} onChange={v => onToggleSection(mod, s, v)} />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export default function AdminDashboard() {
  const router = useRouter();
  const [modules, setModules] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState({});
  const [confirming, setConfirming] = useState(null);
  const toastTimer = useRef(null);

  const notify = useCallback((text, kind = 'ok') => {
    setToast({ text, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const handleExpired = useCallback(res => {
    if (res.status !== 401) return false;
    router.refresh();
    return true;
  }, [router]);

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/admin/modules', { cache: 'no-store' });
      if (handleExpired(res)) return;
      if (!res.ok) throw new Error();
      setModules((await res.json()).modules);
    } catch {
      setError('Could not load the module settings. Check that the database migration has been applied.');
    }
  }, [handleExpired]);

  useEffect(() => { load(); }, [load]);

  // Switches move at once and go back if the save fails.
  const save = async (key, url, patch, enabled, label) => {
    setBusy(b => ({ ...b, [key]: true }));
    setModules(patch(enabled));
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_enabled: enabled }),
      });
      if (handleExpired(res)) return;
      if (!res.ok) throw new Error();
      const row = await res.json();
      setModules(patch(enabled, row.updated_at));
      notify(`${label} turned ${enabled ? 'on' : 'off'}.`);
    } catch {
      setModules(patch(!enabled));
      notify(`Could not save ${label}. The previous setting was kept.`, 'error');
    } finally {
      setBusy(b => ({ ...b, [key]: false }));
    }
  };

  const saveModule = (mod, enabled) => save(
    `m:${mod.slug}`, `/api/admin/modules/${mod.slug}`,
    (value, updated_at) => list => list.map(m => (m.slug === mod.slug ? { ...m, is_enabled: value, ...(updated_at ? { updated_at } : {}) } : m)),
    enabled, mod.name,
  );

  const saveSection = (mod, section, enabled) => save(
    `s:${mod.slug}/${section.slug}`, `/api/admin/modules/${mod.slug}/sections/${section.slug}`,
    (value, updated_at) => list => list.map(m => (m.slug !== mod.slug ? m : {
      ...m,
      sections: m.sections.map(s => (s.slug === section.slug ? { ...s, is_enabled: value, ...(updated_at ? { updated_at } : {}) } : s)),
    })),
    enabled, section.name,
  );

  const logout = async () => {
    const res = await fetch('/api/admin/logout', { method: 'POST' }).catch(() => null);
    if (res?.ok) router.refresh();
    else notify('Could not sign out. Please try again.', 'error');
  };

  const active = modules?.filter(m => m.is_enabled).length ?? 0;

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="sidebar-brand">
          <div className="brand-icon-box"><Car size={18} color="#38bdf8" /></div>
          <div className="brand-text">
            <span className="brand-title">TRAFFIC SWARM</span>
            <span className="brand-sub">Admin Console</span>
          </div>
        </div>
        <div className="admin-topbar-actions">
          <button type="button" onClick={load}><RefreshCw size={14} /> Refresh</button>
          <button type="button" onClick={logout}><LogOut size={14} /> Sign out</button>
        </div>
      </header>

      <div className="admin-intro">
        <h1>Module Control</h1>
        <p className="muted">Turn public modules and their sections on or off. Changes reach the server within seconds and open tabs within 15 seconds.</p>
        {modules && <span className="status">{active} of {modules.length} modules active</span>}
      </div>

      {error && <div className="error" role="alert">{error}</div>}
      {!modules && !error && <p className="module-loading muted"><RefreshCw size={15} className="spin" /> Loading modules…</p>}

      <div className="admin-modules">
        {modules?.map(mod => (
          <ModuleCard
            key={mod.slug} mod={mod} busy={busy}
            onToggleModule={(m, v) => (v ? saveModule(m, true) : setConfirming(m))}
            onToggleSection={saveSection}
          />
        ))}
      </div>

      <ThemePicker notify={notify} onExpired={handleExpired} />

      {confirming && (
        <div className="explainer-backdrop" onClick={() => setConfirming(null)}>
          <div className="panel admin-confirm" role="alertdialog" aria-modal="true" aria-labelledby="admin-confirm-title" onClick={e => e.stopPropagation()}>
            <h2 id="admin-confirm-title">Turn off {confirming.name}?</h2>
            <p className="muted">
              It will disappear from the public site and its features will be blocked. Section settings are kept and return when it is turned back on.
              Simulation jobs that are already running are not stopped.
            </p>
            <div className="admin-confirm-actions">
              <button type="button" onClick={() => setConfirming(null)}>Cancel</button>
              <button type="button" className="danger" onClick={() => { saveModule(confirming, false); setConfirming(null); }}>Turn off</button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className={`admin-toast ${toast.kind}`} role="status">{toast.text}</div>}
    </div>
  );
}
