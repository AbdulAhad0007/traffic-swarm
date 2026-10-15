package com.traffic.swarm; import static org.junit.jupiter.api.Assertions.*; import org.junit.jupiter.api.Test; import com.traffic.swarm.model.ExperimentRequest;
class ExperimentRequestTests { @Test void recordWorks(){var r=new ExperimentRequest("normal",42,"comparison");assertEquals("normal",r.scenario());assertEquals(42,r.seed());} }
