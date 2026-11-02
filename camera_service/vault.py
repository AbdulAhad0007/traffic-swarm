"""Credentials at rest: encrypted with TSI_CAMERA_SECRET_KEY, in a file outside version control.

Environment variables always win, so a deployment can keep every secret in its own secret manager.
Nothing here is ever returned by the API; callers only learn whether a value is set.
"""
from __future__ import annotations
import json
import os
import re
import threading
from pathlib import Path


class VaultLocked(RuntimeError):
    pass


class Vault:
    def __init__(self, path: Path, key: str | None = None):
        self.path = Path(path)
        self.key = key if key is not None else os.environ.get("TSI_CAMERA_SECRET_KEY")
        self.lock = threading.Lock()

    def _fernet(self):
        from cryptography.fernet import Fernet
        return Fernet(self.key.encode())

    @property
    def writable(self) -> bool:
        if not self.key:
            return False
        try:
            self._fernet()
            return True
        except Exception:
            return False

    def _read(self) -> dict:
        if not self.path.is_file() or not self.writable:
            return {}
        try:
            return json.loads(self._fernet().decrypt(self.path.read_bytes()))
        except Exception:
            return {}

    def get(self, name: str) -> str | None:
        env = os.environ.get("TSI_CAMERA_" + re.sub(r"[^A-Z0-9]", "_", name.upper()))
        if env:
            return env
        with self.lock:
            return self._read().get(name)

    def has(self, name: str) -> bool:
        return bool(self.get(name))

    def set(self, name: str, value: str | None) -> None:
        if not self.writable:
            raise VaultLocked("Set TSI_CAMERA_SECRET_KEY on the camera service to store credentials, or provide them as environment variables.")
        with self.lock:
            data = self._read()
            if value:
                data[name] = value
            else:
                data.pop(name, None)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            tmp.write_bytes(self._fernet().encrypt(json.dumps(data).encode()))
            os.replace(tmp, self.path)
