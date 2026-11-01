// Which module or section keeps each proxied endpoint available. An entry is 'module' or 'module/section';
// an endpoint is open while ANY of its entries is available, so shared endpoints survive one module going off.
const ALWAYS = 'always';
const VIEWS = ['view-heatmap', 'view-city-3d', 'view-world', 'view-digital-twin'].map(s => `live-lab/${s}`);
const RUN_READERS = [
  'overview/kpi-highlights', 'overview/measured-benchmark', 'overview/benchmark-fuel', 'overview/benchmark-raw-json', 'overview/run-artifacts',
  'controllers/saved-run-charts', 'controllers/saved-run-kpi-table', 'controllers/saved-run-config',
];
const ID = '[^/]+';

const LAB_RULES = [
  ['GET', 'health', [ALWAYS]],
  ['GET', 'options', ['live-lab/experiment-form', 'before-after/demo-form', 'view-3d/run-selector']],
  ['GET', 'osm-areas', ['live-lab/real-world-areas', 'live-lab/experiment-form', 'before-after/demo-form', 'view-3d/run-selector']],
  ['POST', 'osm-areas', ['live-lab/real-world-areas']],
  ['GET', 'jobs', ['live-lab', 'before-after', 'view-3d']],
  ['GET', `jobs/${ID}`, ['live-lab', 'before-after', 'view-3d']],
  ['GET', `jobs/${ID}/network3d`, ['view-3d']],
  ['GET', `jobs/${ID}/frames`, ['view-3d']],
  ['GET', `jobs/${ID}/live`, [...VIEWS, 'live-lab/emergency-panel', 'live-lab/fuel-card', 'live-lab/swarm-calls',
    'before-after/live-comparison', 'before-after/replay', 'before-after/emergency-panels', 'before-after/fuel-card', 'before-after/kpi-table']],
  ['POST', `jobs/${ID}/stop`, ['live-lab/jobs-table', 'before-after/demo-jobs']],
  ['POST', 'stop-all', ['live-lab/stop-all']],
  ['GET', `jobs/${ID}/replay`, ['before-after/replay']],
  ['GET', `jobs/${ID}/result`, ['live-lab/fuel-card', 'before-after/fuel-card', 'before-after/kpi-table']],
  ['GET', `jobs/${ID}/calls`, ['live-lab/swarm-calls', 'view-3d/intersection-inspector']],
  ['GET', `jobs/${ID}/messages`, ['live-lab']],
  ['GET', 'runs', RUN_READERS],
  ['GET', 'runs/comparison', RUN_READERS],
  ['GET', 'runs/replay', ['controllers']],
  ['GET', 'runs/calls', ['controllers']],
  ['GET', 'reports', ['controllers/evaluation-ci-chart', 'controllers/evaluation-paired-tests']],
  ['GET', `reports/${ID}`, ['controllers/evaluation-ci-chart', 'controllers/evaluation-paired-tests']],
  ['GET', `swarm/mesh/${ID}`, ['signal-map']],
  ['POST', `swarm/mesh/${ID}`, ['signal-map']],
].map(([method, path, any]) => ({ method, re: new RegExp(`^${path}$`), any }));

const BACKEND_RULES = [
  ['GET', 'api/health', [ALWAYS]],
  ['GET', 'api/experiments', ['overview']],
  ['POST', 'api/experiments', ['overview']],
  ['GET', `api/experiments/${ID}`, ['overview']],
  ['POST', `api/experiments/${ID}/run`, ['overview']],
].map(([method, path, any]) => ({ method, re: new RegExp(`^${path}$`), any }));

function available(config, entry) {
  if (entry === ALWAYS) return true;
  const [mod, section] = entry.split('/');
  return section ? config.modules[mod]?.sections[section] === true : config.modules[mod]?.enabled === true;
}

function decide(config, rule) {
  if (!rule) return { allowed: false, error: 'endpoint_not_allowed', detail: 'This endpoint is not available.' };
  if (rule.any.some(entry => available(config, entry))) return { allowed: true };
  return { allowed: false, error: 'module_disabled', detail: 'This feature is currently unavailable.' };
}

// segments: the [...path] params. The browser calls /api/lab/api/lab/<x>, so the prefix is optional here too.
export function checkLabRequest(config, method, segments, bodyText = '') {
  const parts = segments[0] === 'api' && segments[1] === 'lab' ? segments.slice(2) : segments;
  const path = parts.join('/');
  if (method === 'POST' && path === 'jobs') {
    // The kind decides who owns a new job. Anything other than 'demo' is an experiment or a 400 from the lab.
    let kind;
    try { kind = JSON.parse(bodyText)?.kind; } catch { kind = undefined; }
    const any = kind === 'demo' ? ['before-after/demo-form', 'overview/command-center'] : ['live-lab/experiment-form', 'view-3d/run-selector'];
    return decide(config, { any });
  }
  return decide(config, LAB_RULES.find(r => r.method === method && r.re.test(path)));
}

export function checkBackendRequest(config, method, segments) {
  const path = segments.join('/');
  return decide(config, BACKEND_RULES.find(r => r.method === method && r.re.test(path)));
}
