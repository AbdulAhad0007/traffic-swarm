'use client';

import React, { useState } from 'react';
import { Grid2x2, RectangleHorizontal, Columns2, Unplug } from 'lucide-react';
import { useSections } from '@/components/SiteConfigProvider';
import AdminTools from './AdminTools';
import CameraTile from './CameraTile';
import Inspector from './Inspector';
import Pipeline from './Pipeline';
import { DetectionPanel, LogsPanel, SignalPanel, SwarmPanel, Topology, TrafficPanel } from './Panels';
import { useCameraFeed } from './feed';
import '@/app/styles/camera.css';

// The service reads these same switches and stops the stage itself; the page only reports them.
const PROCESSING = [
  ['camera-management', 'camera management'], ['frame-extraction', 'frame extraction'], ['yolo-processing', 'YOLO processing'], ['traffic-analytics', 'traffic analytics'],
  ['agent-integration', 'agent integration'], ['signal-optimization', 'signal optimization'], ['test-mode', 'test mode'],
];
const LAYOUTS = [[1, RectangleHorizontal, 'One camera'], [2, Columns2, 'Two cameras'], [4, Grid2x2, 'Four cameras']];

export default function LiveCamera() {
  const { on } = useSections('live-camera');
  const { overview, events, connection, session, subscribe } = useCameraFeed();
  const [layout, setLayout] = useState(4);
  const [selected, setSelected] = useState(null);
  const [inspecting, setInspecting] = useState(null);
  const [page, setPage] = useState(0);
  const [layers, setLayers] = useState({ boxes: true, labels: true, ids: true, trails: false });

  const cameras = overview?.cameras || [];
  const status = overview?.status;
  const pages = Math.max(1, Math.ceil(cameras.length / layout));
  const start = Math.min(page, pages - 1) * layout;
  const focus = layout === 1 && selected ? cameras.filter(c => c.id === selected) : cameras.slice(start, start + layout);
  const pick = id => { setSelected(id); setInspecting(id); };
  const selectedCamera = cameras.find(c => c.id === selected) || cameras.find(c => c.status === 'CONNECTED') || cameras[0];
  const down = connection === 'lost' && !overview;
  const classes = [...new Set(cameras.map(c => c.data_class))];
  const off = PROCESSING.filter(([slug]) => !on(slug)).map(([, label]) => label);

  return (
    <div className="lcm">
      <header className="lcm-title">
        <div>
          <span className="eyebrow">Live Camera</span>
          <h1>Traffic intelligence control room</h1>
        </div>
        <div className="lcm-title-state">
          {classes.includes('TEST') && <span className="lcm-class lcm-class-test">TEST SOURCE RUNNING</span>}
          {classes.includes('REPLAY') && <span className="lcm-class lcm-class-replay">REPLAY RUNNING</span>}
          {connection === 'lost' && overview && <span className="lcm-class lcm-class-none">Connection lost, retrying</span>}
        </div>
      </header>

      {down && (
        <section className="panel lcm-down">
          <Unplug size={26} color="var(--status-warn)" />
          <div><h2>The camera service is not connected</h2><p className="muted">No camera data is available. {session.admin ? 'Start it with: uvicorn camera_service.api:app --port 8091' : 'Please try again later.'}</p></div>
        </section>
      )}

      {on('status-bar') && status && (
        <dl className="lcm-statusbar">
          <div><dt>Cameras</dt><dd>{status.total}</dd></div>
          <div><dt>Connected</dt><dd>{status.connected}</dd></div>
          <div><dt>Offline</dt><dd>{status.offline}</dd></div>
          <div><dt>Active streams</dt><dd>{status.active_streams}</dd></div>
          <div><dt>Processing FPS</dt><dd>{status.processing_fps}</dd></div>
          <div><dt>Vehicles tracked</dt><dd>{status.vehicles_detected}</dd></div>
          <div><dt>Active junctions</dt><dd>{status.active_intersections}</dd></div>
          {overview.resources?.cpu_percent != null && <div><dt>CPU / RAM</dt><dd>{Math.round(overview.resources.cpu_percent)}% / {Math.round(overview.resources.ram_percent)}%</dd></div>}
          {overview.resources?.device && <div><dt>Inference on</dt><dd>{overview.resources.device.startsWith('cuda') ? 'GPU' : 'CPU'}</dd></div>}
        </dl>
      )}

      {overview && off.length > 0 && <p className="lcm-note">Turned off by the administrator: {off.join(', ')}. Those stages are not running.</p>}
      {session.admin && overview && !on('public-video') && <p className="lcm-note">Video is visible to signed-in administrators only. Turn on Public video previews in the admin panel to show it to visitors.</p>}

      {on('camera-grid') && overview && (
        <section className={`lcm-workspace ${inspecting ? 'has-inspector' : ''}`}>
          <div className="lcm-main">
            <div className="lcm-row-between lcm-grid-bar">
              <div className="lcm-layouts" role="group" aria-label="Camera layout">
                {LAYOUTS.map(([n, Icon, label]) => <button type="button" key={n} className={`small icon ${layout === n ? 'primary' : ''}`} aria-pressed={layout === n} aria-label={label} title={label} onClick={() => { setLayout(n); setPage(0); }}><Icon size={15} /></button>)}
              </div>
              {pages > 1 && !(layout === 1 && selected) && (
                <div className="lcm-layouts">
                  <button type="button" className="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</button>
                  <span className="muted">{Math.min(page, pages - 1) + 1} of {pages}</span>
                  <button type="button" className="small" disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Next</button>
                </div>
              )}
            </div>
            {cameras.length === 0 ? (
              <div className="panel lcm-empty">
                <h2>No cameras are registered</h2>
                <p className="muted">{session.admin ? 'Add a camera, test source or video in Camera setup below.' : 'Live video appears here when an administrator connects a camera.'}</p>
              </div>
            ) : (
              <div className={`lcm-grid lcm-grid-${layout}`}>
                {focus.map(c => <CameraTile key={c.id} camera={c} selected={selected === c.id} onSelect={pick} subscribe={subscribe} layers={layers} large={layout === 1} />)}
              </div>
            )}
          </div>
          {inspecting && cameras.some(c => c.id === inspecting) && <Inspector key={inspecting} cameraId={inspecting} admin={session.admin} onClose={() => setInspecting(null)} />}
        </section>
      )}

      {on('pipeline-view') && overview && <Pipeline stages={overview.stages} cameras={cameras} serverTime={overview.server_time} subscribe={subscribe} />}
      {on('camera-grid') && overview && <Topology selected={selected} onSelect={pick} />}
      {on('detection-panel') && overview && <DetectionPanel cameras={cameras} selected={selected} subscribe={subscribe} layers={layers} setLayers={setLayers} />}
      {on('traffic-panel') && overview && <TrafficPanel camera={selectedCamera} />}
      {on('swarm-panel') && overview && <SwarmPanel events={events} subscribe={subscribe} />}
      {on('signal-panel') && overview && <SignalPanel admin={session.admin} />}
      {session.admin && overview && <AdminTools flags={overview.flags} database={overview.database} onAdded={id => setSelected(id)} />}
      {on('system-logs') && overview && <LogsPanel events={events} />}
    </div>
  );
}
