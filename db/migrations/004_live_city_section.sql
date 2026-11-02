-- Overview: the Live Digital City section.
-- Safe to re-run: nothing here drops data, and the seed never overwrites a saved toggle.
-- Requires 001_admin_panel.sql. Until this runs the section counts as on, like any registered section with no row.

insert into public.site_module_sections (module_id, name, slug, sort_order)
select m.id, s.name, s.slug, s.sort_order
from (values
  ('overview', 'Live Digital City', 'live-city', 0)
) as s(module_slug, name, slug, sort_order)
join public.site_modules m on m.slug = s.module_slug
on conflict (module_id, slug) do nothing;
