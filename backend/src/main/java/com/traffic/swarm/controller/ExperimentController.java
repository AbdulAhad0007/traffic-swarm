package com.traffic.swarm.controller;

import com.traffic.swarm.model.ExperimentRequest;
import com.traffic.swarm.service.*;
import jakarta.validation.Valid;
import java.util.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/experiments")
public class ExperimentController {
  private static final Set<String> SCENARIOS=Set.of("normal","rush-hour","uneven","sudden-congestion","road-closure");
  private static final Set<String> CONTROLLERS=Set.of("comparison","baseline","swarm");
  private final ExperimentService service; private final ExperimentOrchestrator orchestrator;
  public ExperimentController(ExperimentService s,ExperimentOrchestrator o){service=s;orchestrator=o;}

  @PostMapping
  public ResponseEntity<?> create(@Valid @RequestBody ExperimentRequest r){
    if(!SCENARIOS.contains(r.scenario())) return ResponseEntity.badRequest().body(Map.of("error","invalid_scenario"));
    if(!CONTROLLERS.contains(r.controller())) return ResponseEntity.badRequest().body(Map.of("error","invalid_controller"));
    return ResponseEntity.status(201).body(service.create(r.scenario(),r.seed(),r.controller()));
  }

  @GetMapping("/{id}")
  public ResponseEntity<?> get(@PathVariable UUID id){
    var result=service.get(id); return result.containsKey("error")?ResponseEntity.notFound().build():ResponseEntity.ok(result);
  }

  @GetMapping
  public List<Map<String,Object>> recent(@RequestParam(defaultValue="20") int limit){return service.recent(limit);}

  @PostMapping("/{id}/run")
  public ResponseEntity<?> run(@PathVariable UUID id){
    var e=service.get(id); if(e.containsKey("error")) return ResponseEntity.notFound().build();
    if(!service.markRunning(id)) return ResponseEntity.status(409).body(Map.of("error","experiment_not_queued"));
    orchestrator.run(id,(String)e.get("scenario"),(Integer)e.get("seed"));
    return ResponseEntity.accepted().body(Map.of("status","RUNNING","id",id));
  }
}
