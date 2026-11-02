"""HTTP API of the camera service. Run: uvicorn camera_service.api:app --host 127.0.0.1 --port 8091

The browser never reaches this directly. The website's /api/camera proxy checks module state and the admin session, then
calls here with the gateway secret and the caller's role. This is the same arrangement as the simulation lab's.
"""
from __future__ import annotations
import hmac
import json
import logging
import os
import threading
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from camera_service.service import Conflict, LiveCameraService, VIDEO_TYPES
from camera_service.vault import VaultLocked

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
MAX_UPLOAD_BYTES = 1024 * 1024 * 1024
MAX_EVENT_STREAMS = 20
ADMIN_HEADER = "x-tsi-role"
_streams = threading.BoundedSemaphore(MAX_EVENT_STREAMS)


def create_app(service: LiveCameraService | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.service = service or LiveCameraService()
        app.state.service.start()
        yield
        app.state.service.shutdown()

    app = FastAPI(title="Traffic Swarm Intelligence Live Camera", version="1.0.0", lifespan=lifespan)

    @app.middleware("http")
    async def require_gateway_secret(request: Request, call_next):
        secret = os.environ.get("TSI_GATEWAY_SECRET")
        if secret and request.url.path != "/api/camera/health" and not hmac.compare_digest(request.headers.get("x-tsi-gateway-secret", "").encode(), secret.encode()):
            return JSONResponse({"detail": "forbidden"}, status_code=403)
        return await call_next(request)

    @app.exception_handler(KeyError)
    async def _missing(_request, _err):
        return JSONResponse({"detail": "No such camera."}, status_code=404)

    @app.exception_handler(ValueError)
    async def _invalid(_request, err):
        return JSONResponse({"detail": str(err)}, status_code=400)

    @app.exception_handler(Conflict)
    async def _conflict(_request, err):
        return JSONResponse({"detail": str(err)}, status_code=409)

    @app.exception_handler(VaultLocked)
    async def _locked(_request, err):
        return JSONResponse({"detail": str(err)}, status_code=409)

    @app.exception_handler(PermissionError)
    async def _refused(_request, err):
        return JSONResponse({"detail": str(err)}, status_code=403)

    def svc(request: Request) -> LiveCameraService:
        return request.app.state.service

    def is_admin(request: Request) -> bool:
        return request.headers.get(ADMIN_HEADER) == "admin"

    def require_admin(request: Request) -> None:
        if not is_admin(request):
            raise HTTPException(403, "Administrator access is required.")

    # ---------------------------------------------------------------- overview
    @app.get("/api/camera/health")
    def health(request: Request):
        return {"status": "UP", "service": "live-camera"}

    @app.get("/api/camera/overview")
    def overview(request: Request):
        return svc(request).overview(is_admin(request))

    @app.get("/api/camera/events")
    def events(request: Request, after: int = Query(0, ge=0), limit: int = Query(300, ge=1, le=2000)):
        return svc(request).hub.since(after, limit)

    @app.get("/api/camera/stream")
    def stream(request: Request, after: int = Query(0, ge=0)):
        """Server-sent events: pipeline events, detections and periodic status for one page."""
        if not _streams.acquire(blocking=False):
            raise HTTPException(503, "Too many live viewers.")
        service, admin = svc(request), is_admin(request)

        def generate():
            seq, last_overview = after, 0.0
            sent: dict = {}
            try:
                yield "retry: 2000\n\n"
                while not service.stop_flag.is_set():
                    service.hub.wait(seq, 0.25)
                    payload: dict = {}
                    items = service.hub.since(seq, 400)
                    if items:
                        seq = items[-1]["seq"]
                        payload["events"] = items
                    detections = {}
                    for cid, rt in list(service.runtimes.items()):
                        latest = rt.latest
                        if latest and sent.get(cid) != latest["frame_number"]:
                            sent[cid] = latest["frame_number"]
                            detections[cid] = latest
                    if detections:
                        payload["detections"] = detections
                    now = time.time()
                    if now - last_overview >= 1.0:
                        last_overview = now
                        payload["overview"] = service.overview(admin)
                    if payload:
                        yield f"data: {json.dumps(payload, default=str)}\n\n"
                    else:
                        yield ": keepalive\n\n"
            finally:
                _streams.release()

        return StreamingResponse(generate(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    # ---------------------------------------------------------------- cameras
    @app.get("/api/camera/cameras")
    def cameras(request: Request):
        service = svc(request)
        return [service.camera_view(c, is_admin(request)) for c in list(service.rows)]

    @app.post("/api/camera/cameras", status_code=201)
    def register(request: Request, body: dict):
        require_admin(request)
        return svc(request).add_camera(body)

    @app.get("/api/camera/cameras/{camera_id}")
    def camera(request: Request, camera_id: str):
        return svc(request).camera_view(camera_id, is_admin(request))

    @app.patch("/api/camera/cameras/{camera_id}")
    def update(request: Request, camera_id: str, body: dict):
        require_admin(request)
        return svc(request).update_camera(camera_id, body)

    @app.delete("/api/camera/cameras/{camera_id}", status_code=204)
    def delete(request: Request, camera_id: str):
        require_admin(request)
        svc(request).delete_camera(camera_id)

    @app.post("/api/camera/cameras/{camera_id}/start")
    def start(request: Request, camera_id: str):
        require_admin(request)
        return svc(request).update_camera(camera_id, {"enabled": True})

    @app.post("/api/camera/cameras/{camera_id}/stop")
    def stop(request: Request, camera_id: str):
        require_admin(request)
        return svc(request).update_camera(camera_id, {"enabled": False})

    @app.post("/api/camera/cameras/{camera_id}/reconnect")
    def reconnect(request: Request, camera_id: str):
        require_admin(request)
        return svc(request).reconnect(camera_id)

    @app.post("/api/camera/cameras/{camera_id}/test")
    def test_camera(request: Request, camera_id: str):
        require_admin(request)
        return svc(request).test_connection(camera_id)

    @app.get("/api/camera/cameras/{camera_id}/health")
    def camera_health(request: Request, camera_id: str):
        view = svc(request).camera_view(camera_id, True)
        keys = ("id", "status", "detail", "fps", "last_frame", "last_frame_age_s", "latency_ms", "detection_status", "next_retry_in_s", "frames")
        return {k: view[k] for k in keys}

    @app.get("/api/camera/cameras/{camera_id}/frame.jpg")
    def frame(request: Request, camera_id: str, after: int = Query(-1), wait: float = Query(0.0, ge=0, le=2.0)):
        """Newest frame from the stream reader. Nothing is generated: with no frame there is only a 204."""
        service = svc(request)
        service._row(camera_id)
        rt = service.runtimes.get(camera_id)
        preview = rt.worker.wait_preview(after, wait) if rt else None
        if preview is None:
            return Response(status_code=204, headers={"Cache-Control": "no-store"})
        number, jpeg, received, source_ms, width, height = preview
        return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store", "X-Frame-Number": str(number), "X-Frame-Received": str(received), "X-Frame-Width": str(width), "X-Frame-Height": str(height),
                                                                 "X-Data-Class": rt.data_class})

    @app.get("/api/camera/cameras/{camera_id}/frame-stats")
    def frame_stats(request: Request, camera_id: str):
        service = svc(request)
        view = service.camera_view(camera_id)
        rt = service.runtimes.get(camera_id)
        return {**view["frames"], "fps": view["fps"], "processing_fps": view["processing_fps"], "latency_ms": view["latency_ms"], "last_frame": view["last_frame"], "recent": list(rt.frame_log) if rt else []}

    @app.get("/api/camera/cameras/{camera_id}/detections")
    def detections(request: Request, camera_id: str):
        service = svc(request)
        service._row(camera_id)
        rt = service.runtimes.get(camera_id)
        return {"latest": rt.latest if rt and rt.worker.state == "CONNECTED" else None}

    @app.get("/api/camera/cameras/{camera_id}/analytics")
    def analytics(request: Request, camera_id: str):
        service = svc(request)
        service._row(camera_id)
        rt = service.runtimes.get(camera_id)
        return {"current": rt.analytics if rt else None, "history": list(rt.history) if rt else []}

    # ---------------------------------------------------------------- test sources
    @app.get("/api/camera/test-sources")
    def test_sources(request: Request):
        require_admin(request)
        media = svc(request).runtime_dir / "media"
        return {"files": sorted(p.name for p in media.iterdir() if p.suffix.lower() in VIDEO_TYPES) if media.is_dir() else [], "enabled": svc(request).flag("test-mode")}

    @app.post("/api/camera/test-sources", status_code=201)
    async def upload(request: Request, name: str = Query(..., max_length=120)):
        """Upload a video for REPLAY mode. Only the extension of the given name is kept."""
        require_admin(request)
        service = svc(request)
        if not service.flag("test-mode"):
            raise Conflict("Test sources are turned off in the admin panel.")
        suffix = Path(name).suffix.lower()
        if suffix not in VIDEO_TYPES:
            raise ValueError(f"Use one of: {', '.join(VIDEO_TYPES)}")
        media = service.runtime_dir / "media"
        media.mkdir(parents=True, exist_ok=True)
        target = media / f"replay-{uuid.uuid4().hex[:12]}{suffix}"
        size = 0
        try:
            with open(target, "wb") as handle:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise ValueError("The video is larger than the 1 GB limit.")
                    handle.write(chunk)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        if not size:
            target.unlink(missing_ok=True)
            raise ValueError("The upload was empty.")
        return {"file": target.name, "bytes": size}

    # ---------------------------------------------------------------- infrastructure
    @app.get("/api/camera/infra")
    def infra(request: Request):
        require_admin(request)
        service = svc(request)
        return {"frigate": service.infra_view("frigate"), "go2rtc": service.infra_view("go2rtc")}

    @app.post("/api/camera/infra/{name}")
    def infra_save(request: Request, name: str, body: dict):
        require_admin(request)
        return svc(request).configure_infra(name, body)

    @app.post("/api/camera/infra/{name}/test")
    def infra_test(request: Request, name: str, body: dict | None = None):
        require_admin(request)
        if name not in ("frigate", "go2rtc"):
            raise ValueError("unknown service")
        return svc(request).test_infra(name, body)

    @app.post("/api/camera/infra/{name}/reconnect")
    def infra_reconnect(request: Request, name: str):
        require_admin(request)
        service = svc(request)
        if name not in ("frigate", "go2rtc"):
            raise ValueError("unknown service")
        service._rebuild_clients()
        return service.check_infra(name, log_result=True)

    @app.get("/api/camera/topology")
    def topology(request: Request):
        return svc(request).topology(is_admin(request))

    @app.get("/api/camera/frigate/events")
    def frigate_events(request: Request):
        require_admin(request)
        return svc(request).infra["frigate"].get("events") or []

    # ---------------------------------------------------------------- agents and signals
    @app.get("/api/camera/agents")
    def agents(request: Request):
        return svc(request).network.snapshot()

    @app.get("/api/camera/signal")
    def signal(request: Request):
        return svc(request).signal_view()

    @app.get("/api/camera/signal/decisions")
    def decisions(request: Request, limit: int = Query(50, ge=1, le=200)):
        return list(svc(request).decisions)[-limit:]

    @app.get("/api/camera/signal/proposals")
    def proposals(request: Request):
        return [a["proposal"] for a in svc(request).network.snapshot()["agents"] if a["proposal"]]

    @app.post("/api/camera/signal/mode")
    def mode(request: Request, body: dict):
        require_admin(request)
        if body.get("mode") == "REAL_CONTROLLER" and body.get("confirm") is not True:
            raise HTTPException(400, "Real controller mode needs explicit confirmation.")
        return svc(request).set_mode(body.get("mode"))

    return app


app = create_app()
