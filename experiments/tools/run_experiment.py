#!/usr/bin/env python3
"""Run one experiment: several controllers on the identical network, demand and seed.

Controller variants (see VARIANTS): fixed (SUMO program as built), actuated (SUMO gap-based
actuation of the same phases), swarm (PSO+ACO Controller V2) and swarm/fixed with emergency
priority, plus swarm ablations. The default pair (fixed, swarm) keeps the original
comparison.json layout ('baseline' / 'swarm') used by the backend and earlier tools.
"""
from pathlib import Path
import argparse, hashlib, json, platform, sys, time
from datetime import datetime, timezone

# Make direct script execution work from any working directory.
PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from simulation.baseline.fixed_time_controller import FixedTimeController
from simulation.baseline.actuated_controller import ActuatedController
from simulation.swarm.adaptive_controller import AdaptiveController
from simulation.network.build_network import ensure_network
from simulation.network.scenario_builder import build_scenario
from simulation.network.presets import LEGACY_PRESET, preset_names
from simulation.network.network_model import NetworkModel
from simulation.network.phase_map import build_all
from simulation.runtime import net_file_from_cfg
from simulation.version import TSI_VERSION
from experiments.tools.scenario_generator import generate
from experiments.tools.kpi_engine import build_comparison, compare
SCENARIOS=('normal','rush-hour','uneven','sudden-congestion','road-closure')

# name -> (controller kind, output sub-directory, emergency priority enabled, controller-setting overrides)
VARIANTS = {
    'fixed':               ('fixed', 'baseline', False, {}),
    'actuated':            ('actuated', 'actuated', False, {}),
    'swarm':               ('swarm', 'swarm', False, {}),
    'fixed_priority':      ('fixed', 'fixed_priority', True, {}),
    'swarm_priority':      ('swarm', 'swarm_priority', True, {}),
    'swarm_no_blackboard': ('swarm', 'swarm_no_blackboard', False, {'use_blackboard': False}),
    'swarm_no_pheromone':  ('swarm', 'swarm_no_pheromone', False, {'use_pheromone': False}),
    'swarm_prediction':    ('swarm', 'swarm_prediction', False, {'use_prediction': True}),
}
DEFAULT_CONTROLLERS = ('fixed', 'swarm')

def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def run_dir_for(root, network, scenario, seed):
    # The legacy network keeps its original location so the backend orchestrator keeps working.
    if network == LEGACY_PRESET:
        return root/f'experiments/runs/{scenario}/seed-{seed}'
    return root/f'experiments/runs/{network}/{scenario}/seed-{seed}'

def _controller(variant, seed, settings, gui, hooks, port):
    kind, _sub, _prio, overrides = VARIANTS[variant]
    s = {**settings, **overrides}
    if kind == 'fixed':
        return FixedTimeController(seed, gui=gui, settings=s, hooks=hooks, port=port)
    if kind == 'actuated':
        return ActuatedController(seed, gui=gui, settings=s, hooks=hooks, port=port)
    return AdaptiveController(seed, settings=s, gui=gui, hooks=hooks, port=port)

def build_hooks(variant, cfg, out_dir, settings, has_ambulances, live=False, run_info=None, stop_file=None,
                realtime_factor=None, emergency_options=None):
    """Live recorder (always: it is cheap and feeds replay/prediction) + emergency tracking when ambulances exist."""
    from simulation.live.recorder import LiveRecorder
    from simulation.emergency.priority import EmergencyPriority
    model = NetworkModel.from_net_file(net_file_from_cfg(cfg))
    hooks = [LiveRecorder(model, out_dir, run_info=run_info, stop_file=stop_file,
                          realtime_factor=realtime_factor if live else None)]
    if has_ambulances or VARIANTS[variant][2]:
        maps = {t: pm for t, pm in build_all(model, settings).items() if pm.controllable}
        hooks.append(EmergencyPriority(maps, settings, enabled=VARIANTS[variant][2], out_dir=out_dir,
                                       options=emergency_options))
    return hooks

def prepare(scenario, seed, root, network=LEGACY_PRESET, config=None, demand_seed=None, osm_file=None,
            ambulances=None, run_dir=None):
    """Build/validate the network and the run's scenario. Returns (info, cfg, route, scenario_meta, run_dir)."""
    if scenario not in SCENARIOS: raise ValueError('Unsupported scenario')
    info=ensure_network(network,root,config,osm_file=osm_file)   # builds if needed and validates before simulating
    run_dir=Path(run_dir) if run_dir else run_dir_for(root,network,scenario,seed); run_dir.mkdir(parents=True,exist_ok=True)
    if info['preset']['type']=='legacy':
        if ambulances:
            raise ValueError('ambulance scenarios need a generated or OSM network (the legacy J1-J9 routes are fixed)')
        # Original J1-J9 scenarios (demand multipliers; its 'road-closure' is NOT a real closure).
        route=run_dir/'routes.rou.xml'; generate(info['routes'],route,scenario)
        cfg=run_dir/'sumo.sumocfg'; cfg.write_text(info['sumocfg'].read_text(encoding='utf-8').replace('routes.rou.xml',route.as_posix()).replace('build.net.xml',info['net'].as_posix()), encoding='utf-8')
        scenario_meta={'scenario':scenario,'generator':'legacy_multiplier','closure':None,
                       'note':'legacy road-closure scales demand only; no road is closed'}
    else:
        built=build_scenario(info,scenario,run_dir,demand_seed,ambulances=ambulances)
        cfg,route,scenario_meta=built['sumocfg'],built['routes'],built['meta']
    return info, cfg, route, scenario_meta, run_dir

def run_variant(variant, seed, cfg, run_dir, settings, max_time=3600.0, gui=None, has_ambulances=False,
                live=False, run_info=None, stop_file=None, realtime_factor=None, port=None, emergency_options=None):
    if variant not in VARIANTS:
        raise ValueError(f"unknown controller variant '{variant}'")
    out = Path(run_dir)/VARIANTS[variant][1]
    s = {**settings, **VARIANTS[variant][3]}
    hooks = build_hooks(variant, cfg, out, s, has_ambulances, live, {**(run_info or {}), 'controller': variant},
                        stop_file, realtime_factor, emergency_options)
    summary = _controller(variant, seed, settings, gui, hooks, port).run(cfg, out, max_time=max_time)
    summary['variant'] = variant
    return summary

def metadata(info, cfg, route, scenario_meta, network, seed, max_time, settings, variants, sumo_version):
    meta=info['meta']
    try:
        import traci; traci_version=getattr(traci,'__version__',None)
    except ImportError:
        traci_version=None
    return {
        'generated_at_utc': datetime.now(timezone.utc).isoformat(),
        'simulation_config': str(cfg),
        'scenario_route': str(route),
        'scenario_route_sha256': _sha256(route),
        'controllers': ['fixed-time' if v=='fixed' else v for v in variants],
        'controller_variants': {v: {'kind': VARIANTS[v][0], 'emergency_priority': VARIANTS[v][2],
                                    'setting_overrides': VARIANTS[v][3]} for v in variants},
        'requested_network': network,
        'effective_network': meta.get('preset',network),
        'fallback': {k: meta[k] for k in ('fallback_from','fallback_reason') if k in meta} or None,
        'scenario_definition': scenario_meta,
        'network_source': meta.get('source'),
        'same_seed': seed,
        'max_time_s': max_time,
        'network': {k: meta.get(k) for k in ('preset','type','rows','cols','tls_count','adjacency_edges',
                                             'degree_histogram','components','phase_map_status','net_sha256','config_hash',
                                             'junctions','roads','warnings')},
        'controller_settings': settings,
        'demand': info['preset'].get('demand') if info['preset']['type'] in ('grid','osm') else 'legacy routes.rou.xml',
        'software': {'tsi_version': TSI_VERSION, 'python': platform.python_version(), 'platform': platform.platform(),
                     'sumo': sumo_version, 'traci': traci_version,
                     'netconvert': meta.get('netconvert_version')},
    }

def run(scenario,seed,root,max_time=3600.0,network=LEGACY_PRESET,config=None,gui=None,demand_seed=None,osm_file=None,
        controllers=DEFAULT_CONTROLLERS,ambulances=None,run_dir=None,live=False,stop_file=None,realtime_factor=None,
        emergency_options=None):
    controllers=list(dict.fromkeys(controllers))
    unknown=[c for c in controllers if c not in VARIANTS]
    if unknown or not controllers:
        raise ValueError(f"unknown controller variant(s) {unknown}; available: {', '.join(VARIANTS)}")
    info,cfg,route,scenario_meta,run_dir=prepare(scenario,seed,root,network,config,demand_seed,osm_file,ambulances,run_dir)
    settings=info['preset']['controller']
    has_amb=bool(scenario_meta and scenario_meta.get('ambulances'))
    run_info={'scenario':scenario,'seed':seed,'network':network}
    # Identical route file, network and seed for every controller.
    summaries={}
    for v in controllers:
        t0=time.perf_counter()
        summaries[v]=run_variant(v,seed,cfg,run_dir,settings,max_time,gui,has_amb,live,run_info,stop_file,realtime_factor,
                                 emergency_options=emergency_options)
        summaries[v].setdefault('wall_time_s',round(time.perf_counter()-t0,3))
    reference=controllers[0]
    if 'fixed' in summaries and 'swarm' in summaries:
        # KPI fields are produced by the measured telemetry collectors; never infer throughput from observations.
        result=build_comparison(scenario,seed,summaries['fixed'],summaries['swarm'])
    else:
        result={'scenario':scenario,'seed':seed}
    result['reference_controller']=reference
    result['controllers']=summaries
    result['comparisons']={v: compare(summaries[reference], summaries[v]) for v in controllers if v!=reference}
    result['metadata']=metadata(info,cfg,route,scenario_meta,network,seed,max_time,settings,controllers,
                                next(iter(summaries.values())).get('sumo_version'))
    (run_dir/'comparison.json').write_text(json.dumps(result,indent=2), encoding='utf-8')
    return result

def main():
    p=argparse.ArgumentParser(description='Run one SUMO experiment (identical demand and seed for every controller).')
    p.add_argument('--scenario',choices=SCENARIOS,required=True)
    p.add_argument('--seed',type=int,default=42)
    p.add_argument('--root',default='.')
    p.add_argument('--network',default=LEGACY_PRESET,help='Network preset from simulation/config/networks.json (default: %(default)s)')
    p.add_argument('--config',default=None,help='Alternative networks.json path')
    p.add_argument('--controllers',nargs='+',default=list(DEFAULT_CONTROLLERS),choices=list(VARIANTS),
                   help='Controller variants, the first is the reference for comparisons (default: fixed swarm)')
    p.add_argument('--ambulances',type=int,default=None,help='Number of ambulance trips to add (generated/OSM networks)')
    p.add_argument('--gui',action='store_true',help='Use sumo-gui instead of headless sumo (or set TSI_SUMO_GUI=1).')
    p.add_argument('--demand-seed',type=int,default=None,help='Seed for demand generation (default: the preset demand_seed). Every controller shares it.')
    p.add_argument('--osm-file',default=None,help='.osm file for an OSM preset such as osm_user')
    p.add_argument('--max-time',type=float,default=3600.0,help='Safety cap (simulated seconds) so a gridlocked scenario cannot run indefinitely.')
    args=p.parse_args()
    if args.seed < 0:
        p.error('--seed must be >= 0')
    if args.ambulances is not None and not 0 <= args.ambulances <= 50:
        p.error('--ambulances must be in [0, 50]')
    if args.config is None and args.network not in preset_names():
        p.error(f"unknown --network '{args.network}'; available: {', '.join(preset_names())}")
    result=run(args.scenario,args.seed,Path(args.root).resolve(),max_time=args.max_time,network=args.network,
               config=args.config,gui=True if args.gui else None,demand_seed=args.demand_seed,osm_file=args.osm_file,
               controllers=args.controllers,ambulances=args.ambulances)
    print(json.dumps(result,indent=2))

if __name__=='__main__':
    main()
