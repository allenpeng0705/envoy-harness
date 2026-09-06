# @envoymesh/envoy-sandbox-win

F2b Windows sandbox **sidecar** — newline JSON on stdin/stdout.

The harness spawns `envoy-sandbox-win` and sends one request per line:

```json
{"id":"1","method":"execute","params":{"command":"echo ok","cwd":"C:\\proj","policy":{...}}}
```

Response:

```json
{"id":"1","ok":true,"result":{"stdout":"ok\n","stderr":"","exitCode":0,"isError":false,"stdoutTruncated":false,"stderrTruncated":false,"fsIsolation":false}}
```

**F2b scaffold:** job-object lifecycle via `cmd.exe`; cwd validated against
`SandboxPolicy.writableRoots`. `fsIsolation: false` until the Rust
`windows-sandbox-rs` port lands (`fsIsolation: true`).

**R6.3 cancel:** send `{"id":"…","method":"cancel","params":{"id":"<execute-id>"}}`
to abort one in-flight execute without killing the sidecar process.

Set `ENVOY_SANDBOX_WIN_BIN` to override the sidecar executable.
