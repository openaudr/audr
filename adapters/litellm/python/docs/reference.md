# Reference

Complete behaviour of `audr-adapter-litellm`. The
[README](https://github.com/openaudr/audr/blob/main/adapters/litellm/python/README.md)
covers setup and usage.

## Options

`LiteLLMAudrCallback` takes keyword arguments only.

| Argument | Default | Purpose |
| --- | --- | --- |
| `client` | required | The `audr.Client` that receives every record |
| `config` | `LiteLLMConfig()` | Attribution defaults and handoff bound |
| `loop` | the running loop | The event loop that owns `client`; pass it when constructing off that loop |

Construction raises `LiteLLMActivationError` when no running loop is available, and
importing `LiteLLMAudrCallback` raises it when the `runtime` extra is not installed.

`LiteLLMConfig` is a frozen Pydantic model.

| Field | Default | Purpose |
| --- | --- | --- |
| `attribution_defaults` | `Attribution()` | Values every record starts from; may be partial |
| `max_pending_handoffs` | `1000` | Records waiting to reach the client loop, 1 to 100000 |

An `attribution_defaults` value that can never be billed, such as a non-pseudonymous
`user_id`, raises `pydantic.ValidationError` at construction.

## Request metadata

Per-call values live under the reserved `metadata["audr"]` namespace. Each object rejects
unknown fields, and an invalid namespace skips the record with a warning naming only the
path.

| Key | Fields |
| --- | --- |
| `attribution` | Any `audr.Attribution` field: `environment`, `account_id`, `subscription_id`, `user_id`, `labels` |
| `run` | `run_id`, `span_id`, `parent_span_id`, `step`, `trace_id`, `run_type` |
| `resource` | `modality` (default `text`), `key_name`, `region`, `deployment` |

Request attribution wins over `attribution_defaults` field by field, and `labels` merge by
key, with the request's value winning for a key both set. A merged map above the
specification's 20-label limit skips the record.

## Records

### Resource

`resource.provider` is LiteLLM's provider for the call and `resource.name` is the model
the provider echoed in its response, falling back to the requested model. `resource.type`
is `model`.

### Tokens

- Chat and Responses API totals are split into uncached `input_tokens`,
  `cache_read_tokens` and `cache_write_tokens`. Reasoning tokens are removed from
  `output_tokens` and reported as `reasoning_tokens`.
- Rerank `meta.tokens` maps to input and output tokens. When only
  `meta.billed_units.total_tokens` is present it becomes `input_tokens`, and billed search
  units are kept as `usage.llm.x_<provider>_search_units`, for example
  `usage.llm.x_cohere_search_units`.
- A metered call carries `usage.llm.requests: 1`. A counter the provider did not report is
  omitted rather than zeroed.

### Cost

LiteLLM's `response_cost`, when present, becomes `cost.total_cost` with `cost.currency`
`USD`. It is a net amount that can include built-in tool fees, discounts and margins, so it
is not reported as `cost.llm.total_token_cost`.

### Run

Without `metadata["audr"]["run"]`, the LiteLLM trace or call identifier becomes
`run.run_id`, the call identifier becomes `run.span_id`, and `run.run_type` is
`single_call`. A failure that still reported usage or a positive cost carries one of these
`run.error_code` values; exception messages are never copied.

| `LiteLLMRunErrorCode` | `run.error_code` |
| --- | --- |
| `AUTHENTICATION` | `LITELLM_AUTHENTICATION` |
| `CONTENT_POLICY` | `LITELLM_CONTENT_POLICY` |
| `CONTEXT_WINDOW` | `LITELLM_CONTEXT_WINDOW` |
| `PROVIDER_ERROR` | `LITELLM_PROVIDER_ERROR` |
| `RATE_LIMIT` | `LITELLM_RATE_LIMIT` |
| `TIMEOUT` | `LITELLM_TIMEOUT` |

### Emitter

`emitter.name` is `audr-adapter-litellm` and `emitter.version` is this package's release.

## Not metered

- LiteLLM cache hits, since no provider call occurred.
- Failures without reported usage or a positive cost. LiteLLM sets `response_cost` to zero
  on failures, so a zero cost is not evidence of metering.
- Streams abandoned before LiteLLM assembled final usage. A stream is recorded once it is
  fully consumed.
- A failed `Router` attempt without usage; the fallback that reported usage is recorded.
- Tool executions. LiteLLM returns model-requested tool calls to the application; meter the
  component that runs the tool.

## Shutdown order

LiteLLM runs logging callbacks out of band and has no callback flush API, so shut down
after request work has finished:

1. Stop accepting new LiteLLM work.
2. Await every request task and fully consume active streams.
3. Let the matching logging tasks run. An application that knows how many metered calls
   it issued can watch `client.stats.submitted`; a server uses its graceful-shutdown window.
4. Unregister with `litellm.logging_callback_manager.remove_callback_from_all_lists(callback)`.
5. Await `callback.drain(timeout=...)` so accepted handoffs reach `client.record()`. It
   raises `TimeoutError` when they cannot arrive in time, and `LiteLLMActivationError`
   after `close()`.
6. Call `callback.close()`, then shut down the client so its queue and sink drain.

## Synchronous calls

LiteLLM may invoke callbacks for synchronous `completion()` calls on a worker thread. The
adapter hands those records back to the client's loop through a bounded, non-blocking
bridge, so run synchronous calls in a worker while that loop is running. A process with no
running event loop is not supported.

## Diagnostics

The adapter logs to the `audr_adapter_litellm._callback` logger through the standard
`logging` module. Messages carry JSON-pointer paths and queue outcomes; they never contain
a record value, a prompt or a credential.

| Message | Cause |
| --- | --- |
| `LiteLLM callback skipped (path=...)` | Attribution could not be resolved or failed validation |
| `LiteLLM callback malformed (path=...)` | `metadata["audr"]` or a LiteLLM field did not parse |
| `LiteLLM callback record dropped: handoff full` | `max_pending_handoffs` records were already waiting |
| `LiteLLM callback record dropped: event loop unavailable` | The client's loop had stopped |
| `LiteLLM callback submission dropped (outcome=...)` | `client.record()` did not queue the record |
| `LiteLLM callback ignored: adapter is closed` | An event arrived after `close()` |

Delivery outcomes after a record is queued belong to the client and its sink; inspect
`client.stats` and the client's delivery callbacks.

## Operational bounds

| Bound | Value |
| --- | --- |
| Records waiting to reach the client loop | `max_pending_handoffs`, default 1000; overflow drops with a warning |
| Labels per record after merging | 20, from the specification |

## Runtime support

Python 3.11 to 3.14 and `litellm` 1.95 or later within 1.x, through the `runtime` extra.
The LiteLLM Python SDK and `Router` are supported; the LiteLLM Proxy is not.
