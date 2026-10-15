"""Road-closure edge selection must follow lane connections (no U-turns), not just node reachability."""
from simulation.network.network_model import NetworkModel
from simulation.network.scenario_builder import _has_alternative


def _model(connections):
    edges, lanes = {}, {}
    for frm, to in connections:
        for e in (frm, to):
            a, b = e.split(">")
            edges.setdefault(e, {"from": a, "to": b, "function": "", "length": 100.0, "lanes": [e + "_0"]})
            lanes.setdefault(e + "_0", {"edge": e, "length": 100.0, "allow": None, "disallow": None})
    model = NetworkModel("synthetic.net.xml", {}, edges, lanes, {})
    for frm, to in connections:
        model.successors[frm].add(to)
    return model


def test_corner_without_u_turn_has_no_detour():
    # Corner A: traffic arriving from B can only go to C (the closed edge) or leave via the exit X.
    # The node-level path A -> B -> D -> C exists, but it needs a U-turn at A for B>A traffic.
    m = _model([("B>A", "A>C"), ("B>A", "A>X"), ("A>C", "C>D"), ("A>B", "B>D"), ("B>D", "D>C"), ("D>C", "C>D")])
    assert not _has_alternative(m, "A>C")


def test_detour_through_connections_is_accepted():
    m = _model([("P>A", "A>C"), ("P>A", "A>E"), ("A>E", "E>C"), ("E>C", "C>D"), ("A>C", "C>D")])
    assert _has_alternative(m, "A>C")


def test_every_continuation_must_be_reachable():
    # The detour reaches C>D but not the second continuation C>F.
    m = _model([("P>A", "A>C"), ("P>A", "A>E"), ("A>E", "E>C"), ("E>C", "C>D"), ("A>C", "C>D"), ("A>C", "C>F")])
    assert not _has_alternative(m, "A>C")
