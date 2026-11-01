package com.traffic.swarm.controller;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/** With TSI_GATEWAY_SECRET set, only the website's proxy (which enforces module rules) may call the API. */
@Component
public class GatewaySecretFilter extends OncePerRequestFilter {
  private final byte[] secret;

  public GatewaySecretFilter(@Value("${tsi.gateway.secret:}") String secret) {
    this.secret = secret.getBytes(StandardCharsets.UTF_8);
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return secret.length == 0 || "OPTIONS".equals(request.getMethod()) || path.equals("/api/health") || path.equals("/actuator/health");
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
    String given = request.getHeader("X-TSI-Gateway-Secret");
    if (given == null || !MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), secret)) {
      response.sendError(HttpServletResponse.SC_FORBIDDEN);
      return;
    }
    chain.doFilter(request, response);
  }
}
