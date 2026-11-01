-- Site theme: one row holding the theme every public visitor sees.
-- Safe to re-run: nothing here drops data, and the seed never overwrites a saved theme.
-- Requires 001_admin_panel.sql, which creates site_config_touch_updated_at().

create table if not exists public.site_settings (
  id smallint primary key default 1 check (id = 1),
  theme text not null default 'midnight' check (theme in ('midnight', 'night-road', 'survey-map')),
  updated_at timestamptz not null default now()
);

drop trigger if exists site_settings_touch on public.site_settings;
create trigger site_settings_touch before update on public.site_settings
  for each row execute function public.site_config_touch_updated_at();

-- RLS with no policies, plus this revoke, leaves the table reachable only by the server's service role key.
alter table public.site_settings enable row level security;
revoke all on public.site_settings from anon, authenticated;

insert into public.site_settings (id) values (1) on conflict do nothing;
