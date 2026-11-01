'use client';

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import ModuleUnavailable from '@/components/ModuleUnavailable';
import { ALL_ENABLED, firstEnabledRoute, moduleForRoute } from '@/lib/moduleRegistry';
import { applyTheme } from '@/lib/themeClient';

const REFRESH_MS = 15000;
const SiteConfigContext = createContext(ALL_ENABLED);

// The server stays the authority for pages and APIs. This keeps open tabs in step, including routes that
// Cache Components kept alive in hidden state, which can reappear without a new server request.
export function SiteConfigProvider({ children }) {
  const [config, setConfig] = useState(ALL_ENABLED);

  useEffect(() => {
    let active = true;
    const load = () => fetch('/api/site-config', { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then(c => { if (active && c) { setConfig(c); applyTheme(c.theme); } })
      .catch(() => { if (active) setConfig(c => c || ALL_ENABLED); });
    load();
    const t = setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => { active = false; clearInterval(t); window.removeEventListener('focus', load); };
  }, []);

  return <SiteConfigContext.Provider value={config}>{children}</SiteConfigContext.Provider>;
}

export const useSiteConfig = () => useContext(SiteConfigContext) || ALL_ENABLED;

// on('section') for one module; moduleOn('slug') and sectionOn('slug', 'section') for cross-module rules.
export function useSections(moduleSlug) {
  const config = useSiteConfig();
  return useMemo(() => {
    const sectionOn = (mod, section) => config.modules[mod]?.sections[section] === true;
    return {
      on: section => sectionOn(moduleSlug, section),
      moduleOn: mod => config.modules[mod]?.enabled === true,
      sectionOn,
    };
  }, [config, moduleSlug]);
}

export function ModuleGate({ children }) {
  const config = useSiteConfig();
  const pathname = usePathname();
  const router = useRouter();
  const mod = moduleForRoute(pathname);
  const blocked = !!mod && config?.modules?.[mod.slug]?.enabled === false;
  const next = blocked && pathname === '/' ? firstEnabledRoute(config) : null;

  useEffect(() => { if (next) router.replace(next); }, [next, router]);

  if (blocked) return next ? null : <ModuleUnavailable />;
  return children;
}
