-- Live Camera: the tenth public module, its sections, and its own tables.
-- Safe to re-run: nothing here drops data, and the seed never overwrites a saved toggle.
-- Requires 001_admin_panel.sql. The module starts off; turn it on from the admin panel.
-- Run this BEFORE deploying the code: a registered module with no row counts as enabled.
-- Raw video frames are never stored here.

insert into public.site_modules (name, slug, identifier, is_enabled, sort_order) values
  ('Live Camera', 'live-camera', 'LCM', false, 10)
on conflict do nothing;

insert into public.site_module_sections (module_id, name, slug, sort_order, is_enabled)
select m.id, s.name, s.slug, s.sort_order, s.is_enabled
from (values
  ('live-camera', 'Camera management', 'camera-management', 1, true),
  ('live-camera', 'Frame extraction', 'frame-extraction', 2, true),
  ('live-camera', 'YOLO processing', 'yolo-processing', 3, true),
  ('live-camera', 'Traffic analytics', 'traffic-analytics', 4, true),
  ('live-camera', 'Agent integration', 'agent-integration', 5, true),
  ('live-camera', 'Signal optimization', 'signal-optimization', 6, true),
  ('live-camera', 'Test mode', 'test-mode', 7, true),
  ('live-camera', 'Public video previews', 'public-video', 8, false),
  ('live-camera', 'Top status bar', 'status-bar', 9, true),
  ('live-camera', 'Camera grid', 'camera-grid', 10, true),
  ('live-camera', 'Processing pipeline', 'pipeline-view', 11, true),
  ('live-camera', 'AI detection panel', 'detection-panel', 12, true),
  ('live-camera', 'Traffic intelligence panel', 'traffic-panel', 13, true),
  ('live-camera', 'Swarm intelligence panel', 'swarm-panel', 14, true),
  ('live-camera', 'Signal optimization panel', 'signal-panel', 15, true),
  ('live-camera', 'System logs', 'system-logs', 16, true)
) as s(module_slug, name, slug, sort_order, is_enabled)
join public.site_modules m on m.slug = s.module_slug
on conflict (module_id, slug) do nothing;

create table if not exists public.lcm_cameras (
  id text primary key,
  camera_name text not null,
  location text not null default '',
  intersection_id text not null,
  source_type text not null check (source_type in ('go2rtc', 'rtsp', 'webcam', 'usb', 'file')),
  stream_reference text not null,          -- a stream name, device number, file name or credential-free address
  data_class text not null check (data_class in ('LIVE', 'TEST', 'REPLAY')),
  enabled boolean not null default true,
  status text not null default 'STOPPED',
  config jsonb not null default '{}'::jsonb,
  zones jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Service addresses and the signal mode. Credentials are never stored in this table.
create table if not exists public.lcm_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- These tables keep their rows when a camera is deleted: history outlives configuration.
create table if not exists public.lcm_frame_metadata (
  id bigint generated always as identity primary key,
  camera_id text not null,
  frame_number bigint not null,
  source_timestamp_ms double precision,
  received_timestamp timestamptz not null,
  width integer,
  height integer,
  processing_status text not null,
  processing_ms double precision
);
create index if not exists lcm_frame_metadata_camera_time on public.lcm_frame_metadata (camera_id, received_timestamp desc);

create table if not exists public.lcm_vehicle_detections (
  id bigint generated always as identity primary key,
  camera_id text not null,
  frame_number bigint not null,
  tracking_id bigint,
  vehicle_class text not null,
  confidence real not null,
  bounding_box jsonb not null,
  timestamp timestamptz not null
);
create index if not exists lcm_vehicle_detections_camera_time on public.lcm_vehicle_detections (camera_id, timestamp desc);

create table if not exists public.lcm_traffic_analytics (
  id bigint generated always as identity primary key,
  intersection_id text not null,
  camera_id text not null,
  vehicle_count integer not null,
  queue_length_m double precision,        -- null without calibration
  queue_vehicles integer,
  average_speed_mps double precision,     -- null without calibration
  occupancy double precision,
  congestion_level text,
  quality text not null,
  data_class text not null,
  details jsonb,
  timestamp timestamptz not null
);
create index if not exists lcm_traffic_analytics_camera_time on public.lcm_traffic_analytics (camera_id, timestamp desc);

create table if not exists public.lcm_signal_decisions (
  id bigint generated always as identity primary key,
  intersection_id text not null,
  camera_id text,
  proposed_phase text not null,
  approved_phase text,
  decision_reason text not null,
  source text,
  mode text not null,
  validation_status text not null,
  details jsonb,
  timestamp timestamptz not null
);
create index if not exists lcm_signal_decisions_time on public.lcm_signal_decisions (timestamp desc);

alter table public.lcm_cameras enable row level security;
alter table public.lcm_settings enable row level security;
alter table public.lcm_frame_metadata enable row level security;
alter table public.lcm_vehicle_detections enable row level security;
alter table public.lcm_traffic_analytics enable row level security;
alter table public.lcm_signal_decisions enable row level security;
revoke all on public.lcm_cameras, public.lcm_settings, public.lcm_frame_metadata, public.lcm_vehicle_detections,
  public.lcm_traffic_analytics, public.lcm_signal_decisions from anon, authenticated;
