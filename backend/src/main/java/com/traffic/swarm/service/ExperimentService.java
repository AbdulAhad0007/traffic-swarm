package com.traffic.swarm.service;

import java.util.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class ExperimentService {
  private final JdbcTemplate db;
  public ExperimentService(JdbcTemplate db){ this.db=db; }

  public Map<String,Object> create(String scenario,int seed,String controller){
    UUID id=UUID.randomUUID();
    db.update("INSERT INTO experiments(id,scenario,seed,controller,status) VALUES (CAST(? AS UUID),?,?,?,'QUEUED')",id.toString(),scenario,seed,controller);
    return get(id);
  }
  public Map<String,Object> get(UUID id){
    var rows=db.queryForList("SELECT id,scenario,seed,controller,status,created_at,started_at,completed_at,result,error_message FROM experiments WHERE id=CAST(? AS UUID)",id.toString());
    return rows.isEmpty()?Map.of("error","experiment_not_found"):rows.get(0);
  }
  public List<Map<String,Object>> recent(int limit){
    return db.queryForList("SELECT id,scenario,seed,controller,status,created_at,started_at,completed_at,result,error_message FROM experiments ORDER BY created_at DESC LIMIT ?",Math.max(1,Math.min(limit,100)));
  }
  public boolean markRunning(UUID id){
    return db.update("UPDATE experiments SET status='RUNNING',started_at=now(),error_message=NULL WHERE id=CAST(? AS UUID) AND status='QUEUED'",id.toString())>0;
  }
  public void result(UUID id,String result){
    db.update("UPDATE experiments SET status='COMPLETED',completed_at=now(),result=CAST(? AS JSONB),error_message=NULL WHERE id=CAST(? AS UUID)",result,id.toString());
  }
  public void fail(UUID id,String message){
    db.update("UPDATE experiments SET status='FAILED',completed_at=now(),error_message=? WHERE id=CAST(? AS UUID)",message,id.toString());
  }
}
