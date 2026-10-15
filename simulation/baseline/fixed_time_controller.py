"""SUMO fixed-time baseline runner with reproducible seed and measured KPIs.

Runs the network's own signal programs unchanged. Measurement goes through the same
SumoSession as the swarm controller.
"""
import csv, json, time
from pathlib import Path
from simulation.network.network_model import NetworkModel
from simulation.network.presets import resolve_preset, LEGACY_PRESET
from simulation.runtime import SumoSession, net_file_from_cfg
from simulation.metrics import sumo_kpis
from simulation.safety.signal_audit import build_auditor
from simulation.telemetry import TelemetryCollector

class FixedTimeController:
    controller_name = "baseline"      # label stored in the summary (kept for artifact compatibility)
    file_prefix = "baseline"

    def __init__(self, seed=42, gui=None, settings=None, hooks=None, port=None):
        self.seed = seed
        self.gui = gui
        self.settings = dict(settings or resolve_preset(LEGACY_PRESET)["controller"])
        self.hooks = list(hooks or [])
        self.port = port

    def prepare(self, sumocfg, out: Path, model: NetworkModel):
        """Return (sumocfg to run, auditor phase maps or None, extra summary fields). Subclasses
        (the SUMO actuated controller) swap in their own signal programs here."""
        return sumocfg, None, {}

    def verify(self, session) -> dict:
        """Called once after SUMO has started; subclasses check their programs are really active."""
        return {}

    def run(self, sumocfg, output_dir, max_time=3600.0):
        out = Path(output_dir); out.mkdir(parents=True, exist_ok=True)
        model = NetworkModel.from_net_file(net_file_from_cfg(sumocfg))
        run_cfg, phase_maps, extra = self.prepare(sumocfg, out, model)
        auditor = build_auditor(model, self.settings, phase_maps)
        session = SumoSession(run_cfg, self.seed, self.gui, auditor=auditor, output_dir=out, hooks=self.hooks, port=self.port)
        wall0 = time.perf_counter()
        session.start()
        collector = TelemetryCollector(); series=[]
        try:
            extra.update(self.verify(session))
            while session.running(max_time):
                queue = session.step(collector)
                series.append({"time": session.now, "total_halting": queue})
            timed_out = session.running(float("inf"))
            summary = {"seed": self.seed, "controller": self.controller_name, "samples": len(series), "timed_out": timed_out,
                       **collector.summary(session.now), "sumo_version": session.sumo_version,
                       "tls_total": len(model.tls), "safety_audit": auditor.report(),
                       "simulated_end_s": session.now, **extra}
        finally:
            session.close()
        summary["wall_time_s"] = round(time.perf_counter() - wall0, 3)
        # Signal timing is decided inside SUMO for fixed-time/actuated programs; no TraCI decision latency exists.
        summary.setdefault("decision_tick_latency_ms", None)
        summary.update(sumo_kpis(out, summary["vehicles_observed"], summary["vehicles_arrived"], timed_out))
        if session.closure is not None:
            summary["closure_check"] = session.closure.report()
        for hook in self.hooks:
            if hasattr(hook, "report"):
                summary.update(hook.report())
        with (out / f"{self.file_prefix}_timeseries.csv").open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["time", "total_halting"]); w.writeheader(); w.writerows(series)
        (out / f"{self.file_prefix}_summary.json").write_text(json.dumps(summary, indent=2))
        return summary
