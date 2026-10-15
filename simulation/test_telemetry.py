from simulation.telemetry import TelemetryCollector

def test_telemetry_counts_stop_transitions_and_metrics():
    t=TelemetryCollector()
    t.observe_vehicle('v1',0,0,0,10,20)
    t.observe_vehicle('v1',1,2,0,5,10)
    t.observe_vehicle('v1',2,3,5,2,4)
    t.vehicle_arrived('v1',3)
    s=t.summary(3)
    assert s['vehicles_observed']==1
    assert s['vehicles_arrived']==1
    assert s['throughput']==1
    assert s['average_stops']==1
    assert s['fuel_mg']==17
    assert s['co2_mg']==34
    assert s['average_delay_s']==3

def test_queue_summary():
    t=TelemetryCollector(); t.observe_queue(3); t.observe_queue(7)
    assert t.summary(0)['max_queue']==7
    assert t.summary(0)['average_queue']==5
