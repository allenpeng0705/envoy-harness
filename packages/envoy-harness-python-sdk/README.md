# envoy-harness Python SDK

Stdio JSON-RPC client for `envoy-harness --acp` hosts, aligned with `@envoymesh/envoy-harness-client`.

## Features

- ACP + SDK session methods (`initialize`, `session/new`, `session/prompt`, …)
- Streaming notifications (`session/update`, `session/token`, `session/activity`, `discovery/event`)
- Server-initiated permission prompts (`session/request_permission`)
- Mesh / cluster APIs (`peers/list`, `cluster/status`, `cluster/connect`, `cluster/route`, `discovery/subscribe`, `team/jobs`, `scoreboard/summary`)

## Example

```python
import subprocess
import sys
from envoy_harness import EnvoyHarnessClient

proc = subprocess.Popen(
    ["envoy-harness", "--acp"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

client = EnvoyHarnessClient(
    proc.stdout,
    proc.stdin,
    on_permission_request=lambda req: "allow",
    on_event=lambda ev: print("event", ev),
)

client.initialize()
sid = client.new_session(cwd="/path/to/project")

client.on_notification("session/update", lambda p: print("update", p))
result = client.prompt(sid, "Hello")
print(result["stopReason"], result.get("messages"))

peers = client.list_peers()
status = client.cluster_status()
client.close()
proc.kill()
```

## Tests

From `packages/envoy-harness-python-sdk` (requires Python 3.10+, `npx`, and monorepo Node deps):

```bash
# with uv (recommended)
uv run --with pytest pytest tests -m integration

# or pip (editable install)
pip install -e ".[dev]"
pytest tests -m integration
```

Integration tests spawn `envoy-harness --acp --quiet` (demo backend) and exercise the stdio client.

## Install (local monorepo)

```bash
pip install -e packages/envoy-harness-python-sdk
```
