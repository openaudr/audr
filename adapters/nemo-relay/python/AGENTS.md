# AGENTS.md

Guidance for working in this package. Rules for every adapter are in
[`adapters/AGENTS.md`](../../AGENTS.md). Setup, the shared Python toolchain and the
contribution process are in the top-level [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).
To integrate this adapter into an application, see [`README.md`](README.md); this file
covers changes to the package itself.

## What this is

`adapters/nemo-relay/python` is the `audr-adapter-nemo-relay` distribution: an in-process
NVIDIA NeMo Relay plugin that observes completed Relay LLM and tool scopes and hands
attributed `AUDR` records to an `audr.Client` the host application owns.

Update [`docs/reference.md`](docs/reference.md) when public behaviour changes.
`make examples` runs `examples/agent_scope.py` with canned results.
`examples/nemo_relay_chat.py` makes billable network calls and must not run in CI.

## Rules

1. Accept one component activation per `NeMoRelayPlugin` instance. A second would install
   a second subscriber on the same process-wide event stream and double-count.
2. Capture the client's running event loop at construction, or take `loop=`. Relay fires
   callbacks on its own worker threads, so every record crosses to the loop through
   `_bridge.py`. Bound the handoff with `max_pending_handoffs` and drop with a warning on
   overflow; never block Relay.
3. Keep the shutdown order: stop producing, exit Relay's plugin context, `await drain()`,
   then `await client.shutdown()`. `drain()` after `close()` raises rather than discarding
   handoffs. Only `deregister` belongs in `finally`.
4. Resolve attribution from the **root** scope's `audr` metadata at scope start, then
   `attribution_defaults`. Skip a scope whose observed ancestor was evicted or completed
   rather than falling back to defaults, which could bill the wrong subscription. Ignore
   metadata on a completing scope.
5. Put Relay's scope UUID on `run.span_id` and the root scope UUID on `run.run_id`. Never
   copy `total_tokens` or raw payloads. `input_tokens` excludes cache reads and writes.
   Copy only `cost.total_cost` and `cost.currency`, and only when Relay's cost `source` is
   `provider_reported`.
6. Add a `NeMoRelayDiagnosticCode` or `NeMoRelayRunErrorCode` for every new diagnostic. Do
   not log free text. Warnings carry event IDs, field paths, counts and queue outcomes,
   never scope metadata values.

## Toolchain

The shared toolchain is defined in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md#shared-python-toolchain). Specific to this
package:

- **Runtime deps:** `audr`, `pydantic`. **Extras:** `runtime` (`nemo-relay>=0.8,<0.9`),
  `example` (the runtime plus `httpx`, for `examples/`). `nemo_relay` is imported at
  activation; importing this package must not import it.
- **Version:** `src/audr_adapter_nemo_relay/_version.py`.
- **Tests:** `pyproject.toml` sets `addopts = "-m 'not nemo_relay'"`, so `make test`
  deselects every test that needs the installed runtime. To run them:

  ```bash
  uv sync --locked --group dev --extra runtime
  uv run pytest -m nemo_relay
  ```

`make verify` runs lint, tests, offline examples and wheel isolation checks.
`make isolation` verifies installation with and without the runtime extra.
