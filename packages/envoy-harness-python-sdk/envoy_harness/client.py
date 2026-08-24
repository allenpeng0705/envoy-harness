"""Python client for envoy-harness ACP/SDK JSON-RPC (stdio)."""

from __future__ import annotations

import json
import queue
import threading
from typing import Any, Callable, Dict, List, Literal, Optional, Union

PermissionDecision = Union[Literal["allow", "deny"], str]
PermissionHandler = Callable[[Dict[str, Any]], PermissionDecision]
NotificationHandler = Callable[[Any], None]
EventHandler = Callable[[Dict[str, Any]], None]


class EnvoyHarnessClient:
    """Content-Length JSON-RPC client with notification + permission support."""

    def __init__(
        self,
        stdin,
        stdout,
        on_permission_request: Optional[PermissionHandler] = None,
        on_event: Optional[EventHandler] = None,
    ):
        self._in = stdin
        self._out = stdout
        self._next_id = 1
        self._pending: Dict[int, queue.Queue] = {}
        self._notification_handlers: Dict[str, List[NotificationHandler]] = {}
        self._on_permission_request = on_permission_request
        self._on_event = on_event
        self._dialect: Optional[str] = None
        self._closed = False
        self._write_lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _write_frame(self, msg: dict) -> None:
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        with self._write_lock:
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

    def _handle_notification(self, method: str, params: Any) -> None:
        handlers = self._notification_handlers.get(method)
        if handlers is not None:
            for handler in list(handlers):
                handler(params)
        if method == "session/update" and self._on_event is not None:
            self._on_event({"dialect": "acp", "params": params})
        elif method == "session/event" and self._on_event is not None:
            self._on_event({"dialect": "sdk", "params": params})

    def _handle_server_request(self, msg: dict) -> None:
        method = msg.get("method")
        params = msg.get("params", {})
        id_ = msg.get("id")
        try:
            if method == "session/request_permission":
                decision = "deny"
                if self._on_permission_request is not None:
                    decision = self._on_permission_request(params)
                result = {"decision": decision}
            else:
                raise RuntimeError(f"unexpected server request: {method}")
            self._write_frame({"jsonrpc": "2.0", "id": id_, "result": result})
        except Exception as err:  # noqa: BLE001 — mirror TS client surface
            self._write_frame(
                {
                    "jsonrpc": "2.0",
                    "id": id_,
                    "error": {"code": -32000, "message": str(err)},
                }
            )

    def _read_loop(self) -> None:
        while not self._closed:
            try:
                msg = self._read_frame()
            except EOFError:
                break
            except Exception:
                continue
            if "method" in msg and "id" in msg:
                self._handle_server_request(msg)
                continue
            if "method" in msg:
                self._handle_notification(msg["method"], msg.get("params"))
                continue
            id_ = msg.get("id")
            if id_ is not None:
                pending = self._pending.get(id_)
                if pending is not None:
                    pending.put(msg)

    def on_notification(
        self, method: str, handler: NotificationHandler
    ) -> Callable[[], None]:
        """Register a notification handler; returns unsubscribe."""

        handlers = self._notification_handlers.setdefault(method, [])
        handlers.append(handler)

        def unsubscribe() -> None:
            handlers.remove(handler)
            if not handlers:
                self._notification_handlers.pop(method, None)

        return unsubscribe

    def request(
        self, method: str, params: Optional[dict] = None, timeout: float = 30.0
    ) -> Any:
        with self._write_lock:
            id_ = self._next_id
            self._next_id += 1
        pending: queue.Queue = queue.Queue()
        self._pending[id_] = pending
        self._write_frame(
            {
                "jsonrpc": "2.0",
                "id": id_,
                "method": method,
                "params": params or {},
            }
        )
        try:
            msg = pending.get(timeout=timeout)
        finally:
            self._pending.pop(id_, None)
        if "error" in msg:
            raise RuntimeError(msg["error"])
        return msg.get("result")

    def initialize(self) -> dict:
        self._dialect = "acp"
        return self.request("initialize", {})

    def new_session(self, cwd: Optional[str] = None) -> str:
        self._dialect = "acp"
        params: Dict[str, Any] = {}
        if cwd is not None:
            params["cwd"] = cwd
        return self.request("session/new", params)["sessionId"]

    def create_session(self, cwd: Optional[str] = None) -> str:
        self._dialect = "sdk"
        params: Dict[str, Any] = {}
        if cwd is not None:
            params["cwd"] = cwd
        return self.request("session/create", params)["sessionId"]

    def load_session(self, session_id: str, cwd: Optional[str] = None) -> str:
        self._dialect = "acp"
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

    def list_tools(self) -> List[dict]:
        return self.request("tools/list", {})["tools"]

    def get_config(self) -> dict:
        return self.request("config/get", {})

    def list_peers(self) -> List[dict]:
        return self.request("peers/list", {})["peers"]

    def cluster_status(self) -> dict:
        return self.request("cluster/status", {})["cluster"]

    def team_jobs(self) -> List[dict]:
        return self.request("team/jobs", {})["jobs"]

    def scoreboard_summary(self) -> List[dict]:
        return self.request("scoreboard/summary", {})["entries"]

    def subscribe_discovery(self, listener: NotificationHandler) -> Callable[[], None]:
        remove = self.on_notification("discovery/event", lambda params: listener(
            (params or {}).get("event")
        ))
        try:
            subscribed = self.request("discovery/subscribe", {})["subscribed"]
            if not subscribed:
                remove()
                raise RuntimeError("discovery/subscribe not supported by this host")
            return remove
        except Exception:
            remove()
            raise

    def route_peer(
        self, capability_tag: str, preferred_peer_id: Optional[str] = None
    ) -> Optional[dict]:
        params: Dict[str, Any] = {"capabilityTag": capability_tag}
        if preferred_peer_id is not None:
            params["preferredPeerId"] = preferred_peer_id
        peer = self.request("cluster/route", params).get("peer")
        return peer if peer is not None else None

    def connect_cluster_peer(
        self,
        id: str,
        endpoint: str,
        model: Optional[str] = None,
        capabilities: Optional[List[str]] = None,
    ) -> dict:
        params: Dict[str, Any] = {"id": id, "endpoint": endpoint}
        if model is not None:
            params["model"] = model
        if capabilities is not None:
            params["capabilities"] = capabilities
        return self.request("cluster/connect", params)

    def compact_session(
        self,
        session_id: str,
        keep: Optional[int] = None,
        budget: Optional[int] = None,
        summarize: bool = False,
    ) -> dict:
        params: Dict[str, Any] = {"sessionId": session_id}
        if keep is not None:
            params["keep"] = keep
        if budget is not None:
            params["budget"] = budget
        if summarize:
            params["summarize"] = True
        return self.request("session/compact", params)["result"]

    def set_session_model(
        self, session_id: str, provider: str, model: Optional[str] = None
    ) -> dict:
        params: Dict[str, Any] = {"sessionId": session_id, "provider": provider}
        if model is not None:
            params["model"] = model
        return self.request("session/set_model", params)["result"]

    def set_session_policy(
        self,
        session_id: str,
        sandbox: Optional[str] = None,
        approval: Optional[str] = None,
    ) -> dict:
        params: Dict[str, Any] = {"sessionId": session_id}
        if sandbox is not None:
            params["sandbox"] = sandbox
        if approval is not None:
            params["approval"] = approval
        return self.request("session/set_policy", params)["result"]

    def git_diff(
        self,
        session_id: str,
        staged: bool = False,
        stat: bool = False,
    ) -> str:
        params: Dict[str, Any] = {"sessionId": session_id}
        if staged:
            params["staged"] = True
        if stat:
            params["stat"] = True
        return self.request("git/diff", params)["output"]

    def git_status(self, session_id: str) -> str:
        return self.request("git/status", {"sessionId": session_id})["output"]

    def get_session_context(self, session_id: str) -> dict:
        return self.request("session/context", {"sessionId": session_id})

    def list_session_hooks(self, session_id: str) -> List[dict]:
        return self.request("session/hooks", {"sessionId": session_id})["hooks"]

    def list_session_mcp(self, session_id: str) -> List[str]:
        return self.request("session/mcp", {"sessionId": session_id})["servers"]

    def list_session_agents(self, session_id: str) -> str:
        return self.request("session/agents", {"sessionId": session_id})["output"]

    def session_plan(
        self,
        session_id: str,
        action: str,
        text: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> str:
        params: Dict[str, Any] = {"sessionId": session_id, "action": action}
        if text is not None:
            params["text"] = text
        if reason is not None:
            params["reason"] = reason
        return self.request("session/plan", params)["output"]

    def session_memory(
        self,
        session_id: str,
        op: str,
        name: Optional[str] = None,
        body: Optional[str] = None,
    ) -> str:
        params: Dict[str, Any] = {"sessionId": session_id, "op": op}
        if name is not None:
            params["name"] = name
        if body is not None:
            params["body"] = body
        return self.request("session/memory", params)["output"]

    def session_review(self, session_id: str, staged: bool = False) -> str:
        params: Dict[str, Any] = {"sessionId": session_id}
        if staged:
            params["staged"] = True
        return self.request("session/review", params)["output"]

    def session_init(self, session_id: str) -> str:
        return self.request("session/init", {"sessionId": session_id})["output"]

    @property
    def dialect(self) -> Optional[str]:
        return self._dialect

    def close(self) -> None:
        self._closed = True
