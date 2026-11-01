-- 3D View: the ninth public module and its sections, in the existing module tables.
-- Safe to re-run: nothing here drops data, and the seed never overwrites a saved toggle.
-- Requires 001_admin_panel.sql. The module starts off; turn it on from the admin panel.
-- Run this BEFORE deploying the code: a registered module with no row counts as enabled.

insert into public.site_modules (name, slug, identifier, is_enabled, sort_order) values
  ('3D View', 'view-3d', '3DV', false, 9)
on conflict do nothing;

insert into public.site_module_sections (module_id, name, slug, sort_order)
select m.id, s.name, s.slug, s.sort_order
from (values
  ('view-3d', 'Simulation run selector and start form', 'run-selector', 1),
  ('view-3d', 'Moving vehicles layer', 'layer-vehicles', 2),
  ('view-3d', 'Traffic signals layer', 'layer-signals', 3),
  ('view-3d', 'Traffic density layer', 'layer-density', 4),
  ('view-3d', 'Congestion heatmap layer', 'layer-heatmap', 5),
  ('view-3d', 'Intersection identifiers layer', 'layer-labels', 6),
  ('view-3d', 'Vehicle inspector and follow', 'vehicle-inspector', 7),
  ('view-3d', 'Intersection inspector', 'intersection-inspector', 8),
  ('view-3d', 'Playback controls', 'playback-controls', 9),
  ('view-3d', 'Performance indicator', 'performance-hud', 10)
) as s(module_slug, name, slug, sort_order)
join public.site_modules m on m.slug = s.module_slug
on conflict (module_id, slug) do nothing;
