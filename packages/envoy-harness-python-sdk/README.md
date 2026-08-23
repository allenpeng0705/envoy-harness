# envoy-harness Python SDK

Minimal stdio JSON-RPC client for `envoy-harness --acp` hosts.

```python
from envoy_harness import EnvoyHarnessClient

client = EnvoyHarnessClient(sys.stdin.buffer, sys.stdout.buffer)
client.initialize()
sid = client.new_session(cwd="/path/to/project")
result = client.prompt(sid, "Hello")
```
