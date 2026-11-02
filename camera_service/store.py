"""Persistence. The project's database is Supabase, reached through its REST API like the website does.

Until db/migrations/005_live_camera_module.sql has run, or with no database configured, a local SQLite file with
the same tables keeps the service usable, and /overview says so. Raw frames are never written to either.
"""
from __future__ import annotations
import json
import logging
import os
import queue
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

log = logging.getLogger("camera.store")
JSON_COLUMNS = {"config", "zones", "bounding_box", "details", "value"}
TABLES = {
    "lcm_cameras": "id", "lcm_settings": "key", "lcm_frame_metadata": "id", "lcm_vehicle_detections": "id",
    "lcm_traffic_analytics": "id", "lcm_signal_decisions": "id",
}
SQLITE_SCHEMA = """
create table if not exists lcm_cameras (id text primary key, camera_name text, location text, intersection_id text, source_type text,
  stream_reference text, data_class text, enabled integer, status text, config text, zones text, created_at text, updated_at text);
create table if not exists lcm_settings (key text primary key, value text, updated_at text);
create table if not exists lcm_frame_metadata (id integer primary key autoincrement, camera_id text, frame_number integer, source_timestamp_ms real,
  received_timestamp text, width integer, height integer, processing_status text, processing_ms real);
create table if not exists lcm_vehicle_detections (id integer primary key autoincrement, camera_id text, frame_number integer, tracking_id integer,
  vehicle_class text, confidence real, bounding_box text, timestamp text);
create table if not exists lcm_traffic_analytics (id integer primary key autoincrement, intersection_id text, camera_id text, vehicle_count integer,
  queue_length_m real, queue_vehicles integer, average_speed_mps real, occupancy real, congestion_level text, quality text, data_class text, details text, timestamp text);
create table if not exists lcm_signal_decisions (id integer primary key autoincrement, intersection_id text, camera_id text, proposed_phase text, approved_phase text,
  decision_reason text, source text, mode text, validation_status text, details text, timestamp text);
"""


class SqliteBackend:
    name = "local-sqlite"

    def __init__(self, path: Path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(path), check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.db.executescript(SQLITE_SCHEMA)

    @staticmethod
    def _encode(row: dict) -> dict:
        return {k: json.dumps(v) if k in JSON_COLUMNS else (int(v) if isinstance(v, bool) else v) for k, v in row.items()}

    @staticmethod
    def _decode(row) -> dict:
        out = dict(row)
        for k in JSON_COLUMNS & out.keys():
            out[k] = json.loads(out[k]) if out[k] else None
        if "enabled" in out:
            out["enabled"] = bool(out["enabled"])
        return out

    def upsert(self, table: str, row: dict) -> None:
        row = self._encode(row)
        key = TABLES[table]
        updates = ",".join(f"{c}=excluded.{c}" for c in row if c != key) or f"{key}={key}"
        with self.lock:
            self.db.execute(f"insert into {table} ({','.join(row)}) values ({','.join('?' * len(row))}) on conflict({key}) do update set {updates}", list(row.values()))
            self.db.commit()

    def insert(self, table: str, rows: list[dict]) -> None:
        if not rows:
            return
        with self.lock:
            for row in map(self._encode, rows):
                self.db.execute(f"insert into {table} ({','.join(row)}) values ({','.join('?' * len(row))})", list(row.values()))
            self.db.commit()

    def select(self, table: str, where: dict | None = None, order: str | None = None, limit: int | None = None) -> list[dict]:
        where = where or {}
        sql = f"select * from {table}" + (" where " + " and ".join(f"{c}=?" for c in where) if where else "")
        if order:
            sql += " order by " + order.replace(".", " ")
        if limit:
            sql += f" limit {int(limit)}"
        with self.lock:
            return [self._decode(r) for r in self.db.execute(sql, list(where.values())).fetchall()]

    def delete(self, table: str, column: str, value) -> None:
        with self.lock:
            self.db.execute(f"delete from {table} where {column}=?", (value,))
            self.db.commit()

    def delete_older(self, table: str, column: str, cutoff_iso: str) -> None:
        with self.lock:
            self.db.execute(f"delete from {table} where {column}<?", (cutoff_iso,))
            self.db.commit()


class SupabaseBackend:
    name = "supabase"

    def __init__(self, url: str, key: str):
        self.url, self.key = url.rstrip("/"), key

    def _call(self, path: str, method: str = "GET", body=None, prefer: str | None = None):
        headers = {"apikey": self.key, "Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
        if prefer:
            headers["Prefer"] = prefer
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", method=method, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(req, timeout=8) as res:
            text = res.read().decode()
        return json.loads(text) if text else None

    def probe(self) -> None:
        for table in TABLES:
            self._call(f"{table}?select=*&limit=1")

    def upsert(self, table: str, row: dict) -> None:
        self._call(f"{table}?on_conflict={TABLES[table]}", "POST", row, "resolution=merge-duplicates")

    def insert(self, table: str, rows: list[dict]) -> None:
        if rows:
            self._call(table, "POST", rows)

    def select(self, table: str, where: dict | None = None, order: str | None = None, limit: int | None = None) -> list[dict]:
        params = [("select", "*")] + [(k, f"eq.{v}") for k, v in (where or {}).items()]
        if order:
            params.append(("order", order))
        if limit:
            params.append(("limit", str(int(limit))))
        return self._call(f"{table}?{urllib.parse.urlencode(params)}") or []

    def delete(self, table: str, column: str, value) -> None:
        self._call(f"{table}?{urllib.parse.urlencode({column: f'eq.{value}'})}", "DELETE")

    def delete_older(self, table: str, column: str, cutoff_iso: str) -> None:
        self._call(f"{table}?{urllib.parse.urlencode({column: f'lt.{cutoff_iso}'})}", "DELETE")

    def read_flags(self) -> tuple[list, list]:
        return (self._call("site_modules?select=id,slug,is_enabled&slug=eq.live-camera") or [],
                self._call("site_module_sections?select=module_id,slug,is_enabled") or [])


def open_backend(sqlite_path: Path):
    """Returns (backend, reason it is local or None, Supabase client for module flags or None)."""
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        return SqliteBackend(sqlite_path), "No database is configured.", None
    client = SupabaseBackend(url, key)
    try:
        client.probe()
        return client, None, client
    except urllib.error.HTTPError as err:
        reason = "Run db/migrations/005_live_camera_module.sql in Supabase." if err.code in (400, 404) else f"Supabase answered {err.code}."
    except Exception as err:
        reason = f"Supabase is not reachable ({type(err).__name__})."
    log.warning("Using the local camera database: %s", reason)
    return SqliteBackend(sqlite_path), reason, client


class BatchWriter:
    """High-rate rows go through here. A slow database costs rows, counted, never camera throughput."""

    def __init__(self, backend, capacity: int = 2000):
        self.backend = backend
        self.q: queue.Queue = queue.Queue(capacity)
        self.dropped = 0
        self.failures = 0
        self.last_error = None
        self.stop_flag = threading.Event()
        self.thread = threading.Thread(target=self._run, name="lcm-store", daemon=True)
        self.thread.start()

    def add(self, table: str, row: dict) -> None:
        try:
            self.q.put_nowait((table, row))
        except queue.Full:
            self.dropped += 1

    def _drain(self) -> None:
        batches: dict[str, list] = {}
        while True:
            try:
                table, row = self.q.get_nowait()
            except queue.Empty:
                break
            batches.setdefault(table, []).append(row)
        for table, rows in batches.items():
            try:
                self.backend.insert(table, rows)
            except Exception as err:
                self.failures += 1
                self.last_error = f"{table}: {type(err).__name__}"
                log.warning("Could not save %d rows to %s: %s", len(rows), table, err)

    def _run(self) -> None:
        while not self.stop_flag.wait(1.0):
            self._drain()
        self._drain()

    def close(self) -> None:
        self.stop_flag.set()
        self.thread.join(timeout=10)
