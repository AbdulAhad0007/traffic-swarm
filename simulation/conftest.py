import pytest


def _sumo_available() -> bool:
    try:
        import traci  # noqa: F401
    except ImportError:
        return False
    from simulation.network.grid_generator import find_sumo_binary
    return bool(find_sumo_binary("sumo") and find_sumo_binary("netconvert"))


def pytest_collection_modifyitems(config, items):
    if _sumo_available():
        return
    skip = pytest.mark.skip(reason="SUMO not installed (needs sumo, netconvert and the traci Python package)")
    for item in items:
        if "sumo" in item.keywords:
            item.add_marker(skip)
