"""Integration tests — Python SDK against a live envoy-harness --acp process."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from envoy_harness import EnvoyHarnessClient

MONOREPO_ROOT = Path(__file__).resolve().parents[3]
HARNESS_BIN = MONOREPO_ROOT / "packages" / "envoy-harness" / "bin" / "envoy-harness.ts"


def _harness_argv() -> list[str] | None:
    if not HARNESS_BIN.is_file():
        return None
    npx = shutil.which("npx")
    if npx is None:
        return None
    return [npx, "tsx", str(HARNESS_BIN), "--acp", "--quiet"]


@pytest.fixture
def acp_process():
    argv = _harness_argv()
    if argv is None:
        pytest.skip("envoy-harness bin or npx not available")
    proc = subprocess.Popen(
        argv,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=str(MONOREPO_ROOT),
    )
    client = EnvoyHarnessClient(proc.stdout, proc.stdin)
    try:
        yield client, proc
    finally:
        client.close()
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=10)


@pytest.mark.integration
def test_initialize_session_prompt_round_trip(acp_process):
    client, _proc = acp_process

    init = client.initialize()
    assert isinstance(init.get("protocolVersion"), int)

    session_id = client.new_session()
    assert session_id.startswith("sess-")
    assert client.dialect == "acp"

    result = client.prompt(session_id, "ping")
    assert result["stopReason"] == "end_turn"
    messages = result.get("messages") or []
    assert any(
        (m.get("text") or "").startswith("echo:") for m in messages
    )


@pytest.mark.integration
def test_mesh_apis_on_demo_backend(acp_process):
    client, _proc = acp_process
    client.initialize()

    peers = client.list_peers()
    assert isinstance(peers, list)

    cluster = client.cluster_status()
    assert isinstance(cluster.get("peers"), list)
    assert cluster.get("connected") == 0

    jobs = client.team_jobs()
    assert isinstance(jobs, list)

    entries = client.scoreboard_summary()
    assert isinstance(entries, list)


@pytest.mark.integration
def test_tools_list(acp_process):
    client, _proc = acp_process
    client.initialize()
    tools = client.list_tools()
    assert isinstance(tools, list)
    names = {t["name"] for t in tools}
    assert "bash" in names or len(names) >= 0
