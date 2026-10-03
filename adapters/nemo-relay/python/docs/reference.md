# Reference

Complete behaviour of `audr-adapter-nemo-relay`. The
[README](https://github.com/openaudr/audr/blob/main/adapters/nemo-relay/python/README.md)
covers setup and usage.

## Options

`NeMoRelayPlugin` takes keyword arguments only.

| Argument | Default | Purpose |
| --- | --- | --- |
| `client` | required | The `audr.Client` that receives every record |
| `loop` | the running loop | The event loop that owns `client`; it must be running when Relay activates the component |

Relay runs plugin registration and subscriber callbacks on its own worker threads, so the
plugin captures the client's loop at construction and hands records back to it.

`NeMoRelayConfig` is the component configuration, passed to Relay with `to_dict()`.

| Field | Default | Purpose |
| --- | --- | --- |
| `attribution_defaults` | `Attribution()` | Values every root scope starts from; may be partial |
| `max_pending_handoffs` | `1000` | Records waiting to reach the client loop, 1 to 100000 |
| `max_tracked_scopes` | `10000` | Incomplete scopes tracked at once, 1 to 1000000 |

Constructing `NeMoRelayConfig` with an invalid value raises `pydantic.ValidationError`.
Configuration arriving from Relay is reported through `plugin.validate(...)` as Relay
diagnostics instead.

## Attribution

- A root scope's **start** metadata under `audr` wins over `attribution_defaults` field by
  field, and `labels` merge by key, with the scope's value winning for a key both set.
  Metadata on a completing scope is ignored, so a child cannot re-bill work its root
  already claimed.
- Child scopes inherit the snapshot taken at their parent's start.
- Relay never emits the outermost scope's own parent. A scope whose parent the plugin has
  never observed is a new billing root, and `attribution_defaults` apply.
- A scope whose parent the plugin observed and then lost, an evicted or already completed
  ancestor, is skipped instead of falling back to defaults, unless its own start declares
  the `audr` namespace. Static defaults could otherwise bill the wrong subscription.
- To require per-scope attribution, omit `environment` from `attribution_defaults`. Scopes
  that carry no `environment` then resolve incomplete and are skipped.
- A merged map above the specification's 20-label limit skips the record.

`subscription_id` is not required by this adapter or by AUDR. A destination that routes on
it, such as the Chargebee sink, rejects records without one.

## Records

### LLM calls

Relay emits normalized token usage only when the managed call has a response codec. Pass
the matching codec to `nemo_relay.llm.execute`, for example
`nemo_relay.codecs.OpenAIChatCodec()`. An LLM end event without
`category_profile.annotated_response.usage` is skipped.

AUDR's `input_tokens` excludes cache reads and writes, while the meaning of Relay's
`prompt_tokens` depends on the codec, identified from
`annotated_response.api_specific.api`:

| Codec | Relay `prompt_tokens` | `input_tokens` |
| --- | --- | --- |
| `AnthropicMessagesCodec` (`anthropic_messages`) | Uncached input only, as Anthropic reports it | `prompt_tokens` unchanged |
| Every other codec, including a custom one | Inclusive prompt total | `prompt_tokens` minus `cache_read_tokens` and `cache_write_tokens` |

`resource.name` is the provider-echoed `annotated_response.model`, falling back to the
`model_name` passed to `nemo_relay.llm.execute`. Providers version the echoed name, such as
`gpt-4o` answering as `gpt-4o-2024-08-06`, so aggregate across versions downstream.
`resource.provider` is the Relay call name, lowercased and reduced to `[a-z0-9-]`, so a
call named `My Provider_v2` meters as `my-provider-v2`. LLM records carry
`resource.operation` `generation` and `resource.modality` `text`.

`cost.total_cost` and `cost.currency` are set only when
`annotated_response.usage.cost.source` is `provider_reported`.

### Tool executions

Tools are client-executed, so a tool record carries `resource.provider` `self-hosted`,
`resource.type` `tool`, the tool name as `resource.name`, and
`usage.tool: { type: 'invocation', call_count: 1 }`. A failed tool execution carries
`run.error_code` `NEMO_RELAY_TOOL_ERROR`.

### Identifiers

`record_id` is minted by the SDK, because Relay scope UUIDs are not UUIDv7. The Relay
scope UUID is `run.span_id` and the Relay root scope UUID is `run.run_id`. The emitter is
`audr-adapter-nemo-relay` at this package's release, with component `harness`.
`requests` and `call_count` are one per completed operation; `total_tokens`, raw payloads
and tool results are never copied.

## Errors

| Error | Raised when |
| --- | --- |
| `NeMoRelayCompatibilityError` (a `ConfigurationError`) | The `nemo-relay` distribution is missing or outside 0.8.x |
| `ConfigurationError` | Relay activated the component with configuration this plugin rejects |
| `NeMoRelayActivationError` (a `LifecycleError`) | No running loop, a second activation, or `drain()` after `close()` |
| `TimeoutError` | `drain(timeout=...)` could not complete its handoffs in time |

A `register()` that raises leaves the instance unregistered, because Relay rolls back
every registration from that initialization.

`plugin.validate(...)` returns Relay `ConfigDiagnostic` values, each with a
`NeMoRelayDiagnosticCode`:

| Code | Meaning |
| --- | --- |
| `audr.invalid_attribution` | `attribution_defaults` is not an attribution object |
| `audr.invalid_attribution_field` | `attribution_defaults` has an unknown field |
| `audr.invalid_attribution_value` | An attribution default is invalid or can never be billed, such as a non-pseudonymous `user_id` |
| `audr.invalid_bound` | `max_pending_handoffs` or `max_tracked_scopes` is out of range |
| `audr.unknown_field` | The component configuration has an unknown key |
| `audr.unsupported_relay_version` | The installed `nemo-relay` is outside 0.8.x |

## Diagnostics

The plugin logs to the `audr_adapter_nemo_relay._plugin` logger through the standard
`logging` module. Messages carry Relay event identifiers, JSON-pointer paths, counts and
queue outcomes; they never contain an event value. Unexpected failures are logged with a
traceback.

| Message | Cause |
| --- | --- |
| `NeMo Relay event skipped (event_id=..., path=...)` | Attribution or usage could not be resolved |
| `NeMo Relay event malformed (event_id=..., path=...)` | A Relay event field did not parse |
| `NeMo Relay scope state evicted (event_id=..., count=...)` | `max_tracked_scopes` was reached |
| `NeMo Relay event dropped: handoff full (event_id=...)` | `max_pending_handoffs` records were already waiting |
| `NeMo Relay event dropped: event loop unavailable (event_id=...)` | The client's loop had stopped |
| `NeMo Relay submission dropped (event_id=..., outcome=...)` | `client.record()` did not queue the record |
| `NeMo Relay event ignored: plugin is not active (event_id=...)` | An event arrived outside an activation |

Delivery totals belong to the client: inspect `client.stats`.

## Operational bounds

| Bound | Value |
| --- | --- |
| Records waiting to reach the client loop | `max_pending_handoffs`, default 1000; overflow drops with a warning |
| Incomplete scopes tracked | `max_tracked_scopes`, default 10000; overflow evicts the oldest with a warning |
| Activations per plugin instance | 1 |
| Labels per record after merging | 20, from the specification |

## Runtime support

Python 3.11 to 3.14 and `nemo-relay` 0.8 within 0.8.x, through the `runtime` extra.
