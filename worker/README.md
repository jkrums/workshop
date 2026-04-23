# Workshop remote worker

Ephemeral Docker image spawned by the `claude_remote` adapter as a Fly Machine.
Reads a prompt from env, runs `claude` non-interactively, exits. Auto-destroyed
on exit by the control plane.

## Deploy (image only — no always-on machine)

```
cd worker
flyctl deploy --app workshop-jkrums-workers --ha=false
flyctl scale count 0 --app workshop-jkrums-workers
```

## Env contract

See `shim.mjs` top comment. `claude_remote` sets these per-spawn via the Fly
Machines API — never bake secrets into the image.
