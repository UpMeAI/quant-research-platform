"""Probe interface to the host's DeepSeek gateway (Q2). Unix socket only; the queue never reaches the network.
Assumed gateway endpoints (to confirm in Q2): GET /user/balance -> {"is_available": bool}; GET /status -> {"credential_fp": str|null}."""
import http.client
import json
import socket


class _UnixConn(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX)
        self.sock.settimeout(10)
        self.sock.connect(self.path)


class GatewayProbes:
    def __init__(self, sock_path, fetch=None):
        self.fetch = fetch or self._fetch
        self.sock_path = sock_path

    def _fetch(self, path):
        c = _UnixConn(self.sock_path)
        try:
            c.request("GET", path)
            r = c.getresponse()
            return r.status, json.loads(r.read() or b"{}")
        finally:
            c.close()

    def _get(self, path):
        try:
            st, body = self.fetch(path)
            return body if st == 200 else None
        except (OSError, ValueError, http.client.HTTPException):
            return None

    def balance_ok(self):
        b = self._get("/user/balance")
        return None if b is None else bool(b.get("is_available"))

    def credential_fingerprint(self, key_id):
        b = self._get("/status")
        return None if b is None else b.get("credential_fp")

    def provider_ok(self):
        return None if self._get("/user/balance") is None else True

    def external(self, code, task):
        return None
