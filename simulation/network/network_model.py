"""Topology and signal-program model read directly from a SUMO .net.xml (no TraCI, no sumolib).

Everything the controller needs is discovered from the network file: traffic-light ids,
their programs, controlled links (with approach direction), and the TLS neighbor graph.
Nothing here assumes a grid, a junction naming scheme, or four approaches.
"""
from __future__ import annotations
import hashlib, heapq, math, re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
import xml.etree.ElementTree as ET


@dataclass(frozen=True)
class Link:
    index: int
    from_edge: str
    to_edge: str
    from_lane: str          # "" for pedestrian links
    to_lane: str
    direction: str          # SUMO dir attribute: s, l, r, t, L, R
    pedestrian: bool
    approach: str           # compass side the traffic arrives FROM: N, E, S, W (or "" if unknown)


@dataclass(frozen=True)
class Phase:
    duration: float
    state: str


@dataclass
class TrafficLight:
    id: str
    program_id: str
    tl_type: str
    phases: list
    links: dict = field(default_factory=dict)   # link index -> list[Link]
    junctions: set = field(default_factory=set)

    @property
    def link_count(self) -> int:
        return (max(self.links) + 1) if self.links else 0


_GENERATED = re.compile(r"<!--\s*generated on.*?-->", re.S)


def net_content_hash(path: str | Path) -> str:
    """sha256 of the net file without netconvert's header comment (timestamps, absolute paths)."""
    text = Path(path).read_text(encoding="utf-8")
    return hashlib.sha256(_GENERATED.sub("", text, count=1).encode("utf-8")).hexdigest()


def _bearing_side(x0: float, y0: float, x1: float, y1: float) -> str:
    """Side of the junction a vehicle travelling (x0,y0)->(x1,y1) arrives from."""
    dx, dy = x1 - x0, y1 - y0
    if dx == 0 and dy == 0:
        return ""
    angle = math.degrees(math.atan2(dy, dx)) % 360   # 0 = heading east
    if 45 <= angle < 135:
        return "S"      # heading north -> arrives from the south
    if 135 <= angle < 225:
        return "E"
    if 225 <= angle < 315:
        return "N"
    return "W"


DEFAULT_NEIGHBOR_DISTANCE_M = 600.0


def _lane_allows(lane: dict, vclass: str) -> bool:
    allow, disallow = lane.get("allow"), lane.get("disallow")
    if allow is not None:
        tokens = allow.split()
        return "all" in tokens or vclass in tokens
    if disallow is not None:
        tokens = disallow.split()
        return not ("all" in tokens or vclass in tokens)
    return True


class NetworkModel:
    def __init__(self, path: Path, junctions: dict, edges: dict, lanes: dict, tls: dict,
                 neighbor_max_distance: float = DEFAULT_NEIGHBOR_DISTANCE_M):
        self.path = Path(path)
        self.junctions = junctions      # id -> {"x","y","type"}
        self.edges = edges              # id -> {"from","to","function","length","lanes":[ids]}
        self.lanes = lanes              # lane id -> {"edge","length","allow","disallow"}
        self.neighbor_max_distance = float(neighbor_max_distance)
        self.tls = tls                  # id -> TrafficLight
        self.junction_tls = {j: t.id for t in tls.values() for j in t.junctions}
        self._neighbors: dict[str, dict[str, float]] | None = None
        self._downstream: dict[tuple[str, int], tuple] = {}
        self.successors: dict[str, set[str]] = defaultdict(set)    # edge -> edges reachable via a connection
        self._routable: dict[str, set[str]] = {}
        self.out_edges: dict[str, list[str]] = defaultdict(list)   # node -> normal outgoing edges
        for eid, info in edges.items():
            if not info["function"]:
                self.out_edges[info["from"]].append(eid)

    # ------------------------------------------------------------------ loading
    @classmethod
    def from_net_file(cls, path: str | Path, neighbor_max_distance: float = DEFAULT_NEIGHBOR_DISTANCE_M) -> "NetworkModel":
        root = ET.parse(path).getroot()
        junctions = {j.get("id"): {"x": float(j.get("x")), "y": float(j.get("y")), "type": j.get("type")}
                     for j in root.findall("junction")}
        edges, lanes = {}, {}
        for e in root.findall("edge"):
            eid = e.get("id")
            lane_ids = []
            for lane in e.findall("lane"):
                lanes[lane.get("id")] = {"edge": eid, "length": float(lane.get("length", 0)),
                                         "allow": lane.get("allow"), "disallow": lane.get("disallow")}
                lane_ids.append(lane.get("id"))
            length = max((lanes[l]["length"] for l in lane_ids), default=0.0)
            edges[eid] = {"from": e.get("from"), "to": e.get("to"), "function": e.get("function", ""),
                          "length": length, "lanes": lane_ids}
        tls = {}
        for t in root.findall("tlLogic"):
            phases = [Phase(float(p.get("duration")), p.get("state")) for p in t.findall("phase")]
            # A TLS can have several programs; the first one in the file is what SUMO starts with.
            tls.setdefault(t.get("id"), TrafficLight(t.get("id"), t.get("programID"), t.get("type"), phases))
        model = cls(path, junctions, edges, lanes, tls, neighbor_max_distance)
        for c in root.findall("connection"):
            frm, to = c.get("from"), c.get("to")
            if not frm.startswith(":") and not to.startswith(":"):
                model.successors[frm].add(to)
            tl = c.get("tl")
            if not tl or tl not in tls:
                continue
            frm, to = c.get("from"), c.get("to")
            pedestrian = frm.startswith(":") or to.startswith(":")
            approach = ""
            if not pedestrian and frm in edges:
                a, b = edges[frm]["from"], edges[frm]["to"]
                if a in junctions and b in junctions:
                    approach = _bearing_side(junctions[a]["x"], junctions[a]["y"], junctions[b]["x"], junctions[b]["y"])
                tls[tl].junctions.add(b)
            link = Link(int(c.get("linkIndex")), frm, to,
                        "" if pedestrian else f"{frm}_{c.get('fromLane')}",
                        "" if pedestrian else f"{to}_{c.get('toLane')}",
                        c.get("dir", ""), pedestrian, approach)
            tls[tl].links.setdefault(link.index, []).append(link)
        model.junction_tls = {j: t.id for t in tls.values() for j in t.junctions}
        return model

    # ------------------------------------------------------------------ topology
    @property
    def tls_ids(self) -> list[str]:
        return sorted(self.tls)

    def _reach(self, edge: str, origin_tls: str) -> dict[str, float]:
        """TLS reachable from `edge` without passing another TLS, within neighbor_max_distance.

        Searches through any number of unsignalized junctions (branching allowed), so irregular
        networks such as OSM imports keep their real adjacency. Returns {tls: shortest distance}.
        """
        found: dict[str, float] = {}
        if edge not in self.edges:
            return found
        heap = [(self.edges[edge]["length"], edge)]
        settled: set[str] = set()
        while heap:
            dist, e = heapq.heappop(heap)
            if e in settled or dist > self.neighbor_max_distance:
                continue
            settled.add(e)
            node = self.edges[e]["to"]
            tl = self.junction_tls.get(node)
            if tl is not None:
                if tl != origin_tls and dist < found.get(tl, math.inf):
                    found[tl] = dist
                continue                      # never search beyond a signalized junction
            for nxt in self.out_edges.get(node, []):
                if self.edges[nxt]["to"] != self.edges[e]["from"] and nxt not in settled:
                    heapq.heappush(heap, (dist + self.edges[nxt]["length"], nxt))
        return found

    def downstream_tls(self, tls_id: str, link_index: int) -> tuple:
        """TLS reached by the vehicles of one controlled link (may be several after a branch)."""
        key = (tls_id, link_index)
        if key not in self._downstream:
            targets: set[str] = set()
            for link in self.tls[tls_id].links.get(link_index, []):
                if not link.pedestrian:
                    targets.update(self._reach(link.to_edge, tls_id))
            self._downstream[key] = tuple(sorted(targets))
        return self._downstream[key]

    def neighbor_graph(self) -> dict[str, dict[str, float]]:
        """Undirected TLS adjacency: tls -> {neighbor_tls: road distance in metres}."""
        if self._neighbors is None:
            graph: dict[str, dict[str, float]] = {t: {} for t in self.tls}
            for tid, tl in self.tls.items():
                outgoing = {e for j in tl.junctions for e in self.out_edges.get(j, [])}
                for e in sorted(outgoing):
                    for other, dist in self._reach(e, tid).items():
                        best = min(dist, graph[tid].get(other, math.inf))
                        graph[tid][other] = best
                        graph[other][tid] = min(best, graph[other].get(tid, math.inf))
            self._neighbors = graph
        return self._neighbors

    # ------------------------------------------------------------------ roads and permissions
    def edge_allows(self, edge: str, vclass: str) -> bool:
        info = self.edges.get(edge)
        return bool(info) and not info["function"] and any(_lane_allows(self.lanes[l], vclass) for l in info["lanes"])

    def routable_edges(self, vclass: str) -> set[str]:
        """Largest strongly connected set of edges usable by `vclass`, following the network's real
        lane connections (turn restrictions included). Any trip between two of these edges can be routed."""
        if vclass in self._routable:
            return self._routable[vclass]
        nodes = [e for e in self.normal_edges() if self.edge_allows(e, vclass)]
        allowed = set(nodes)
        succ = {e: [n for n in self.successors.get(e, ()) if n in allowed] for e in nodes}
        pred: dict[str, list[str]] = {e: [] for e in nodes}
        for e, ns in succ.items():
            for n in ns:
                pred[n].append(e)
        order, seen = [], set()                      # Kosaraju, iterative
        for start in nodes:
            if start in seen:
                continue
            seen.add(start)
            stack = [(start, iter(succ[start]))]
            while stack:
                node, it = stack[-1]
                nxt = next((n for n in it if n not in seen), None)
                if nxt is None:
                    order.append(node); stack.pop()
                else:
                    seen.add(nxt); stack.append((nxt, iter(succ[nxt])))
        best, assigned = set(), set()
        for start in reversed(order):
            if start in assigned:
                continue
            comp, stack = set(), [start]
            assigned.add(start)
            while stack:
                node = stack.pop(); comp.add(node)
                for p in pred[node]:
                    if p not in assigned:
                        assigned.add(p); stack.append(p)
            if len(comp) > len(best):
                best = comp
        self._routable[vclass] = best
        return best

    def normal_edges(self) -> list[str]:
        return sorted(e for e, v in self.edges.items() if not v["function"])

    def _adjacent_nodes(self, node: str) -> set[str]:
        adj = {self.edges[e]["to"] for e in self.out_edges.get(node, [])}
        adj |= {v["from"] for v in self.edges.values() if not v["function"] and v["to"] == node}
        return adj

    def fringe_edges(self) -> tuple[list[str], list[str]]:
        """(entry edges, exit edges) at network boundaries / dead ends: the node on the outer side
        connects to exactly one other node. Works for grids and clipped OSM extracts alike."""
        degree_cache: dict[str, set[str]] = {}
        def adj(node):
            if node not in degree_cache:
                degree_cache[node] = self._adjacent_nodes(node)
            return degree_cache[node]
        entries = [e for e in self.normal_edges() if len(adj(self.edges[e]["from"])) == 1]
        exits = [e for e in self.normal_edges() if len(adj(self.edges[e]["to"])) == 1]
        return entries, exits

    def center(self) -> tuple[float, float]:
        xs = [j["x"] for j in self.junctions.values()]; ys = [j["y"] for j in self.junctions.values()]
        return (sum(xs) / len(xs), sum(ys) / len(ys)) if xs else (0.0, 0.0)

    def edge_side(self, edge: str) -> str:
        """Compass side (N/E/S/W) of the edge's outer node relative to the network centre."""
        info = self.edges[edge]
        node = self.junctions.get(info["from"]) or self.junctions.get(info["to"])
        cx, cy = self.center()
        dx, dy = node["x"] - cx, node["y"] - cy
        if abs(dx) >= abs(dy):
            return "E" if dx > 0 else "W"
        return "N" if dy > 0 else "S"

    def neighbors(self, tls_id: str) -> list[str]:
        return sorted(self.neighbor_graph().get(tls_id, {}))

    def adjacency_edge_count(self) -> int:
        return sum(len(v) for v in self.neighbor_graph().values()) // 2

    def degree_histogram(self) -> dict[int, int]:
        hist: dict[int, int] = defaultdict(int)
        for v in self.neighbor_graph().values():
            hist[len(v)] += 1
        return dict(sorted(hist.items()))

    def connected_components(self) -> int:
        graph, seen, count = self.neighbor_graph(), set(), 0
        for start in graph:
            if start in seen:
                continue
            count += 1
            stack = [start]
            while stack:
                node = stack.pop()
                if node in seen:
                    continue
                seen.add(node)
                stack.extend(graph[node])
        return count
