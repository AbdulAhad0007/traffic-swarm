package com.traffic.swarm.model;
import jakarta.validation.constraints.*;
public record ExperimentRequest(@NotBlank String scenario,@Min(0) int seed,@NotBlank String controller) {}
