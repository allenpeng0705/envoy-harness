"""Minimal Python client for envoy-harness ACP/SDK JSON-RPC."""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


class EnvoyHarnessClient:
    """Line-delimited Content-Length JSON-RPC client (stdio)."""

    def __init__(self, stdin, stdout):
        self._in = stdin
        self._out = stdout
        self._next_id = 1

    def _write_frame(self, msg: dict) -> None:
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self._out.write(header)
        self._out.write(body)
        self._out.flush()

    def _read_frame(self) -> dict:
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._in.read(1)
            if not chunk:
                raise EOFError("connection closed")
            header += chunk
        length = int(header.split(b"Content-Length:")[1].split()[0])
        body = self._in.read(length)
        return json.loads(body.decode("utf-8"))

    def request(self, method: str, params: Optional[dict] = None) -> Any:
        id_ = self._next_id
        self._next_id += 1
        self._write_frame(
            {"jsonrpc": "2.0", "id": id_, "method": method, "params": params or {}}
        )
        while True:
            msg = self._read_frame()
            if msg.get("id") == id_:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result")

    def initialize(self) -> dict:
        return self.request("initialize", {})

    def new_session(self, cwd: Optional[str] = None) -> str:
        params: Dict[str, Any] = {}
        if cwd is not None:
            params["cwd"] = cwd
        return self.request("session/new", params)["sessionId"]

    def load_session(self, session_id: str, cwd: Optional[str] = None) -> str:
        params: Dict[str, Any] = {"sessionId": session_id}
        if cwd is not None:
            params["cwd"] = cwd
        return self.request("session/load", params)["sessionId"]

    def prompt(self, session_id: str, text: str) -> dict:
        return self.request(
            "session/prompt", {"sessionId": session_id, "text": text}
        )

    def prompt_with_images(
        self,
        session_id: str,
        content: List[dict],
    ) -> dict:
        return self.request(
            "session/prompt", {"sessionId": session_id, "content": content}
        )

    def cancel(self, session_id: str) -> None:
        self.request("session/cancel", {"sessionId": session_id})
