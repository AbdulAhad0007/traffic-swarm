"""Deterministic rows x cols signalized grid generator (plain SUMO XML + netconvert).

Junction ids are ``J{row}_{col}`` (row 0 is the northern row, col 0 the western column).
Every grid junction gets a fringe approach road on each open side (``N{col}``, ``S{col}``,
``W{row}``, ``E{row}``), so every intersection is a real 4-arm signalized junction with
conflicting movements. Edge ids are ``{from}__{to}``.
"""
from __future__ import annotations
import shutil, subprocess
from dataclasses import dataclass
from pathlib import Path
import xml.etree.ElementTree as ET


def junction_id(row: int, col: int) -> str:
    return f"J{row}_{col}"


def edge_id(a: str, b: str) -> str:
    return f"{a}__{b}"


@dataclass(frozen=True)
class GridLayout:
    rows: int
    cols: int
    nodes: dict          # id -> (x, y, type)
    edges: list          # (id, from, to)
    entries: dict        # side -> list of (fringe_node, first grid junction) in deterministic order

    @property
    def tls_ids(self) -> list[str]:
        return [junction_id(r, c) for r in range(self.rows) for c in range(self.cols)]

    def expected_adjacency_edges(self) -> int:
        return self.rows * (self.cols - 1) + self.cols * (self.rows - 1)


def build_layout(rows: int, cols: int, block: float, fringe: float) -> GridLayout:
    nodes, edges = {}, []
    top = (rows - 1) * block
    for r in range(rows):
        for c in range(cols):
            nodes[junction_id(r, c)] = (c * block, top - r * block, "traffic_light")

    def link(a, b):
        edges.append((edge_id(a, b), a, b))
        edges.append((edge_id(b, a), b, a))

    for r in range(rows):
        for c in range(cols):
            if c + 1 < cols:
                link(junction_id(r, c), junction_id(r, c + 1))
            if r + 1 < rows:
                link(junction_id(r, c), junction_id(r + 1, c))
    entries = {"N": [], "S": [], "W": [], "E": []}
    for c in range(cols):
        x = c * block
        nodes[f"N{c}"] = (x, top + fringe, "priority")
        nodes[f"S{c}"] = (x, -fringe, "priority")
        link(f"N{c}", junction_id(0, c)); link(f"S{c}", junction_id(rows - 1, c))
        entries["N"].append((f"N{c}", junction_id(0, c))); entries["S"].append((f"S{c}", junction_id(rows - 1, c)))
    for r in range(rows):
        y = top - r * block
        nodes[f"W{r}"] = (-fringe, y, "priority")
        nodes[f"E{r}"] = ((cols - 1) * block + fringe, y, "priority")
        link(f"W{r}", junction_id(r, 0)); link(f"E{r}", junction_id(r, cols - 1))
        entries["W"].append((f"W{r}", junction_id(r, 0))); entries["E"].append((f"E{r}", junction_id(r, cols - 1)))
    return GridLayout(rows, cols, nodes, edges, entries)


def write_plain_xml(layout: GridLayout, out_dir: Path, lanes: int, speed: float, pedestrians: bool) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    nroot = ET.Element("nodes")
    for nid, (x, y, kind) in layout.nodes.items():
        ET.SubElement(nroot, "node", id=nid, x=f"{x:.2f}", y=f"{y:.2f}", type=kind)
    eroot = ET.Element("edges")
    for eid, a, b in layout.edges:
        attrs = dict(id=eid, **{"from": a, "to": b}, numLanes=str(lanes), speed=f"{speed:.2f}")
        if pedestrians:
            attrs["sidewalkWidth"] = "2.0"
        ET.SubElement(eroot, "edge", attrs)
    nod, edg = out_dir / "grid.nod.xml", out_dir / "grid.edg.xml"
    for root, path in ((nroot, nod), (eroot, edg)):
        ET.indent(root)
        ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)
    return nod, edg


def find_sumo_binary(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    import os
    home = os.environ.get("SUMO_HOME")
    if not home:
        try:
            import sumo
            home = getattr(sumo, "SUMO_HOME", None)
            if home and "SUMO_HOME" not in os.environ:
                os.environ["SUMO_HOME"] = str(home)
        except ImportError:
            pass
    if home:
        for candidate in (
            Path(home) / "bin" / name,
            Path(home) / "bin" / f"{name}.exe",
            Path(home) / name,
            Path(home) / f"{name}.exe",
        ):
            if candidate.is_file():
                return str(candidate)
    return None


def netconvert_command(nod: Path, edg: Path, net: Path, tls: dict, pedestrians: bool, lefthand: bool = False) -> list[str]:
    binary = find_sumo_binary("netconvert")
    if binary is None:
        raise RuntimeError("netconvert is required to build generated networks; install SUMO (or pip install eclipse-sumo) and add it to PATH.")
    cmd = [binary, "--node-files", nod.name, "--edge-files", edg.name, "--output-file", net.name,
           "--tls.default-type", str(tls["default_type"]),
           "--tls.green.time", str(int(tls["green_s"])),
           "--tls.yellow.time", str(int(tls["yellow_s"])),
           "--tls.allred.time", str(int(tls["all_red_s"])),
           "--no-turnarounds", "true",
           "--offset.disable-normalization", "true",
           "--no-warnings", "false"]
    if lefthand:
        cmd += ["--lefthand", "true"]
    if pedestrians:
        cmd += ["--crossings.guess", "true",
                "--tls.crossing-min.time", str(int(tls["crossing_min_s"])),
                "--tls.crossing-clearance.time", str(int(tls["crossing_clearance_s"]))]
    return cmd


def build_grid(preset: dict, out_dir: Path) -> Path:
    """Write plain XML and run netconvert. Returns the built net file path."""
    grid, tls = preset["grid"], preset["tls"]
    layout = build_layout(preset["rows"], preset["cols"], float(grid["block_length_m"]), float(grid["fringe_length_m"]))
    nod, edg = write_plain_xml(layout, out_dir, int(grid["lanes"]), float(grid["speed_mps"]), bool(grid["pedestrians"]))
    net = out_dir / "build.net.xml"
    proc = subprocess.run(netconvert_command(nod, edg, net, tls, bool(grid["pedestrians"]), bool(grid.get("lefthand"))), cwd=out_dir,
                          capture_output=True, text=True)
    (out_dir / "netconvert.log").write_text(proc.stdout + proc.stderr, encoding="utf-8")
    if proc.returncode != 0 or not net.is_file():
        raise RuntimeError(f"netconvert failed (exit {proc.returncode}); see {out_dir / 'netconvert.log'}")
    return net

