"""Lookahead junction mesh: autonomous JunctionAgents that call each other ahead of platoons.

TraCI-free, deterministic 1 s queue model used by the lab API (/api/lab/swarm/mesh/*) and mirrored
rule-for-rule by the browser map (frontend/lib/swarmMesh.js). The SUMO controller keeps its own
safety-gated implementation of the same protocol in simulation/coordination/green_wave.py.

Two meshes always run on *identical* demand (same vehicle ids, same turning choices):
  - "swarm": every junction is a JunctionAgent that
      * broadcasts a platoon alert to the downstream neighbour as soon as vehicles clear it
        (send_platoon_alert(target_id, count, eta)), with the turning split it observed;
      * holds or pre-emptively opens green so an announced platoon arrives on green;
      * never keeps green over an empty approach while the other axis waits (dead-phase
        elimination: a 2-car arm is drained and released after the 6 s minimum green);
      * weights axis pressure with an ACO-style pheromone trail that is reinforced by served
        vehicles and evaporates every second;
      * obeys an emergency corridor lock (forced Yellow -> All-Red -> corridor green, held until
        the ambulance has passed).
  - "fixed": the traditional uncoordinated static timer (30 s green per axis, 70 s cycle).
Every saving reported (idle seconds, litres, CO2, rupees, delay, stops, ambulance delay) is the
measured difference between the two meshes - nothing is assumed.

Simplifications (documented, deliberate): link travel times are time-compressed to 10-28 s so a
platoon is visible on screen; each approach discharges at a single saturation flow; an ambulance
does not queue behind cars (traffic yields to the siren) but cannot cross a red/yellow signal.
"""
from __future__ import annotations
import heapq, math
from collections import deque

DIRS = ("NORTHBOUND", "SOUTHBOUND", "EASTBOUND", "WESTBOUND")
AXIS = {"NORTHBOUND": "NS", "SOUTHBOUND": "NS", "EASTBOUND": "EW", "WESTBOUND": "EW"}
LEFT = {"NORTHBOUND": "WESTBOUND", "WESTBOUND": "SOUTHBOUND", "SOUTHBOUND": "EASTBOUND", "EASTBOUND": "NORTHBOUND"}
RIGHT = {v: k for k, v in LEFT.items()}
OTHER = {"NS": "EW", "EW": "NS"}
SWARM, FIXED = "swarm", "fixed"
M32 = 0xFFFFFFFF

CONFIG = {
    "yellow_s": 3, "all_red_s": 2,
    "min_green_s": 6, "max_green_s": 45, "max_red_s": 75,
    "fixed_green_s": 30,               # traditional static timer, per axis
    "sat_flow_vps": 1.0,               # discharge per approach while green
    "lookahead_s": 12,                 # alerts whose platoon head is closer than this shape decisions
    "platoon_min": 3,                  # a release this big is logged as a platoon
    "batch_gap_s": 2, "batch_max_s": 12,  # an alert always leaves >= 4 s before its platoon head arrives
    "comm_latency_s": 1,
    "cruise_kmh": 42,
    "base_rate_vps": 0.05,             # external arrivals per boundary approach
    "hero_rate_factor": 1.5,
    "burst_every_s": 60, "burst_size": 20, "burst_rate_vps": 2.0,
    "heavy_share": 0.12,
    "straight_pct": 60, "left_pct": 20,
    "log_min_platoon": 5,
    "ambulance_speed_factor": 0.7, "emergency_lock_eta_s": 15,
    "tau_evaporation": 0.02,
}
FUEL = {"car_idle_lph": 0.6, "heavy_idle_lph": 1.8, "co2_kg_per_l": 2.31, "inr_per_l": 96.72}
CLOCK_BASE_S = 10 * 3600 + 14 * 60     # log clock starts at 10:14:00

# Ghaziabad core 3x3 (same coordinates as frontend/lib/cityData.js)
GHAZIABAD_3X3 = [
    ("GZB-1", "Mohan Nagar Chauraha", 28.6787, 77.3884, 1, 0),
    ("GZB-2", "Raj Nagar Extension Crossing", 28.7042, 77.4248, 0, 1),
    ("GZB-3", "Old Bus Stand / Hapur Chungi", 28.6644, 77.4398, 1, 2),
    ("GZB-4", "UP Gate / Anand Vihar Border", 28.6328, 77.3298, 2, 0),
    ("GZB-5", "Vijay Nagar Bypass", 28.6365, 77.4475, 2, 2),
    ("GZB-6", "Vasundhara / CISF Cut", 28.6622, 77.3712, 1, 1),
    ("GZB-7", "Vaishali Sector 4 / Kaushambi", 28.6472, 77.3685, 2, 1),
    ("GZB-8", "Govindpuram T-Point", 28.6812, 77.4815, 0, 2),
    ("GZB-9", "Meerut Road Industrial Cut", 28.6895, 77.4312, 0, 0),
]


# ---------------------------------------------------------------------- deterministic helpers
def _imul(a: int, b: int) -> int:
    return (a * b) & M32


def mulberry32(seed: int):
    """Same generator as the browser engine, so both sides see the same demand stream."""
    state = seed & M32

    def rnd() -> float:
        nonlocal state
        state = (state + 0x6D2B79F5) & M32
        t = state
        t = _imul(t ^ (t >> 15), t | 1)
        t ^= (t + _imul(t ^ (t >> 7), t | 61)) & M32
        return ((t ^ (t >> 14)) & M32) / 4294967296
    return rnd


def hash2(a: int, b: int) -> int:
    x = (_imul(a, 0x9E3779B1) + _imul(b, 0x85EBCA77)) & M32
    x ^= x >> 16
    x = _imul(x, 0x7FEB352D)
    x ^= x >> 15
    x = _imul(x, 0x846CA68B)
    x ^= x >> 16
    return x


def half_up(x: float) -> int:
    """JS Math.round semantics (Python round() is banker's rounding) so both engines agree."""
    return math.floor(x + 0.5)


def clock(t: float) -> str:
    s = int(CLOCK_BASE_S + t) % 86400
    return f"{s // 3600:02d}:{s // 60 % 60:02d}:{s % 60:02d}"


def short_name(name: str) -> str:
    return name.split("/")[0].split("·")[0].strip()


def idle_liters(car_idle_s: float, heavy_idle_s: float) -> float:
    return car_idle_s * FUEL["car_idle_lph"] / 3600 + heavy_idle_s * FUEL["heavy_idle_lph"] / 3600


def fuel_telemetry(fixed_stats: dict, swarm_stats: dict) -> dict:
    """liters = sum(idle_seconds_saved * idle_rate_per_sec); CO2 = L * 2.31; INR = L * 96.72."""
    car_saved = fixed_stats["car_idle_s"] - swarm_stats["car_idle_s"]
    heavy_saved = fixed_stats["heavy_idle_s"] - swarm_stats["heavy_idle_s"]
    liters = idle_liters(car_saved, heavy_saved)
    per = lambda s: s["idle_s"] / s["passages"] if s["passages"] else 0.0
    per_stop = lambda s: s["stopped_idle_s"] / s["stops"] if s["stops"] else 0.0
    stop_rate = lambda s: s["stops"] / s["passages"] if s["passages"] else 0.0
    base = per(fixed_stats)
    return {
        "idle_seconds_saved": round(car_saved + heavy_saved, 1),
        "liters_fuel_saved": round(liters, 4),
        "co2_kg_prevented": round(liters * FUEL["co2_kg_per_l"], 4),
        "rupees_saved": round(liters * FUEL["inr_per_l"], 2),
        "average_delay_reduction_pct": round((1 - per(swarm_stats) / base) * 100, 1) if base > 0 else 0.0,
        "stops_avoided": round((stop_rate(fixed_stats) - stop_rate(swarm_stats)) * swarm_stats["passages"]),
        "stops_per_passage": {"fixed": round(stop_rate(fixed_stats), 3), "swarm": round(stop_rate(swarm_stats), 3)},
        "avg_idle_per_passage_s": {"fixed": round(base, 2), "swarm": round(per(swarm_stats), 2)},
        "avg_idle_per_stopped_vehicle_s": {"fixed": round(per_stop(fixed_stats), 2), "swarm": round(per_stop(swarm_stats), 2)},
        "idle_liters": {"fixed": round(idle_liters(fixed_stats["car_idle_s"], fixed_stats["heavy_idle_s"]), 4),
                        "swarm": round(idle_liters(swarm_stats["car_idle_s"], swarm_stats["heavy_idle_s"]), 4)},
        "rates": FUEL,
    }


def _new_stats() -> dict:
    return {"passages": 0, "stops": 0, "idle_s": 0, "stopped_idle_s": 0, "car_idle_s": 0, "heavy_idle_s": 0,
            "arrived": 0, "exited": 0}


# ---------------------------------------------------------------------- topology
def travel_direction(a: dict, b: dict) -> str:
    dx = (b["lon"] - a["lon"]) * math.cos(math.radians(a["lat"]))
    dy = b["lat"] - a["lat"]
    if abs(dy) >= abs(dx):
        return "NORTHBOUND" if dy > 0 else "SOUTHBOUND"
    return "EASTBOUND" if dx > 0 else "WESTBOUND"


def _dist_m(a: dict, b: dict) -> float:
    kx = 111320 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.hypot((b["lon"] - a["lon"]) * kx, (b["lat"] - a["lat"]) * 110570)


def build_links(junctions: list, edges: list) -> list:
    pairs = [(i, k) for i, k in edges] + [(k, i) for i, k in edges]
    dists = [_dist_m(junctions[i], junctions[k]) for i, k in pairs]
    lo, hi = (min(dists), max(dists)) if dists else (0, 0)
    links = []
    for n, ((i, k), d) in enumerate(zip(pairs, dists)):
        travel = 16 if hi - lo < 1e-6 else half_up(10 + 18 * (d - lo) / (hi - lo))
        links.append({"id": n, "from": i, "to": k, "dir": travel_direction(junctions[i], junctions[k]),
                      "travel_s": travel, "length_m": half_up(d)})
    return links


def grid_topology(n: int = 3) -> tuple[list, list]:
    """Junctions + row/column edges. 3x3 uses the surveyed Ghaziabad core, larger grids a regular
    lattice around it."""
    if n == 3:
        junctions = [{"id": j, "name": nm, "lat": la, "lon": lo, "row": r, "col": c}
                     for j, nm, la, lo, r, c in GHAZIABAD_3X3]
    else:
        junctions = [{"id": f"GZB-{n}-{r + 1}-{c + 1}", "name": f"Ghaziabad Grid R{r + 1}C{c + 1}",
                      "lat": round(28.635 + r * 0.075 / (n - 1), 5), "lon": round(77.33 + c * 0.15 / (n - 1), 5),
                      "row": r, "col": c} for r in range(n) for c in range(n)]
    edges = [(i, k) for i, a in enumerate(junctions) for k, b in enumerate(junctions)
             if k > i and abs(a["row"] - b["row"]) + abs(a["col"] - b["col"]) == 1]
    return junctions, edges


def hero_index(junctions: list) -> int:
    for i, j in enumerate(junctions):
        if "hapur" in j["name"].lower():
            return i
    return max(range(len(junctions)), key=lambda i: junctions[i]["lon"])


def emergency_route(junctions: list, links: list, start: int) -> list:
    """Shortest hop path from `start` to the geometrically farthest junction."""
    far = max(range(len(junctions)), key=lambda i: _dist_m(junctions[start], junctions[i]))
    prev, frontier = {start: None}, deque([start])
    while frontier:
        u = frontier.popleft()
        for l in links:
            if l["from"] == u and l["to"] not in prev:
                prev[l["to"]] = u
                frontier.append(l["to"])
    if far not in prev:
        return [start]
    path, u = [], far
    while u is not None:
        path.append(u)
        u = prev[u]
    return path[::-1]


# ---------------------------------------------------------------------- demand (shared by both meshes)
class Demand:
    def __init__(self, junctions: list, links: list, seed: int, cfg: dict):
        self.cfg = cfg
        self.rnd = mulberry32(seed)
        self.next_id = 1
        incoming = {(l["to"], l["dir"]) for l in links}
        self.hero = hero_index(junctions)
        self.sources = [(j, d) for j in range(len(junctions)) for d in DIRS if (j, d) not in incoming]
        hero_arms = [d for j, d in self.sources if j == self.hero]
        self.hero_arm = hero_arms[0] if hero_arms else None
        self.burst_left = 0

    def arrivals(self, t: int) -> list:
        c = self.cfg
        wave = 1 + 0.3 * math.sin(t / 120)
        out = []
        for j, d in self.sources:
            rate = c["base_rate_vps"] * wave * (c["hero_rate_factor"] if j == self.hero else 1)
            if self.rnd() < rate:
                out.append(self._veh(j, d))
        if self.hero_arm is not None:
            if t % c["burst_every_s"] == 5:
                self.burst_left = c["burst_size"]
            whole = int(c["burst_rate_vps"])
            n = min(self.burst_left, whole + (1 if self.rnd() < c["burst_rate_vps"] - whole else 0))
            for _ in range(n):
                out.append(self._veh(self.hero, self.hero_arm))
            self.burst_left -= n
        return out

    def _veh(self, j, d):
        vid = self.next_id
        self.next_id += 1
        heavy = hash2(vid, 7919) % 100 < self.cfg["heavy_share"] * 100
        return (j, d, vid, heavy)


# ---------------------------------------------------------------------- agents
class Vehicle:
    __slots__ = ("id", "heavy", "dir", "wait", "alert")

    def __init__(self, vid, heavy, direction):
        self.id, self.heavy, self.dir, self.wait, self.alert = vid, heavy, direction, 0, None


class JunctionAgent:
    """One autonomous signal. Talks to neighbours only through platoon alerts on mesh channels."""

    def __init__(self, mesh, idx: int, info: dict, mode: str):
        self.mesh, self.idx, self.mode = mesh, idx, mode
        self.id, self.name, self.short = info["id"], info["name"], short_name(info["name"])
        self.arms = {d: deque() for d in DIRS}
        self.acc = {d: 0.0 for d in DIRS}
        self.out = {}                    # travel direction -> link
        self.axis, self.state, self.state_t, self.next_axis = "NS", "G", 0, "EW"
        self.green_start = 0
        self.red_since = {"NS": 0, "EW": 0}
        self.last_green = {"NS": None, "EW": None}
        self.offset = (idx * 17) % 70
        self.inbox: list[dict] = []
        self.tau = {"NS": 1.0, "EW": 1.0}
        self.lock = None
        self.batch = None
        self.served_hist = deque([0] * 60, maxlen=60)
        self.stats = _new_stats()
        self.last_log = {}
        self.last_reason = None

    # -------------------------------------------------------------- communication
    def send_platoon_alert(self, target_id: str, count: int, eta: float, *, direction: str, tail_eta: float,
                           alert: dict) -> dict:
        """Broadcast a predictive telemetry packet to the downstream junction `target_id`."""
        target = self.mesh.by_id[target_id]
        alert.update(source_junction=f"{self.short} ({self.id})", target_junction=f"{target.short} ({target.id})",
                     platoon_size=count, estimated_arrival_sec=round(eta), approaching_direction=direction,
                     target_speed_kmh=self.mesh.cfg["cruise_kmh"], sent_at=self.mesh.t,
                     head_at=self.mesh.t + eta, tail_at=self.mesh.t + tail_eta)
        self.mesh.channel.append((self.mesh.t + self.mesh.cfg["comm_latency_s"], alert))
        return alert

    def receive(self, alert: dict, now: int) -> None:
        c = self.mesh.cfg
        window = max(c["min_green_s"], min(c["max_green_s"], math.ceil(alert["tail_at"] - alert["head_at"]) + 3))
        alert["window_s"] = window
        alert["received_at"] = now
        self.inbox.append(alert)
        if alert["platoon_size"] >= c["log_min_platoon"]:
            axis = AXIS[alert["approaching_direction"]]
            plan = (f"holding {axis} green" if self.state == "G" and self.axis == axis
                    else f"{axis} green scheduled to open at T+{max(0, round(alert['head_at'] - now))}s")
            self.mesh.log(self, "alert", f"Received lookahead alert from {self.mesh.agents[alert['from']].short}: "
                          f"{alert['platoon_size']} veh {alert['approaching_direction']}, ETA {round(alert['head_at'] - now)}s. "
                          f"Pre-allocated {window}s green wave ({plan}).")

    # -------------------------------------------------------------- observation
    def queue(self, axis: str | None = None) -> int:
        return sum(len(q) for d, q in self.arms.items() if axis is None or AXIS[d] == axis)

    def incoming(self, axis: str, now: int, horizon: float) -> int:
        """Vehicles announced on this axis whose platoon head is within `horizon` and still to arrive."""
        return sum(a["platoon_size"] - a["arrived"] for a in self.inbox
                   if AXIS[a["approaching_direction"]] == axis and a["head_at"] <= now + horizon
                   and a["arrived"] < a["platoon_size"])

    def next_platoon(self, axis: str, now: int):
        cands = [a for a in self.inbox if AXIS[a["approaching_direction"]] == axis and a["arrived"] < a["platoon_size"]
                 and a["head_at"] >= now - 1]
        return min(cands, key=lambda a: a["head_at"]) if cands else None

    # -------------------------------------------------------------- decision
    def decide(self, now: int) -> tuple[bool, str]:
        """Swarm rule set for an agent currently in green. Returns (switch, reason)."""
        c = self.mesh.cfg
        g, o = self.axis, OTHER[self.axis]
        elapsed = now - self.green_start
        if self.lock is not None:
            return (g != self.lock), "emergency_corridor"
        if elapsed < c["min_green_s"]:
            return False, "min_green"
        qg, qo = self.queue(g), self.queue(o)
        inc_g, inc_o = self.incoming(g, now, c["lookahead_s"]), self.incoming(o, now, 8)
        if elapsed >= c["max_green_s"] and (qo > 0 or inc_o > 0):
            return True, "max_green"
        if now - self.red_since[o] >= c["max_red_s"] and qo > 0:
            return True, "anti_starvation"
        arriving_g = self.incoming(g, now, 3)
        if arriving_g > 0 and qo < 2 * (qg + arriving_g) + 10:
            return False, "platoon_hold"
        if qg == 0 and arriving_g == 0:
            if qo > 0 or self.incoming(o, now, 6) > 0:
                return True, "empty_green"
            return False, "rest_in_green"
        nxt = self.next_platoon(o, now)
        transition = c["yellow_s"] + c["all_red_s"] + 1
        if (nxt is not None and nxt["platoon_size"] >= c["platoon_min"] and nxt["head_at"] - now <= transition
                and qg <= max(2, nxt["platoon_size"] / 2)):
            return True, "preempt_platoon"
        total_tau = self.tau[g] + self.tau[o]
        wg, wo = 0.8 + 0.4 * self.tau[g] / total_tau, 0.8 + 0.4 * self.tau[o] / total_tau
        pg, po = (qg + 0.5 * inc_g) * wg, (qo + 0.5 * inc_o) * wo
        if po > 1.5 * pg + 3:
            return True, "pressure"
        return False, "hold"

    # -------------------------------------------------------------- signal state machine
    def control(self, now: int) -> None:
        c = self.mesh.cfg
        if self.mode == FIXED:
            self._fixed(now)
            return
        if self.state == "Y" and now - self.state_t >= c["yellow_s"]:
            self.state, self.state_t = "R", now
        elif self.state == "R" and now - self.state_t >= c["all_red_s"]:
            self.axis = self.lock or self.next_axis
            self.state, self.state_t, self.green_start = "G", now, now
        elif self.state == "G":
            switch, reason = self.decide(now)
            self.last_reason = reason
            if switch:
                self._log_switch(now, reason)
                self.last_green[self.axis] = now - self.green_start
                self.red_since[self.axis] = now
                self.next_axis = OTHER[self.axis]
                self.state, self.state_t = "Y", now

    def _fixed(self, now: int) -> None:
        c = self.mesh.cfg
        g, y, r = c["fixed_green_s"], c["yellow_s"], c["all_red_s"]
        half = g + y + r
        pos = (now + self.offset) % (2 * half)
        axis = "NS" if pos < half else "EW"
        p = pos % half
        state = "G" if p < g else ("Y" if p < g + y else "R")
        if state == "G" and (self.state != "G" or self.axis != axis):
            self.green_start = now
        if state == "Y" and self.state == "G":
            self.last_green[axis] = g
            self.red_since[axis] = now
        self.axis, self.state = axis, state
        self.next_axis = OTHER[axis]

    def _log_switch(self, now, reason):
        c, g, o = self.mesh.cfg, self.axis, OTHER[self.axis]
        if reason == "empty_green" and self.queue(o) >= 4 and now - self.last_log.get(reason, -99) >= 20:
            self.last_log[reason] = now
            self.mesh.log(self, "drain", f"{g} approach empty after {now - self.green_start}s - ending dead green, "
                          f"surplus time shifted to {o} ({self.queue(o)} veh waiting).")
        elif reason == "preempt_platoon" and now - self.last_log.get(reason, -99) >= 10:
            self.last_log[reason] = now
            nxt = self.next_platoon(o, now)
            self.mesh.log(self, "preempt", f"Pre-emptive switch: {o} green opens in {c['yellow_s'] + c['all_red_s']}s "
                          f"for {nxt['platoon_size']}-veh platoon from {self.mesh.agents[nxt['from']].short}.")

    # -------------------------------------------------------------- discharge
    def discharge(self, now: int) -> None:
        mesh, c = self.mesh, self.mesh.cfg
        served = 0
        for d in DIRS:
            q = self.arms[d]
            if self.state == "G" and AXIS[d] == self.axis:
                self.acc[d] += c["sat_flow_vps"]
                n = min(int(self.acc[d]), len(q))
                self.acc[d] -= n
                if not q or n == len(q):
                    self.acc[d] = min(self.acc[d], 1.0)
                for _ in range(n):
                    self._release(q.popleft(), now)
                served += n
                if n:
                    self.tau[self.axis] += 0.1 * n
            else:
                self.acc[d] = 0.0
            for v in q:
                v.wait += 1
                self.stats["idle_s"] += 1
                self.stats["heavy_idle_s" if v.heavy else "car_idle_s"] += 1
        self.served_hist.append(served)
        for axis in self.tau:
            self.tau[axis] = max(0.1, self.tau[axis] * (1 - c["tau_evaporation"]))

    def _release(self, v: Vehicle, now: int) -> None:
        mesh, c, st = self.mesh, self.mesh.cfg, self.stats
        st["passages"] += 1
        if v.wait > 0:
            st["stops"] += 1
            st["stopped_idle_s"] += v.wait
        if v.alert is not None:
            mesh.platoon_passed(v, now)
        roll = hash2(v.id, self.idx + 1) % 100
        turn = "straight" if roll < c["straight_pct"] else ("left" if roll < c["straight_pct"] + c["left_pct"] else "right")
        new_dir = v.dir if turn == "straight" else (LEFT if turn == "left" else RIGHT)[v.dir]
        link = self.out.get(new_dir)
        v.wait, v.alert = 0, None
        if link is None:
            st["exited"] += 1
            if mesh.mode == SWARM:
                self._batch_add(None, turn, v, now)
            return
        v.dir = new_dir
        arrive = now + link["travel_s"]
        heapq.heappush(mesh.transit, (arrive, v.id, link["to"], v, link["id"], now))
        if mesh.mode == SWARM:
            self._batch_add(link, turn, v, now, arrive)

    def _batch_add(self, link, turn, v, now, arrive=None):
        if self.batch is None:
            self.batch = {"first": now, "last": now, "deadline": now + self.mesh.cfg["batch_max_s"], "links": {},
                          "turns": {"straight": 0, "left": 0, "right": 0, "exit": 0}}
        b = self.batch
        b["last"] = now
        b["turns"]["exit" if link is None else turn] += 1
        if link is None:
            return
        entry = b["links"].get(link["id"])
        if entry is None:
            alert = self.mesh.new_alert(self.idx, link)
            entry = b["links"][link["id"]] = {"link": link, "arrivals": [], "alert": alert}
            b["deadline"] = min(b["deadline"], now + max(2, link["travel_s"] - 4))
        entry["arrivals"].append(arrive)
        entry["alert"]["vehicles"] += 1
        entry["alert"]["rate_sum"] += (FUEL["heavy_idle_lph"] if v.heavy else FUEL["car_idle_lph"]) / 3600
        v.alert = entry["alert"]["id"]

    def flush(self, now: int) -> None:
        b, c = self.batch, self.mesh.cfg
        if b is None or (now - b["last"] < c["batch_gap_s"] and now < b["deadline"]):
            return
        self.batch = None
        sent = []
        for entry in b["links"].values():
            link, arr = entry["link"], entry["arrivals"]
            target = self.mesh.agents[link["to"]]
            sent.append(self.send_platoon_alert(target.id, len(arr), min(arr) - now, direction=link["dir"],
                                                tail_eta=max(arr) - now, alert=entry["alert"]))
        total = sum(b["turns"].values())
        if total >= c["log_min_platoon"] and sent:
            t = b["turns"]
            split = f"{t['straight']} straight / {t['left']} left / {t['right']} right" + (f" / {t['exit']} exit" if t["exit"] else "")
            calls = ", ".join(f"{a['platoon_size']} veh to {self.mesh.agents[a['to']].short} (ETA {a['estimated_arrival_sec']}s)"
                              for a in sorted(sent, key=lambda a: -a["platoon_size"]))
            self.mesh.log(self, "platoon", f"Platoon detected: {total} veh ({split}). Broadcasting {calls}.")


# ---------------------------------------------------------------------- mesh
class JunctionMesh:
    def __init__(self, junctions: list, links: list, mode: str, cfg: dict):
        self.mode, self.cfg, self.t = mode, cfg, 0
        self.junctions, self.links = junctions, links
        self.agents = [JunctionAgent(self, i, j, mode) for i, j in enumerate(junctions)]
        self.by_id = {a.id: a for a in self.agents}
        for l in links:
            self.agents[l["from"]].out.setdefault(l["dir"], l)
        self.transit: list = []
        self.channel: list = []          # (deliver_at, alert) - neighbour message bus
        self.alerts: dict[int, dict] = {}
        self.n_alerts = 0
        self.messages: deque = deque(maxlen=500)
        self.seq = 0
        self.reference = None            # the fixed mesh (for "idling avoided vs static timer")
        self.ambulance = None
        self.stats_history = deque(maxlen=600)

    # -------------------------------------------------------------- messages
    def log(self, agent, kind: str, text: str) -> None:
        if self.mode != SWARM:
            return
        self.seq += 1
        who = "EMERGENCY" if agent is None else f"{agent.id} {agent.short}"
        self.messages.append({"seq": self.seq, "t": self.t, "clock": clock(self.t), "junction": None if agent is None else agent.id,
                              "who": who, "kind": kind, "text": text, "line": f"[{clock(self.t)}] [{who}] {text}"})

    def new_alert(self, src: int, link: dict) -> dict:
        self.n_alerts += 1
        alert = {"id": self.n_alerts, "from": src, "to": link["to"], "link": link["id"], "vehicles": 0, "rate_sum": 0.0,
                 "arrived": 0, "passed": 0, "stops": 0, "idle_s": 0, "closed": False, "sent_at": None,
                 "platoon_size": 0, "approaching_direction": link["dir"], "head_at": math.inf, "tail_at": math.inf}
        self.alerts[alert["id"]] = alert
        return alert

    def platoon_passed(self, v: Vehicle, now: int) -> None:
        a = self.alerts.get(v.alert)
        if a is None:
            return
        a["passed"] += 1
        a["idle_s"] += v.wait
        a["stops"] += 1 if v.wait > 0 else 0
        if a["passed"] >= a["vehicles"] and a["sent_at"] is not None:
            self._close(a, now)

    def _close(self, a: dict, now: int) -> None:
        a["closed"] = True
        self.alerts.pop(a["id"], None)
        rx = self.agents[a["to"]]
        rx.inbox = [x for x in rx.inbox if x["id"] != a["id"]]
        if a["vehicles"] < self.cfg["log_min_platoon"]:
            return
        ref = self.reference.agents[a["to"]].stats if self.reference else None
        base = ref["idle_s"] / ref["passages"] if ref and ref["passages"] else 0.0
        mine = a["idle_s"] / a["vehicles"]
        avoided = max(0.0, base - mine)
        liters = avoided * a["rate_sum"]
        self.log(rx, "clear", f"Platoon from {self.agents[a['from']].short} cleared: {a['vehicles']} veh, {a['stops']} stops. "
                 f"Idling avoided: {avoided:.0f}s/veh vs static timer. Fuel saved: {liters:.3f} L.")

    def _deliver(self, now: int) -> None:
        keep = []
        for at, alert in self.channel:
            if at <= now:
                if not alert["closed"]:
                    self.agents[alert["to"]].receive(alert, now)
            else:
                keep.append((at, alert))
        self.channel = keep
        for a in self.agents:
            stale = [x for x in a.inbox if now > x["tail_at"] + 90]
            for x in stale:
                self._close(x, now)

    # -------------------------------------------------------------- emergency
    def start_ambulance(self, route: list, now: int) -> None:
        self.ambulance = {"route": route, "k": 0, "arrive_at": now + 6, "delay_s": 0, "done": False,
                          "start": now, "locked": set(), "passed": [], "pos_link": None, "depart": now}
        if self.mode == SWARM:
            names = " -> ".join(self.agents[i].short for i in route)
            self.log(None, "emergency", f"Ambulance detected. Corridor override broadcast to {len(route)} junctions: {names}.")

    def _amb_axis(self, k: int) -> str:
        route = self.ambulance["route"]
        if k + 1 < len(route):
            return AXIS[self._link(route[k], route[k + 1])["dir"]]
        return AXIS[self._link(route[k - 1], route[k])["dir"]] if k > 0 else "NS"

    def _link(self, i, k):
        return next(l for l in self.links if l["from"] == i and l["to"] == k)

    def _emergency(self, now: int) -> None:
        amb = self.ambulance
        if amb is None or amb["done"]:
            return
        route, c = amb["route"], self.cfg
        if self.mode == SWARM:
            eta = amb["arrive_at"] - now
            for k in range(amb["k"], len(route)):
                if k > amb["k"]:
                    eta += half_up(self._link(route[k - 1], route[k])["travel_s"] * c["ambulance_speed_factor"])
                agent = self.agents[route[k]]
                if eta <= c["emergency_lock_eta_s"] and k not in amb["locked"]:
                    amb["locked"].add(k)
                    agent.lock = self._amb_axis(k)
                    action = (f"holding {agent.lock} green" if agent.state == "G" and agent.axis == agent.lock
                              else f"{agent.axis} -> All-Red -> {agent.lock} green")
                    self.log(agent, "emergency", f"Emergency override (ambulance ETA {max(0, eta)}s): {action}; cross traffic held red.")
        if now < amb["arrive_at"]:
            return
        k = amb["k"]
        agent = self.agents[route[k]]
        if agent.state == "G" and agent.axis == self._amb_axis(k):
            agent.lock = None
            amb["passed"].append(k)
            if self.mode == SWARM:
                self.log(agent, "emergency", f"Ambulance passed (cumulative signal delay {amb['delay_s']}s). Corridor lock released.")
            amb["k"] += 1
            if amb["k"] >= len(route):
                amb["done"], amb["end"] = True, now
                return
            link = self._link(route[k], route[k + 1])
            amb["pos_link"], amb["depart"] = link["id"], now
            amb["arrive_at"] = now + half_up(link["travel_s"] * c["ambulance_speed_factor"])
        else:
            amb["delay_s"] += 1

    # -------------------------------------------------------------- step
    def step(self, arrivals: list) -> None:
        self.t += 1
        now = self.t
        for j, d, vid, heavy in arrivals:
            self._enqueue(j, Vehicle(vid, heavy, d))
            self.agents[j].stats["arrived"] += 1
        while self.transit and self.transit[0][0] <= now:
            _, _, j, v, _, _ = heapq.heappop(self.transit)
            self._enqueue(j, v)
        if self.mode == SWARM:
            self._deliver(now)
        self._emergency(now)
        for a in self.agents:
            a.control(now)
        for a in self.agents:
            a.discharge(now)
        if self.mode == SWARM:
            for a in self.agents:
                a.flush(now)
        self.stats_history.append(self.queue_total())

    def _enqueue(self, j: int, v: Vehicle) -> None:
        self.agents[j].arms[v.dir].append(v)
        if v.alert is not None:
            a = self.alerts.get(v.alert)
            if a is not None:
                a["arrived"] += 1

    # -------------------------------------------------------------- reporting
    def queue_total(self) -> int:
        return sum(a.queue() for a in self.agents)

    def totals(self) -> dict:
        out = _new_stats()
        for a in self.agents:
            for k, v in a.stats.items():
                out[k] += v
        return out

    def junction_state(self, a: JunctionAgent, fuel_saved_l: float | None = None) -> dict:
        now, c = self.t, self.cfg
        nxt = sorted((x for x in a.inbox if x["arrived"] < x["platoon_size"]), key=lambda x: x["head_at"])[:3]
        phase = {"G": f"{a.axis} Green", "Y": f"{a.axis} Yellow", "R": "All-Red Clearance"}[a.state]
        return {
            "id": a.id, "name": a.name, "short": a.short, "queue": a.queue(),
            "queue_by_axis": {"NS": a.queue("NS"), "EW": a.queue("EW")},
            "queue_by_dir": {d: len(q) for d, q in a.arms.items()},
            "axis": a.axis, "state": a.state, "phase": phase,
            "green_elapsed_s": now - a.green_start if a.state == "G" else 0,
            "last_green_s": a.last_green, "static_green_s": c["fixed_green_s"],
            "cars_per_min": sum(a.served_hist), "decision": a.last_reason,
            "pheromone": {k: round(v, 2) for k, v in a.tau.items()},
            "emergency_lock": a.lock,
            "incoming": [{"from": self.agents[x["from"]].short, "size": x["platoon_size"] - x["arrived"],
                          "eta_s": max(0, round(x["head_at"] - now)), "direction": x["approaching_direction"]} for x in nxt],
            "fuel_saved_l": fuel_saved_l, "stats": dict(a.stats),
        }


# ---------------------------------------------------------------------- the paired demo
class LookaheadDemo:
    """Swarm mesh and fixed-timer mesh stepped together on the same demand stream."""

    def __init__(self, junctions: list | None = None, edges: list | None = None, seed: int = 42, grid: int = 3,
                 cfg: dict | None = None):
        if junctions is None:
            junctions, edges = grid_topology(grid)
        self.cfg = {**CONFIG, **(cfg or {})}
        self.seed, self.grid = seed, grid
        self.junctions = junctions
        self.links = build_links(junctions, edges)
        self.demand = Demand(junctions, self.links, seed, self.cfg)
        self.meshes = {SWARM: JunctionMesh(junctions, self.links, SWARM, self.cfg),
                       FIXED: JunctionMesh(junctions, self.links, FIXED, self.cfg)}
        self.meshes[SWARM].reference = self.meshes[FIXED]
        self.route = None

    @property
    def t(self) -> int:
        return self.meshes[SWARM].t

    def step(self, seconds: int = 1) -> None:
        for _ in range(int(seconds)):
            arrivals = self.demand.arrivals(self.t + 1)
            for m in self.meshes.values():
                m.step(arrivals)

    def trigger_emergency(self) -> dict:
        start = self.demand.hero
        self.route = emergency_route(self.junctions, self.links, start)
        if len(self.route) < 2:
            raise ValueError("network too small for an emergency corridor")
        for m in self.meshes.values():
            m.start_ambulance(self.route, m.t)
        return {"route": [self.junctions[i]["id"] for i in self.route], "started_at": self.t}

    def emergency(self) -> dict | None:
        out = {}
        for mode, m in self.meshes.items():
            amb = m.ambulance
            if amb is None:
                return None
            out[mode] = {"done": amb["done"], "delay_s": amb["delay_s"], "at_junction": amb["k"],
                         "travel_s": (amb.get("end") or m.t) - amb["start"]}
        out["route"] = [self.junctions[i]["id"] for i in self.route]
        return out

    def fuel(self) -> dict:
        return fuel_telemetry(self.meshes[FIXED].totals(), self.meshes[SWARM].totals())

    def junction_fuel_saved(self, i: int) -> float:
        f, s = self.meshes[FIXED].agents[i].stats, self.meshes[SWARM].agents[i].stats
        return round(idle_liters(f["car_idle_s"] - s["car_idle_s"], f["heavy_idle_s"] - s["heavy_idle_s"]), 4)

    def state(self, mode: str = SWARM) -> dict:
        m = self.meshes[mode]
        packets = [{"id": a["id"], "from": self.junctions[a["from"]]["id"], "to": self.junctions[a["to"]]["id"],
                    "platoon_size": a["platoon_size"], "deliver_at": at} for at, a in m.channel]
        return {"t": m.t, "clock": clock(m.t), "mode": mode, "grid": self.grid, "seed": self.seed,
                "queue_total": m.queue_total(), "in_transit": len(m.transit),
                "junctions": [m.junction_state(a, self.junction_fuel_saved(a.idx)) for a in m.agents],
                "links": self.links, "packets_in_flight": packets, "emergency": self.emergency(),
                "fuel": self.fuel(), "totals": {k: v.totals() for k, v in self.meshes.items()}}

    def messages(self, since: int = 0, limit: int = 100) -> list:
        return [x for x in self.meshes[SWARM].messages if x["seq"] > since][-limit:]
