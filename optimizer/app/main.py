from fastapi import FastAPI
from pydantic import BaseModel, Field
from .swarm.engine import TrafficState, optimize
from .swarm.blackboard import SwarmBlackboard, AgentObservation
app=FastAPI(title='Traffic Swarm Intelligence Optimizer', version='1.0.0')
blackboard=SwarmBlackboard()
class OptimizeRequest(BaseModel):
    intersection: str = Field(pattern=r'^[A-Za-z0-9_.:#-]{1,64}$')
    ns_queue: float=Field(default=0, ge=0); ew_queue: float=Field(default=0, ge=0)
    ns_arrival: float=Field(default=0, ge=0); ew_arrival: float=Field(default=0, ge=0)
    ns_wait: float=Field(default=0, ge=0); ew_wait: float=Field(default=0, ge=0)
    current_phase: int=Field(default=0, ge=0); risk: float=Field(default=0, ge=0)
    seed: int|None=None
@app.get('/health')
def health(): return {'status':'UP','service':'optimizer'}
@app.get('/api/swarm/blackboard')
def board(): return blackboard.snapshot()
@app.post('/api/swarm/observe')
def observe(o: AgentObservation): blackboard.publish(o); return {'status':'published'}
class TopologyRequest(BaseModel):
    neighbors: dict[str, list[str]]
@app.put('/api/swarm/topology')
def topology(req: TopologyRequest): blackboard.set_topology(req.neighbors); return {'status':'updated','intersections':len(req.neighbors)}
@app.post('/api/swarm/optimize')
def run(req: OptimizeRequest):
    state=TrafficState(**req.model_dump(exclude={'seed'}))
    return optimize(state, blackboard.pheromone, blackboard.neighbor_pressure(state.intersection), seed=req.seed,
                    neighbors=blackboard.neighbors.get(state.intersection, []))
