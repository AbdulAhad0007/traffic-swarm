'use client';

import React, { useEffect, useState } from 'react';
import { Check } from 'lucide-react';
import { THEMES } from '@/lib/themes';
import { loadThemeFonts } from '@/lib/themeClient';

// Each card sets its own data-theme, so what it shows is the real theme, not a picture of it.
export default function ThemePicker({ notify, onExpired }) {
  const [active, setActive] = useState(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    THEMES.forEach(t => loadThemeFonts(t.slug));
    fetch('/api/admin/theme', { cache: 'no-store' })
      .then(res => {
        if (onExpired(res)) return null;
        return res.ok ? res.json() : Promise.reject(new Error(res.statusText));
      })
      .then(body => { if (body) setActive(body.theme); })
      .catch(() => setFailed(true));
  }, [onExpired]);

  const choose = async theme => {
    if (theme.slug === active || saving) return;
    const previous = active;
    setActive(theme.slug);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/theme', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: theme.slug }),
      });
      if (onExpired(res)) return;
      if (!res.ok) throw new Error(res.statusText);
      notify(`Theme changed to ${theme.name}.`);
    } catch {
      setActive(previous);
      notify('Could not save the theme. The previous theme was kept.', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="admin-theme" aria-labelledby="admin-theme-title">
      <h2 id="admin-theme-title">Website theme</h2>
      <p className="muted">Choose how the public website looks for every visitor. This admin panel keeps its own look.</p>
      {failed && (
        <div className="error" role="alert">
          Could not load the theme. Check that the 002_site_theme migration has been applied, then reload this page.
        </div>
      )}
      <div className="theme-cards">
        {THEMES.map(theme => {
          const isActive = theme.slug === active;
          return (
            <button
              key={theme.slug} type="button" data-theme={theme.slug} className={`theme-card ${isActive ? 'active' : ''}`}
              aria-pressed={isActive} disabled={failed || saving || active === null} onClick={() => choose(theme)}
            >
              <span className="theme-card-name">{theme.name}</span>
              <span className="theme-card-desc">{theme.description}</span>
              <span className="theme-card-swatches" aria-hidden="true">
                <i style={{ background: 'var(--bg-surface)' }} />
                <i style={{ background: 'var(--accent)' }} />
                <i style={{ background: 'var(--accent-2)' }} />
              </span>
              <span className="theme-card-state">{isActive ? <><Check size={14} /> Active</> : 'Use this theme'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
