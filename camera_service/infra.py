"""Clients for the camera infrastructure. They read what a deployment reports and assume little about it.

Frigate deployments differ: port 5000 is unauthenticated, port 8971 wants a login or bearer token, and a proxy can add
anything. The client tries what it was given, records the version the server reports, and treats each endpoint as optional.
Credentials stay in this process; every value that leaves it passes through mask().
"""
from __future__ import annotations
import re
import time
from urllib.parse import quote, urlparse

import httpx

from camera_service.events import iso, mask

TIMEOUT = httpx.Timeout(5.0, connect=3.0)
REPLAY_SOURCE = re.compile(r"(?i)\.(mp4|mkv|avi|mov|webm|m4v|ts)(\b|$|#|\?)")


def check_http_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("Enter an http:// or https:// address.")
    if parsed.username or parsed.password:
        raise ValueError("Put credentials in their own fields, not in the address.")
    return url


class FrigateClient:
    def __init__(self, url: str, token: str | None = None, username: str | None = None, password: str | None = None, verify_tls: bool = True, transport=None):
        self.url = check_http_url(url)
        self.token, self.username, self.password = token, username, password
        self.client = httpx.Client(base_url=self.url, timeout=TIMEOUT, verify=verify_tls, transport=transport, follow_redirects=False)
        if token:
            self.client.headers["Authorization"] = f"Bearer {token}"

    def close(self) -> None:
        self.client.close()

    def _login(self) -> bool:
        if not (self.username and self.password):
            return False
        res = self.client.post("/api/login", json={"user": self.username, "password": self.password})
        return res.status_code < 300

    def _get(self, path: str, **params):
        res = self.client.get(path, params=params or None)
        if res.status_code == 401 and self._login():
            res = self.client.get(path, params=params or None)
        return res

    def status(self) -> dict:
        """Never raises for a server problem: the result says what state the service is in."""
        try:
            res = self._get("/api/version")
        except httpx.HTTPError as err:
            return {"state": "DISCONNECTED", "detail": f"Cannot reach Frigate ({type(err).__name__}).", "checked_at": iso()}
        if res.status_code in (401, 403):
            return {"state": "AUTH_REQUIRED", "detail": f"Frigate answered {res.status_code}. Check the token or username and password.", "checked_at": iso()}
        if res.status_code != 200:
            return {"state": "ERROR", "detail": f"Frigate answered {res.status_code} on /api/version.", "checked_at": iso()}
        out = {"state": "CONNECTED", "version": res.text.strip().strip('"')[:40], "detail": None, "cameras": {}, "events": [], "checked_at": iso()}
        config = self._json("/api/config") or {}
        stats = self._json("/api/stats") or {}
        fps = stats.get("cameras") or {}
        for name, cam in (config.get("cameras") or {}).items():
            live = fps.get(name) or {}
            out["cameras"][name] = {
                "name": name, "enabled": cam.get("enabled", cam.get("enabled_in_config", True)), "recording": bool((cam.get("record") or {}).get("enabled")),
                "detect": bool((cam.get("detect") or {}).get("enabled")), "camera_fps": live.get("camera_fps"), "process_fps": live.get("process_fps"),
                "detection_fps": live.get("detection_fps"), "skipped_fps": live.get("skipped_fps"), "connected": bool(live.get("camera_fps")) if live else None,
                "inputs": [{"path": mask(i.get("path", "")), "roles": i.get("roles", [])} for i in ((cam.get("ffmpeg") or {}).get("inputs") or [])],
            }
        streams = (config.get("go2rtc") or {}).get("streams") or {}
        out["streams"] = sorted(streams)
        if not config:
            out["detail"] = "Connected, but /api/config returned nothing usable."
        events = self._json("/api/events", limit=15)
        if isinstance(events, list):
            out["events"] = [{"id": e.get("id"), "camera": e.get("camera"), "label": e.get("label"), "start_time": e.get("start_time"), "end_time": e.get("end_time"),
                              "has_clip": e.get("has_clip")} for e in events]
        return out

    def _json(self, path: str, **params):
        try:
            res = self._get(path, **params)
            return res.json() if res.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None


class Go2rtcClient:
    def __init__(self, url: str, username: str | None = None, password: str | None = None, rtsp_url: str | None = None, transport=None):
        self.url = check_http_url(url)
        self.username, self.password = username, password
        self.rtsp_base = (rtsp_url or f"rtsp://{urlparse(self.url).hostname}:8554").rstrip("/")
        auth = (username, password) if username and password else None
        self.client = httpx.Client(base_url=self.url, timeout=TIMEOUT, auth=auth, transport=transport)

    def close(self) -> None:
        self.client.close()

    def restream_url(self, name: str) -> str:
        """The endpoint the ingestion service reads. Distinct from the source, which go2rtc alone connects to."""
        base = self.rtsp_base
        return f"{base}/{quote(name, safe='')}"

    def add_stream(self, name: str, source: str) -> None:
        res = self.client.put("/api/streams", params={"name": name, "src": source})
        res.raise_for_status()

    def status(self) -> dict:
        try:
            info = self.client.get("/api")
            res = self.client.get("/api/streams")
        except httpx.HTTPError as err:
            return {"state": "DISCONNECTED", "detail": f"Cannot reach go2rtc ({type(err).__name__}).", "streams": {}, "checked_at": iso()}
        if res.status_code in (401, 403):
            return {"state": "AUTH_REQUIRED", "detail": f"go2rtc answered {res.status_code}. Check the username and password.", "streams": {}, "checked_at": iso()}
        if res.status_code != 200:
            return {"state": "ERROR", "detail": f"go2rtc answered {res.status_code} on /api/streams.", "streams": {}, "checked_at": iso()}
        version = None
        if info.status_code == 200:
            try:
                version = info.json().get("version")
            except ValueError:
                pass
        streams = {}
        for name, stream in (res.json() or {}).items():
            stream = stream or {}
            producers = stream.get("producers") or []
            consumers = stream.get("consumers") or []
            # An idle producer reports `url`; once connected it reports `source` instead (go2rtc 1.9.15).
            sources = [str(p.get("source") or p.get("url") or p.get("remote_addr") or "") for p in producers]
            streams[name] = {
                "name": name, "producers": len(producers), "consumers": len(consumers), "sources": [mask(s) for s in sources],
                # go2rtc connects to a source only while something consumes it, so "ready" is the normal idle state.
                "state": "ACTIVE" if consumers else "READY",
                "looks_like_file": any(REPLAY_SOURCE.search(s) for s in sources),
                "bytes_received": sum(int(p.get("bytes_recv") or 0) for p in producers),
            }
        return {"state": "CONNECTED", "version": version, "detail": None, "streams": streams, "rtsp_base": self.rtsp_base, "checked_at": iso()}


def elapsed_ms(start: float) -> float:
    return round((time.perf_counter() - start) * 1000, 1)
