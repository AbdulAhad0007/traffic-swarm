from kpi_engine import percent_change,compare
def test_percent(): assert percent_change(100,90)==-10
def test_missing(): assert compare({'max_queue':10},{'max_queue':8})['max_queue']['change_pct']==-20
def test_zero(): assert percent_change(0,1) is None
