-- Admin panel: module and section activation, admin sessions and login throttling.
-- Safe to re-run: nothing here drops data, and the seed never overwrites a saved toggle.

create table if not exists public.site_modules (
  id smallint generated always as identity primary key,
  name text not null,
  slug text not null unique,
  identifier text not null unique,
  is_enabled boolean not null default true,
  sort_order smallint not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_module_sections (
  id smallint generated always as identity primary key,
  module_id smallint not null references public.site_modules(id) on delete restrict,
  name text not null,
  slug text not null,
  is_enabled boolean not null default true,
  sort_order smallint not null,
  updated_at timestamptz not null default now(),
  unique (module_id, slug)
);

-- token_hash is the SHA-256 of the cookie token; the token itself is never stored.
create table if not exists public.admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- key_hash is the SHA-256 of username + client IP.
create table if not exists public.admin_login_attempts (
  key_hash text primary key,
  failed_count integer not null default 0,
  window_started_at timestamptz not null default now()
);

create or replace function public.site_config_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists site_modules_touch on public.site_modules;
create trigger site_modules_touch before update on public.site_modules
  for each row execute function public.site_config_touch_updated_at();

drop trigger if exists site_module_sections_touch on public.site_module_sections;
create trigger site_module_sections_touch before update on public.site_module_sections
  for each row execute function public.site_config_touch_updated_at();

-- Supabase exposes the public schema through its REST API. RLS with no policies, plus these revokes,
-- leaves the tables reachable only by the server's service role key.
alter table public.site_modules enable row level security;
alter table public.site_module_sections enable row level security;
alter table public.admin_sessions enable row level security;
alter table public.admin_login_attempts enable row level security;
revoke all on public.site_modules, public.site_module_sections, public.admin_sessions, public.admin_login_attempts from anon, authenticated;
revoke all on function public.site_config_touch_updated_at() from public, anon, authenticated;

insert into public.site_modules (name, slug, identifier, sort_order) values
  ('Overview', 'overview', 'CORE', 1),
  ('Signal Map', 'signal-map', 'OSM', 2),
  ('Live Lab', 'live-lab', 'LIVE', 3),
  ('Before / After', 'before-after', 'DUAL', 4),
  ('Controllers', 'controllers', 'EVAL', 5),
  ('Prediction', 'prediction', 'AI', 6),
  ('Mixed Traffic', 'mixed-traffic', 'MIX', 7),
  ('How It Works', 'how-it-works', 'VIVA', 8)
on conflict do nothing;

insert into public.site_module_sections (module_id, name, slug, sort_order)
select m.id, s.name, s.slug, s.sort_order
from (values
  ('overview', 'System telemetry cards', 'telemetry-status', 1),
  ('overview', 'KPI improvement highlights', 'kpi-highlights', 2),
  ('overview', 'Simulation Command Center', 'command-center', 3),
  ('overview', 'Feature navigation cards', 'feature-cards', 4),
  ('overview', 'Grid Architectures & What They Mean', 'grid-architectures', 5),
  ('overview', 'Measured Benchmark comparison', 'measured-benchmark', 6),
  ('overview', 'Benchmark fuel and emissions card', 'benchmark-fuel', 7),
  ('overview', 'Raw Telemetry JSON', 'benchmark-raw-json', 8),
  ('overview', 'Measured Simulation Artifacts', 'run-artifacts', 9),
  ('signal-map', 'Quick Place, Scan Area and Map Style selectors', 'place-controls', 1),
  ('signal-map', 'Place search and Scan This View', 'place-search', 2),
  ('signal-map', 'Loaded OSM statistics strip', 'area-stats', 3),
  ('signal-map', 'Download .osm and GeoJSON', 'osm-exports', 4),
  ('signal-map', 'Simulate in SUMO Lab', 'send-to-lab', 5),
  ('signal-map', 'Swarm / Fixed Timer mode toggle', 'mode-toggle', 6),
  ('signal-map', 'Emergency Ambulance Corridor trigger', 'emergency-corridor', 7),
  ('signal-map', 'Play, pause and speed controls', 'sim-controls', 8),
  ('signal-map', 'Packets, vehicles and road-link layers', 'map-layers', 9),
  ('signal-map', 'Map legend', 'map-legend', 10),
  ('signal-map', 'Interactive signal map', 'map-canvas', 11),
  ('signal-map', 'Inter-agent terminal', 'swarm-terminal', 12),
  ('signal-map', 'Selected junction status', 'junction-status', 13),
  ('signal-map', 'Real-time fuel and CO₂ impact panel', 'impact-panel', 14),
  ('signal-map', 'Signal inventory table', 'signal-inventory', 15),
  ('live-lab', 'Experiment job form', 'experiment-form', 1),
  ('live-lab', 'Real-world areas', 'real-world-areas', 2),
  ('live-lab', 'Stop all running', 'stop-all', 3),
  ('live-lab', '2D Heatmap view', 'view-heatmap', 4),
  ('live-lab', '3D City Grid view', 'view-city-3d', 5),
  ('live-lab', 'World Map view', 'view-world', 6),
  ('live-lab', '3D Intersection (digital twin) view', 'view-digital-twin', 7),
  ('live-lab', 'Emergency vehicles', 'emergency-panel', 8),
  ('live-lab', 'Fuel and emissions', 'fuel-card', 9),
  ('live-lab', 'Swarm green-wave calls', 'swarm-calls', 10),
  ('live-lab', 'Jobs table', 'jobs-table', 11),
  ('before-after', 'Demo job form', 'demo-form', 1),
  ('before-after', 'Demo jobs list', 'demo-jobs', 2),
  ('before-after', 'Live side-by-side comparison', 'live-comparison', 3),
  ('before-after', 'Historical replay', 'replay', 4),
  ('before-after', 'Per-side emergency panels', 'emergency-panels', 5),
  ('before-after', 'Fuel and emissions', 'fuel-card', 6),
  ('before-after', 'KPI comparison table', 'kpi-table', 7),
  ('controllers', 'Evaluation confidence-interval chart', 'evaluation-ci-chart', 1),
  ('controllers', 'Evaluation paired statistical tests', 'evaluation-paired-tests', 2),
  ('controllers', 'Saved-run KPI charts', 'saved-run-charts', 3),
  ('controllers', 'Saved-run KPI table', 'saved-run-kpi-table', 4),
  ('controllers', 'Controller configurations', 'saved-run-config', 5),
  ('prediction', 'Place, horizon and feed controls', 'forecast-controls', 1),
  ('prediction', 'Junction selector', 'junction-selector', 2),
  ('prediction', 'Forecast KPI cards', 'kpi-cards', 3),
  ('prediction', 'Predictive queue graph', 'queue-graph', 4),
  ('prediction', 'Pre-emptive swarm action', 'preemptive-action', 5),
  ('mixed-traffic', 'City selector', 'city-selector', 1),
  ('mixed-traffic', 'Composition controls', 'composition-controls', 2),
  ('mixed-traffic', 'Fleet breakdown chart', 'fleet-breakdown', 3),
  ('mixed-traffic', 'Fuel, delay and CO₂ highlights', 'impact-highlights', 4),
  ('mixed-traffic', 'Fixed vs Swarm comparison graph', 'comparison-graph', 5),
  ('how-it-works', 'Fixed timer vs swarm cards', 'compare-cards', 1),
  ('how-it-works', 'Lookahead platooning', 'lookahead', 2),
  ('how-it-works', 'Decentralised architecture flow', 'architecture-flow', 3),
  ('how-it-works', 'ACO pheromone weighting and rules', 'aco-weighting', 4),
  ('how-it-works', 'Fuel, CO₂ and savings', 'fuel-savings', 5),
  ('how-it-works', 'Ambulance green wave', 'ambulance-wave', 6),
  ('how-it-works', 'Evaluator Q&A', 'evaluator-qa', 7)
) as s(module_slug, name, slug, sort_order)
join public.site_modules m on m.slug = s.module_slug
on conflict (module_id, slug) do nothing;
