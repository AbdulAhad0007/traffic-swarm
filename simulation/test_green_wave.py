import pytest
from simulation.network.phase_map import GreenPhase
from simulation.coordination.green_wave import (
    plan_response, Call, summarize_calls, DEFAULTS,
    RESP_EXTEND, RESP_PARTIAL, RESP_SWITCH, RESP_NOCHANGE, RESP_DECLINED, RESP_DEFER
)

def make_green(index: int, axis: str = "NS", min_g: float = 10.0, yellow: float = 3.0, red: float = 2.0):
    return GreenPhase(
        index=index,
        duration=30.0,
        state="GGGrrr",
        served_links=frozenset([index]),
        served_lanes=(f"lane_{index}",),
        axis=axis,
        serves_pedestrians=False,
        min_green=min_g,
        downstream_tls=(),
        transition=(),
        yellow_s=yellow,
        all_red_s=red,
        clearance_s=0.0
    )

def test_plan_response_deferred_when_in_transition():
    cfg = DEFAULTS.copy()
    target = make_green(0)
    resp, total, reason = plan_response(
        now=10.0, eta_head=15.0, eta_tail=20.0, current=None, elapsed=0.0,
        planned_total=None, target=target, next_green=0, served_queue=0,
        platoon_size=4, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_DEFER
    assert total is None
    assert reason == "receiver_in_transition"

def test_plan_response_extends_current_green_to_cover_tail():
    cfg = DEFAULTS.copy()
    current = make_green(0)
    target = make_green(0)
    # now=10, eta_tail=22, elapsed=5, margin=2 -> needed = 5 + (22 - 10) + 2 = 19
    resp, total, reason = plan_response(
        now=10.0, eta_head=15.0, eta_tail=22.0, current=current, elapsed=5.0,
        planned_total=10.0, target=target, next_green=1, served_queue=0,
        platoon_size=4, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_EXTEND
    assert total == 19.0
    assert reason == "extend_to_cover_platoon_tail"

def test_plan_response_no_change_if_already_covers_tail():
    cfg = DEFAULTS.copy()
    current = make_green(0)
    target = make_green(0)
    # needed = 5 + 12 + 2 = 19; planned_total=25 >= 19
    resp, total, reason = plan_response(
        now=10.0, eta_head=15.0, eta_tail=22.0, current=current, elapsed=5.0,
        planned_total=25.0, target=target, next_green=1, served_queue=0,
        platoon_size=4, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_NOCHANGE
    assert total is None
    assert reason == "green_already_covers_platoon"

def test_plan_response_clamps_to_max_green():
    cfg = DEFAULTS.copy()
    current = make_green(0)
    target = make_green(0)
    # needed = 50 + 40 + 2 = 92 > max_green (60)
    resp, total, reason = plan_response(
        now=10.0, eta_head=20.0, eta_tail=50.0, current=current, elapsed=50.0,
        planned_total=50.0, target=target, next_green=1, served_queue=0,
        platoon_size=5, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_PARTIAL
    assert total == 60.0
    assert reason == "clamped_max_green"

def test_plan_response_early_switch_for_competing_phase():
    cfg = DEFAULTS.copy()
    current = make_green(1, axis="EW", min_g=10.0, yellow=3.0, red=2.0)
    target = make_green(0, axis="NS")
    # transition = 3 + 2 = 5s; startup_lost = 1s; total lead = 6s
    # now=20, eta_head=30 -> desired_end_in = (30 - 20) - 5 - 1 = 4s
    # elapsed=12 >= min_g (10) -> earliest_end_in = 0
    # planned_end_in = 25 - 12 = 13s > 4s
    resp, total, reason = plan_response(
        now=20.0, eta_head=30.0, eta_tail=35.0, current=current, elapsed=12.0,
        planned_total=25.0, target=target, next_green=0, served_queue=1,
        platoon_size=6, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_SWITCH
    assert total == 16.0  # elapsed (12) + end_in (4)
    assert reason == "early_switch_on_time"

def test_plan_response_declines_if_current_demand_is_higher():
    cfg = DEFAULTS.copy()
    current = make_green(1, axis="EW")
    target = make_green(0, axis="NS")
    # served_queue = 8 > max(2, 4 * 0.5) = 2
    resp, total, reason = plan_response(
        now=20.0, eta_head=30.0, eta_tail=35.0, current=current, elapsed=12.0,
        planned_total=25.0, target=target, next_green=0, served_queue=8,
        platoon_size=4, max_green=60.0, cfg=cfg
    )
    assert resp == RESP_DECLINED
    assert total is None
    assert reason == "current_demand_higher"

def test_call_latency_and_outcome_record():
    call = Call(
        id="C000001",
        sender="J1",
        receiver="J2",
        target_phase=0,
        sent_at=10.0,
        deliver_at=10.5,
        vehicles={"veh1": {"eta_at": 25.0, "dist_m": 150.0, "link": 0, "approach_edge": "e1"}},
        eta_head=25.0,
        eta_tail=25.0,
        received_at=11.0,
        responded_at=12.0,
        response="extend",
        reason="extend_to_cover_platoon_tail",
        total_set_s=25.0,
        handler_ms=0.45
    )
    call.track = {"veh1": {"seen": True, "stopped": False, "cause": None, "passed_at": 24.8}}
    rec = call.record()

    assert rec["call_id"] == "C000001"
    assert rec["response_latency_s"] == 2.0
    assert rec["latency_breakdown"]["comm_latency_s"] == 0.5
    assert rec["latency_breakdown"]["step_quantization_s"] == 0.5
    assert rec["latency_breakdown"]["deferred_s"] == 1.0
    assert rec["outcome"] == "green_arrival"
    assert rec["response_correct"] is True
    assert rec["passed_without_stop"] == 1

def test_summarize_calls():
    call = Call(
        id="C000001", sender="J1", receiver="J2", target_phase=0, sent_at=10.0,
        deliver_at=10.2, vehicles={"v1": {"eta_at": 20.0, "dist_m": 100, "link": 0, "approach_edge": "e"}},
        eta_head=20.0, eta_tail=20.0, received_at=11.0, responded_at=11.0,
        response="extend", reason="extend_to_cover_platoon_tail"
    )
    call.track = {"v1": {"seen": True, "stopped": False, "cause": None, "passed_at": 19.5}}
    summary = summarize_calls([call.record()], kept_by_optimizer=1)
    assert summary["calls_sent"] == 1
    assert summary["calls_delivered"] == 1
    assert summary["calls_answered"] == 1
    assert summary["response_correct_rate"] == 1.0
    assert summary["announced_vehicles_without_stop_share"] == 1.0
    assert summary["optimizer_decisions_constrained_by_calls"] == 1
