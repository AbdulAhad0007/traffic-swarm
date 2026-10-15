"""Per-run scenario construction for generated and OSM networks.

Produces, for one (network, scenario, demand seed):
  routes.rou.xml   validated demand (vehicle types from the configured mix, optional pedestrians)
  closure.add.xml  a real road closure (SUMO rerouter + closingReroute) for 'road-closure'
  sumo.sumocfg     configuration used by every controller of the run

Demand is fully determined by the preset, the scenario profile and an explicit demand seed, so
the fixed-time and swarm controllers always receive identical inputs. Routes are checked with
SUMO's duarouter (vehicle-class permissions included); generation fails if more than
`max_dropped_trip_share` of the trips cannot be routed.
"""
from __future__ import annotations
import random, subprocess
from collections import Counter, deque
from pathlib import Path
import xml.etree.ElementTree as ET
from simulation.network.demand import grid_flows
from simulation.network.grid_generator import find_sumo_binary
from simulation.network.network_model import NetworkModel
from simulation.network.vehicle_types import resolve_mix, add_vtypes, vclass_of


class DemandError(RuntimeError):
    pass


def scenario_profile(preset: dict, scenario: str) -> dict:
    profiles = preset.get("scenarios", {})
    if scenario not in profiles:
        raise ValueError(f"scenario '{scenario}' is not defined; available: {', '.join(sorted(profiles))}")
    profile = profiles[scenario]
    for seg in profile["segments"]:
        a, b, m = seg
        if not (0 <= a < b <= 1) or m < 0:
            raise ValueError(f"invalid segment {seg} in scenario '{scenario}'")
    return profile


def _windows(demand: dict, profile: dict) -> list[tuple[float, float, float]]:
    begin, end = float(demand["begin_s"]), float(demand["end_s"])
    span = end - begin
    return [(begin + a * span, begin + b * span, float(m)) for a, b, m in profile["segments"]]


def _side_weight(profile: dict, side: str) -> float:
    return float(profile.get("side_weights", {}).get(side, 1.0))


# ------------------------------------------------------------------ grid demand (flows)
def grid_flow_elements(preset: dict, model: NetworkModel, profile: dict, mix: dict, seed: int | None = None) -> list[dict]:
    demand = preset["demand"]
    windows = _windows(demand, profile)
    # The explicit demand seed chooses the turning-flow destinations (default: the preset's demand_seed).
    flows = grid_flows(preset["rows"], preset["cols"], demand if seed is None else {**demand, "demand_seed": seed})
    single = len(windows) == 1 and len(mix) == 1
    out = []
    for i, f in enumerate(flows):
        weight = _side_weight(profile, model.edge_side(f["from"]))
        for k, (b, e, m) in enumerate(windows):
            for vt, share in mix.items():
                vph = f["vph"] * m * share * weight
                if vph <= 0:
                    continue
                fid = f"f{i:03d}" if single else f"f{i:03d}_s{k}_{vt}"
                out.append({"kind": "flow", "id": fid, "type": vt, "from": f["from"], "to": f["to"],
                            "begin": b, "end": e, "vph": vph})
    return out


# ------------------------------------------------------------------ OSM / generic demand (trips)
def trip_elements(preset: dict, model: NetworkModel, profile: dict, mix: dict, seed: int) -> list[dict]:
    demand = preset["demand"]
    rng = random.Random(seed)
    entries, exits = model.fringe_edges()
    out = []
    for vt, share in mix.items():
        vclass = vclass_of(vt)
        # Only boundary roads inside the largest strongly connected part of the network for this
        # vehicle class: every origin-destination pair is then routable (one-ways respected).
        core = model.routable_edges(vclass)
        origins = [e for e in entries if e in core]
        dests = [e for e in exits if e in core]
        if not origins or not dests:
            raise DemandError(f"no boundary roads permit vClass '{vclass}' (vehicle type '{vt}')")
        weights = [_side_weight(profile, model.edge_side(e)) for e in origins]
        for b, e, m in _windows(demand, profile):
            rate = float(demand["vehicles_per_hour"]) * m * share / 3600.0     # vehicles per second
            t = b
            while rate > 0:
                t += rng.expovariate(rate)                                      # Poisson arrivals
                if t >= e:
                    break
                o = rng.choices(origins, weights)[0]
                candidates = [d for d in dests if d != o and model.edges[d]["to"] != model.edges[o]["from"]]
                if not candidates:
                    continue
                out.append({"kind": "trip", "type": vt, "from": o, "to": rng.choice(candidates), "depart": round(t, 2)})
    out.sort(key=lambda x: (x["depart"], x["type"], x["from"]))
    for n, x in enumerate(out):
        x["id"] = f"t{n:05d}_{x['type']}"
    return out


def person_elements(preset: dict, model: NetworkModel, profile: dict, seed: int) -> list[dict]:
    pph = float(preset["demand"].get("persons_per_hour", 0) or 0)
    if pph <= 0:
        return []
    walkable = sorted(model.routable_edges("pedestrian"))
    if len(walkable) < 2:
        raise DemandError("persons_per_hour > 0 but the network has no pedestrian edges (enable pedestrians/sidewalks)")
    rng = random.Random(seed ^ 0x5EED)
    out = []
    for b, e, m in _windows(preset["demand"], profile):
        rate, t = pph * m / 3600.0, b
        while rate > 0:
            t += rng.expovariate(rate)
            if t >= e:
                break
            frm, to = rng.sample(walkable, 2)
            out.append({"kind": "person", "from": frm, "to": to, "depart": round(t, 2)})
    for n, x in enumerate(out):
        x["id"] = f"p{n:05d}"
    return out


def emergency_elements(preset: dict, model: NetworkModel, count: int, seed: int, spec: dict | None = None) -> list[dict]:
    """`count` ambulance trips between distant boundary roads (deterministic for a seed).

    Origins/destinations are boundary roads in the part of the network routable for vClass
    'emergency'; pairs are ranked by straight-line distance and drawn from the longest ones, so the
    ambulance crosses several signalised junctions."""
    if count <= 0:
        return []
    spec = {"vtype": "ambulance", "first_depart_s": 120.0, "spacing_s": 200.0, "candidates": 8, **(spec or {})}
    vclass = vclass_of(spec["vtype"])
    entries, exits = model.fringe_edges()
    core = model.routable_edges(vclass)
    # A boundary road qualifies if it is in the strongly connected core or leads into it (entry) /
    # is reached from it (exit): core is strongly connected, so origin -> core -> destination is routable.
    feeds = lambda e: e in core or any(n in core for n in model.successors.get(e, ()))
    fed = lambda e: e in core or any(e in model.successors.get(c, ()) for c in core)
    origins = [e for e in entries if model.edge_allows(e, vclass) and feeds(e)]
    dests = [e for e in exits if model.edge_allows(e, vclass) and fed(e)]
    if not origins or not dests:
        raise DemandError(f"no boundary roads permit vClass '{vclass}' for ambulances")
    def pos(edge, end):
        j = model.junctions[model.edges[edge]["to" if end else "from"]]
        return j["x"], j["y"]
    pairs = []
    for o in origins:
        ox, oy = pos(o, False)
        for d in dests:
            if model.edges[d]["to"] == model.edges[o]["from"]:
                continue
            dx, dy = pos(d, True)
            pairs.append((-((ox - dx) ** 2 + (oy - dy) ** 2), o, d))
    pairs.sort()
    top = pairs[:max(1, int(spec["candidates"]))]
    rng = random.Random(seed ^ 0xA3B)
    out = []
    for n in range(count):
        _, o, d = rng.choice(top)
        out.append({"kind": "trip", "id": f"amb{n:02d}", "type": spec["vtype"], "from": o, "to": d,
                    "depart": round(float(spec["first_depart_s"]) + n * float(spec["spacing_s"]), 2)})
    return out


def _start(x: dict) -> float:
    return x.get("begin", x.get("depart", 0.0))


def write_demand(elements: list[dict], vtypes, path: Path) -> Path:
    root = ET.Element("routes")
    add_vtypes(root, vtypes)
    for x in sorted(elements, key=_start):          # SUMO needs departures in time order
        if x["kind"] == "flow":
            ET.SubElement(root, "flow", {"id": x["id"], "type": x["type"], "from": x["from"], "to": x["to"],
                                         "begin": f"{x['begin']:g}", "end": f"{x['end']:g}", "vehsPerHour": f"{x['vph']:g}"})
        elif x["kind"] == "trip":
            ET.SubElement(root, "trip", {"id": x["id"], "type": x["type"], "depart": f"{x['depart']:.2f}",
                                         "from": x["from"], "to": x["to"]})
        else:
            p = ET.SubElement(root, "person", {"id": x["id"], "depart": f"{x['depart']:.2f}"})
            ET.SubElement(p, "walk", {"from": x["from"], "to": x["to"]})
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return path


def route_with_duarouter(net: Path, demand_file: Path, out: Path, seed: int) -> dict:
    """Route/validate with duarouter. Returns counts; raises DemandError if duarouter fails."""
    binary = find_sumo_binary("duarouter")
    if binary is None:
        raise DemandError("duarouter is required to validate routes; install SUMO.")
    proc = subprocess.run([binary, "--net-file", str(net), "--route-files", str(demand_file), "--output-file", str(out),
                           "--ignore-errors", "true", "--seed", str(seed), "--no-step-log", "true"],
                          capture_output=True, text=True)
    (out.parent / "duarouter.log").write_text(proc.stdout + proc.stderr, encoding="utf-8")
    if proc.returncode != 0 or not out.is_file():
        raise DemandError(f"duarouter failed (exit {proc.returncode}); see {out.parent / 'duarouter.log'}")
    requested = [el.get("id") for el in ET.parse(demand_file).getroot() if el.tag in ("flow", "trip", "person")]
    # duarouter may expand a flow into vehicles "<flowid>.<n>"; map every output id back to its source id.
    routed_ids = set()
    for el in ET.parse(out).getroot():
        if el.tag in ("flow", "trip", "vehicle", "person"):
            vid = el.get("id")
            routed_ids.add(vid)
            routed_ids.add(vid.rsplit(".", 1)[0])
    dropped = [i for i in requested if i not in routed_ids]
    return {"requested": len(requested), "routed": len(requested) - len(dropped), "dropped": len(dropped),
            "dropped_examples": dropped[:5],
            "errors": sum(1 for l in (proc.stdout + proc.stderr).splitlines() if l.startswith("Error"))}


def edge_usage(routed_file: Path) -> Counter:
    """Planned use of each edge, weighted by flow rate (flows) or 1 per vehicle."""
    usage: Counter = Counter()
    for el in ET.parse(routed_file).getroot():
        route = el.find("route")
        if route is None or el.tag not in ("vehicle", "flow"):
            continue
        weight = float(el.get("vehsPerHour", 0)) / 100.0 if el.tag == "flow" else 1.0
        for edge in route.get("edges", "").split():
            usage[edge] += weight
    return usage


# ------------------------------------------------------------------ road closure
def _has_alternative(model: NetworkModel, edge: str, vclass: str = "passenger") -> bool:
    """True if every legal movement THROUGH the edge (predecessor -> edge -> successor, following lane
    connections, so turn restrictions and the absence of U-turns count) has a detour that avoids it.
    A node-level check is not enough: at a grid corner, traffic arriving from one side may have no
    legal way around a closed edge even though its end node is reachable from its start node."""
    allowed = lambda e: e != edge and model.edge_allows(e, vclass)
    preds = [p for p, succ in model.successors.items() if edge in succ and allowed(p)]
    succs = {s for s in model.successors.get(edge, ()) if allowed(s)}
    if not preds or not succs:
        return False
    for p in preds:
        seen, queue = {p}, deque([p])
        while queue:
            for nxt in model.successors.get(queue.popleft(), ()):
                if nxt not in seen and allowed(nxt):
                    seen.add(nxt); queue.append(nxt)
        if not succs <= seen:
            return False
    return True


def trip_endpoints(routed_file: Path) -> set:
    """First and last edge of every routed vehicle/flow: a closure there would trap trips that start or end on it."""
    ends = set()
    for el in ET.parse(routed_file).getroot():
        route = el.find("route")
        if route is not None and el.tag in ("vehicle", "flow"):
            edges = route.get("edges", "").split()
            if edges:
                ends.update((edges[0], edges[-1]))
    return ends


def choose_closure_edge(model: NetworkModel, usage: Counter, endpoints: set = frozenset()) -> tuple[str, dict]:
    entries, exits = model.fringe_edges()
    fringe = set(entries) | set(exits)
    candidates = [e for e in model.normal_edges()
                  if e not in fringe and e not in endpoints and model.edge_allows(e, "passenger") and usage.get(e, 0) > 0]
    candidates.sort(key=lambda e: (-usage[e], e))
    for e in candidates:
        if _has_alternative(model, e):
            return e, {"planned_use": round(usage[e], 3), "candidates_considered": len(candidates)}
    raise DemandError("no closable edge with an alternative path was found")


def write_closure(model: NetworkModel, edge: str, begin: float, end: float, path: Path) -> Path:
    triggers = [e for e in model.normal_edges() if e != edge and model.edge_allows(e, "passenger")]
    root = ET.Element("additional")
    rr = ET.SubElement(root, "rerouter", {"id": "tsi_road_closure", "edges": " ".join(triggers)})
    interval = ET.SubElement(rr, "interval", {"begin": f"{begin:g}", "end": f"{end:g}"})
    ET.SubElement(interval, "closingReroute", {"id": edge})
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return path


# ------------------------------------------------------------------ config
def write_run_cfg(path: Path, net: Path, routes: Path, additional: list[Path], sim: dict) -> Path:
    root = ET.Element("configuration")
    inp = ET.SubElement(root, "input")
    ET.SubElement(inp, "net-file", value=net.resolve().as_posix())
    ET.SubElement(inp, "route-files", value=routes.resolve().as_posix())
    if additional:
        ET.SubElement(inp, "additional-files", value=",".join(a.resolve().as_posix() for a in additional))
    t = ET.SubElement(root, "time")
    ET.SubElement(t, "begin", value="0")
    ET.SubElement(t, "end", value=f"{float(sim['end_s']):g}")
    proc = ET.SubElement(root, "processing")
    ET.SubElement(proc, "time-to-teleport", value=f"{float(sim['time_to_teleport_s']):g}")
    if sim.get("lateral_resolution"):
        ET.SubElement(proc, "lateral-resolution", value=f"{float(sim['lateral_resolution']):g}")
    ET.indent(root)
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return path


def build_scenario(info: dict, scenario: str, run_dir: Path, demand_seed: int | None = None,
                   ambulances: int | None = None) -> dict:
    preset, model, net = info["preset"], info["model"], Path(info["net"])
    demand = preset["demand"]
    seed = int(demand.get("demand_seed", 7) if demand_seed is None else demand_seed)
    profile = scenario_profile(preset, scenario)
    mix = resolve_mix(demand.get("vehicle_mix", "cars_only"))
    run_dir.mkdir(parents=True, exist_ok=True)
    generator = demand.get("generator", "flows")
    if generator == "flows":
        if preset["type"] != "grid":
            raise DemandError("the 'flows' generator needs a grid preset; use 'trips' for OSM networks")
        elements = grid_flow_elements(preset, model, profile, mix, seed)
    elif generator == "trips":
        elements = trip_elements(preset, model, profile, mix, seed)
    else:
        raise DemandError(f"unknown demand generator '{generator}'")
    elements += person_elements(preset, model, profile, seed)
    em_spec = dict(demand.get("emergency") or {})
    n_amb = int(em_spec.get("count", 0) if ambulances is None else ambulances)
    if n_amb < 0 or n_amb > 50:
        raise ValueError("ambulances must be between 0 and 50")
    em = emergency_elements(preset, model, n_amb, seed, em_spec)
    vtypes = list(mix) + sorted({x["type"] for x in em} - set(mix))
    demand_file = write_demand(elements + em, vtypes, run_dir / ("routes.rou.xml" if generator == "flows" else "trips.xml"))
    routed = run_dir / "routes.routed.xml"
    check = route_with_duarouter(net, demand_file, routed, seed)
    max_drop = float(demand.get("max_dropped_trip_share", 0.05))
    if check["requested"] == 0:
        raise DemandError("scenario produced no demand")
    if check["dropped"] / check["requested"] > max_drop:
        raise DemandError(f"{check['dropped']} of {check['requested']} trips could not be routed (> {max_drop:.0%})")
    # Flows keep from/to (SUMO routes them identically at insertion, preserving Phase-1 demand);
    # trips use the duarouter output so every vehicle starts with a validated route.
    routes = demand_file if generator == "flows" else routed
    additional, closure_meta = [], None
    if profile.get("closure"):
        cl = profile["closure"]
        edge, why = (cl["edge"], {"chosen": "configured"}) if cl.get("edge") not in (None, "auto") \
            else choose_closure_edge(model, edge_usage(routed), trip_endpoints(routed))
        if edge not in model.edges:
            raise DemandError(f"closure edge '{edge}' is not in the network")
        begin = float(cl.get("begin_s", 0))
        end = float(cl["end_s"]) if cl.get("end_s") is not None else float(preset["simulation"]["end_s"])
        additional.append(write_closure(model, edge, begin, end, run_dir / "closure.add.xml"))
        closure_meta = {"edge": edge, "begin_s": begin, "end_s": end, "mechanism": "SUMO rerouter closingReroute",
                        "from_node": model.edges[edge]["from"], "to_node": model.edges[edge]["to"], **why}
    cfg = write_run_cfg(run_dir / "sumo.sumocfg", net, routes, additional, preset["simulation"])
    counts = Counter(x["type"] for x in elements if x["kind"] == "trip")
    flow_vph = Counter()
    for x in elements:
        if x["kind"] == "flow":
            flow_vph[x["type"]] += x["vph"] * (x["end"] - x["begin"]) / 3600.0
    meta = {"scenario": scenario, "generator": generator, "demand_seed": seed, "vehicle_mix": demand.get("vehicle_mix"),
            "mix_shares": mix, "profile": profile, "route_check": check,
            "trips_by_type": dict(counts) if counts else None,
            "flows": sum(1 for x in elements if x["kind"] == "flow"),
            "persons": sum(1 for x in elements if x["kind"] == "person"), "closure": closure_meta,
            "expected_vehicles_by_type": {k: round(v, 1) for k, v in flow_vph.items()} or dict(counts) or None,
            "ambulances": [{"id": x["id"], "from": x["from"], "to": x["to"], "depart_s": x["depart"]} for x in em],
            "lateral_resolution": preset["simulation"].get("lateral_resolution")}
    return {"sumocfg": cfg, "routes": routes, "additional": additional, "closure": closure_meta, "meta": meta}
