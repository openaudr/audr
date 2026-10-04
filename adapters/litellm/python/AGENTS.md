# AGENTS.md

Directives for working inside this package. Tier-wide directives are in
[`adapters/AGENTS.md`](../../AGENTS.md); repository setup, the shared Python toolchain and
the contribution process are in the top-level
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

## What this is

`adapters/litellm/python` is the `audr-adapter-litellm` distribution: a LiteLLM custom
callback that observes metered SDK and Router model calls and hands attributed `AUDR`
records to an `audr.Client` the host application owns. The host owns callback
registration, the client, its sink and their shutdown order.

## Working rules

1. Emit only when LiteLLM exposes provider usage or cost. Skip cache hits and unmetered
   failures; never infer billable usage from an attempted request.
2. Never inspect or copy prompts, completions, API keys or raw exception text. Logs and
   exceptions contain stable paths and outcomes only.
3. Construct the callback on the event loop that owns the client. LiteLLM may call it from
   worker threads, so every record crosses through the bounded bridge.
4. Shutdown order is stop requests, unregister the callback, `await callback.drain()`,
   `callback.close()`, then shut down the client.
5. The SDK mints `record_id`. LiteLLM identifiers belong on `run`; provider and model data
   belong on `resource`.
6. Keep sync and async LiteLLM callback methods behaviorally equivalent.
7. LiteLLM is the `runtime` extra. A plain `import audr_adapter_litellm` must not import
   LiteLLM; accessing `LiteLLMAudrCallback` is the activation boundary.

## Verification

Run `make verify` from this directory. The runtime suite uses LiteLLM's no-network mocks;
tests must not require provider credentials or make live model calls.
