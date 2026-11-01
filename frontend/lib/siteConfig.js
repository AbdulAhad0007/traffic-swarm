// Effective module configuration for server enforcement. Cached briefly per instance; on globalThis because
// proxy.js and route handlers can load separate copies of this module.
import 'server-only';
import { ALL_ENABLED, buildEffectiveConfig } from './moduleRegistry';
import { isDbConfigured, rest } from './supabaseRest';

const TTL_MS = 5000;
const state = (globalThis.__tsiSiteConfig ??= { config: null, fetchedAt: 0, pending: null });

async function load() {
  const [modules, sections] = await Promise.all([
    rest('site_modules?select=id,slug,is_enabled'),
    rest('site_module_sections?select=module_id,slug,is_enabled'),
  ]);
  return buildEffectiveConfig(modules, sections);
}

// When Supabase cannot answer, the public site keeps its last known config, or stays fully on if it has none,
// so an outage does not take the site down. Admin access does not use this path and fails closed.
export async function getSiteConfig() {
  if (!isDbConfigured()) return ALL_ENABLED;
  if (state.config && Date.now() - state.fetchedAt < TTL_MS) return state.config;
  state.pending ??= load()
    .then(config => { state.config = config; })
    .catch(err => { console.error('Could not read site configuration:', err.message); })
    .finally(() => { state.fetchedAt = Date.now(); state.pending = null; });
  await state.pending;
  return state.config || ALL_ENABLED;
}

export function invalidateSiteConfig() {
  state.fetchedAt = 0;
}
