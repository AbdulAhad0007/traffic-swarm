package com.traffic.swarm.service;

import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.util.*;
import java.util.concurrent.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class ExperimentOrchestrator {
  private final ExperimentService service;
  private final ExecutorService pool=Executors.newCachedThreadPool();
  private final String python; private final Path root; private final long timeoutSeconds;

  public ExperimentOrchestrator(ExperimentService s,
      @Value("${tsi.experiment.python:python}") String python,
      @Value("${tsi.experiment.root:../}") String root,
      @Value("${tsi.experiment.timeout-seconds:7200}") long timeoutSeconds){
    service=s; this.python=python; this.root=Paths.get(root).toAbsolutePath().normalize(); this.timeoutSeconds=timeoutSeconds;
  }

  public void run(UUID id,String scenario,int seed){
    pool.submit(()->execute(id,scenario,seed));
  }

  private void execute(UUID id,String scenario,int seed){
    Path logDir=root.resolve("experiments/runs").resolve(scenario).resolve("seed-"+seed);
    try{
      Files.createDirectories(logDir);
      Process p=new ProcessBuilder(python,"experiments/tools/run_experiment.py","--scenario",scenario,"--seed",String.valueOf(seed),"--root",root.toString())
          .directory(root.toFile()).redirectErrorStream(true).start();
      String output;
      try(var executor=Executors.newSingleThreadExecutor()){
        Future<String> stream=executor.submit(()->new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8));
        if(!p.waitFor(timeoutSeconds,TimeUnit.SECONDS)){
          p.destroyForcibly(); stream.cancel(true); throw new TimeoutException("experiment timed out after "+timeoutSeconds+" seconds");
        }
        output=stream.get(5,TimeUnit.SECONDS);
      }
      Files.writeString(logDir.resolve("orchestrator.log"),output,StandardOpenOption.CREATE,StandardOpenOption.TRUNCATE_EXISTING);
      if(p.exitValue()!=0) throw new IllegalStateException("experiment process failed with exit code "+p.exitValue());
      Path result=logDir.resolve("comparison.json");
      if(!Files.isRegularFile(result)) throw new IllegalStateException("comparison.json was not produced");
      service.result(id,Files.readString(result));
    }catch(Exception e){
      try { Files.writeString(logDir.resolve("orchestrator.log"), String.valueOf(e), StandardOpenOption.CREATE,StandardOpenOption.APPEND); } catch(Exception ignored) {}
      service.fail(id,e.getMessage()==null?e.getClass().getSimpleName():e.getMessage());
    }
  }
}
