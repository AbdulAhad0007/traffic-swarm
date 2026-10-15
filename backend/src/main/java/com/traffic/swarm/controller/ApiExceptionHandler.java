package com.traffic.swarm.controller;

import java.util.Map;
import java.util.UUID;
import org.springframework.http.*;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;

@RestControllerAdvice
public class ApiExceptionHandler {
  @ExceptionHandler(MethodArgumentNotValidException.class)
  ResponseEntity<?> validation(MethodArgumentNotValidException ex) {
    return ResponseEntity.badRequest().body(Map.of("error", "validation_failed", "message", "Request validation failed"));
  }
  @ExceptionHandler(MethodArgumentTypeMismatchException.class)
  ResponseEntity<?> typeMismatch(MethodArgumentTypeMismatchException ex) {
    if (ex.getRequiredType() == UUID.class) return ResponseEntity.badRequest().body(Map.of("error", "invalid_uuid"));
    return ResponseEntity.badRequest().body(Map.of("error", "invalid_parameter"));
  }
  @ExceptionHandler(Exception.class)
  ResponseEntity<?> unexpected(Exception ex) {
    return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "internal_error", "message", ex.getMessage() == null ? "Unexpected error" : ex.getMessage()));
  }
}
