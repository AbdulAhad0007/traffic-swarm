// The eight public modules and their sections. Shared by server and client, and kept in step with
// db/migrations/001_admin_panel.sql (tests/registry.test.mjs compares them).
export const MODULES = [
  {
    slug: 'overview', name: 'Overview', identifier: 'CORE', route: '/',
    sections: [
      ['telemetry-status', 'System telemetry cards'],
      ['kpi-highlights', 'KPI improvement highlights'],
      ['command-center', 'Simulation Command Center'],
      ['feature-cards', 'Feature navigation cards'],
      ['grid-architectures', 'Grid Architectures & What They Mean'],
      ['measured-benchmark', 'Measured Benchmark comparison'],
      ['benchmark-fuel', 'Benchmark fuel and emissions card'],
      ['benchmark-raw-json', 'Raw Telemetry JSON'],
      ['run-artifacts', 'Measured Simulation Artifacts'],
    ],
  },
  {
    slug: 'signal-map', name: 'Signal Map', identifier: 'OSM', route: '/ghaziabad',
    sections: [
      ['place-controls', 'Quick Place, Scan Area and Map Style selectors'],
      ['place-search', 'Place search and Scan This View'],
      ['area-stats', 'Loaded OSM statistics strip'],
      ['osm-exports', 'Download .osm and GeoJSON'],
      ['send-to-lab', 'Simulate in SUMO Lab'],
      ['mode-toggle', 'Swarm / Fixed Timer mode toggle'],
      ['emergency-corridor', 'Emergency Ambulance Corridor trigger'],
      ['sim-controls', 'Play, pause and speed controls'],
      ['map-layers', 'Packets, vehicles and road-link layers'],
      ['map-legend', 'Map legend'],
      ['map-canvas', 'Interactive signal map'],
      ['swarm-terminal', 'Inter-agent terminal'],
      ['junction-status', 'Selected junction status'],
      ['impact-panel', 'Real-time fuel and CO₂ impact panel'],
      ['signal-inventory', 'Signal inventory table'],
    ],
  },
  {
    slug: 'live-lab', name: 'Live Lab', identifier: 'LIVE', route: '/live',
    sections: [
      ['experiment-form', 'Experiment job form'],
      ['real-world-areas', 'Real-world areas'],
      ['stop-all', 'Stop all running'],
      ['view-heatmap', '2D Heatmap view'],
      ['view-city-3d', '3D City Grid view'],
      ['view-world', 'World Map view'],
      ['view-digital-twin', '3D Intersection (digital twin) view'],
      ['emergency-panel', 'Emergency vehicles'],
      ['fuel-card', 'Fuel and emissions'],
      ['swarm-calls', 'Swarm green-wave calls'],
      ['jobs-table', 'Jobs table'],
    ],
  },
  {
    slug: 'before-after', name: 'Before / After', identifier: 'DUAL', route: '/demo',
    sections: [
      ['demo-form', 'Demo job form'],
      ['demo-jobs', 'Demo jobs list'],
      ['live-comparison', 'Live side-by-side comparison'],
      ['replay', 'Historical replay'],
      ['emergency-panels', 'Per-side emergency panels'],
      ['fuel-card', 'Fuel and emissions'],
      ['kpi-table', 'KPI comparison table'],
    ],
  },
  {
    slug: 'controllers', name: 'Controllers', identifier: 'EVAL', route: '/controllers',
    sections: [
      ['evaluation-ci-chart', 'Evaluation confidence-interval chart'],
      ['evaluation-paired-tests', 'Evaluation paired statistical tests'],
      ['saved-run-charts', 'Saved-run KPI charts'],
      ['saved-run-kpi-table', 'Saved-run KPI table'],
      ['saved-run-config', 'Controller configurations'],
    ],
  },
  {
    slug: 'prediction', name: 'Prediction', identifier: 'AI', route: '/prediction',
    sections: [
      ['forecast-controls', 'Place, horizon and feed controls'],
      ['junction-selector', 'Junction selector'],
      ['kpi-cards', 'Forecast KPI cards'],
      ['queue-graph', 'Predictive queue graph'],
      ['preemptive-action', 'Pre-emptive swarm action'],
    ],
  },
  {
    slug: 'mixed-traffic', name: 'Mixed Traffic', identifier: 'MIX', route: '/mixed',
    sections: [
      ['city-selector', 'City selector'],
      ['composition-controls', 'Composition controls'],
      ['fleet-breakdown', 'Fleet breakdown chart'],
      ['impact-highlights', 'Fuel, delay and CO₂ highlights'],
      ['comparison-graph', 'Fixed vs Swarm comparison graph'],
    ],
  },
  {
    slug: 'how-it-works', name: 'How It Works', identifier: 'VIVA', route: null,
    sections: [
      ['compare-cards', 'Fixed timer vs swarm cards'],
      ['lookahead', 'Lookahead platooning'],
      ['architecture-flow', 'Decentralised architecture flow'],
      ['aco-weighting', 'ACO pheromone weighting and rules'],
      ['fuel-savings', 'Fuel, CO₂ and savings'],
      ['ambulance-wave', 'Ambulance green wave'],
      ['evaluator-qa', 'Evaluator Q&A'],
    ],
  },
];

const BY_SLUG = new Map(MODULES.map(m => [m.slug, m]));

export const findModule = slug => BY_SLUG.get(slug) || null;
export const hasSection = (moduleSlug, sectionSlug) => !!findModule(moduleSlug)?.sections.some(([s]) => s === sectionSlug);
export const moduleForRoute = pathname => MODULES.find(m => m.route === pathname) || null;

// Build the public, effective config from saved rows. A section is available only while its module is.
// Anything without a row counts as enabled, so a new section cannot vanish before the seed reaches it.
export function buildEffectiveConfig(moduleRows = [], sectionRows = []) {
  const modules = {};
  for (const m of MODULES) {
    const row = moduleRows.find(r => r.slug === m.slug);
    const enabled = row ? row.is_enabled === true : true;
    const sections = {};
    for (const [slug] of m.sections) {
      const saved = row ? sectionRows.find(r => r.module_id === row.id && r.slug === slug) : null;
      sections[slug] = enabled && (saved ? saved.is_enabled === true : true);
    }
    modules[m.slug] = { enabled, sections };
  }
  return { modules };
}

export const ALL_ENABLED = buildEffectiveConfig();
export const firstEnabledRoute = config => MODULES.find(m => m.route && config.modules[m.slug]?.enabled)?.route || null;
