# Record mapping

How completed Relay operations become AUDR records. Activating the plugin is documented
in [`README.md`](../README.md).

## LLM response codecs

Relay only emits provider-normalized token usage when the managed LLM call has a response
codec. Pass the matching codec to `nemo_relay.llm.execute`, for example
`nemo_relay.codecs.OpenAIChatCodec()`. An LLM end event without
`category_profile.annotated_response.usage` is skipped; the plugin derives usage from the
annotated response alone.

AUDR's `input_tokens` excludes cache reads and writes, while the meaning of Relay's
`prompt_tokens` depends on the codec. The plugin identifies the codec from
`annotated_response.api_specific.api`:

| Codec | Relay `prompt_tokens` | `input_tokens` |
| --- | --- | --- |
| `AnthropicMessagesCodec` (`anthropic_messages`) | Uncached input only, as Anthropic reports it | `prompt_tokens` unchanged |
| Every other codec | Inclusive prompt total | `prompt_tokens` minus `cache_read_tokens` and `cache_write_tokens` |

A custom codec is treated as reporting an inclusive total.

The billed model name is the provider-echoed `annotated_response.model`, as AUDR requires
(`resource.name` is the verbatim provider identifier), falling back to the `model_name` you
passed to `nemo_relay.llm.execute`. Providers version that echoed name — `gpt-4o` answering
as `gpt-4o-2024-08-06` — so aggregate across versions downstream rather than in the record.

The provider name is the Relay call name, lowercased and reduced to the `[a-z0-9-]`
alphabet AUDR requires, so a call named `My Provider_v2` meters as `my-provider-v2`.
Tool executions are client-executed, so they report the provider `self-hosted` and the
metering class `invocation`; the tool name is `resource.name`. LLM operations are billed
with `resource.operation="generation"` and `resource.modality="text"`.

## Record shape

Every completed operation becomes one `AUDR` record, with `record_id` minted fresh by
the SDK (Relay's scope UUIDs are not UUIDv7, the identifier shape AUDR's `record_id`
requires). The Relay scope UUID that ties related records together is carried on
`run.span_id` instead, and the Relay root scope UUID is `run.run_id`. The client applies
the normal AUDR validation before handing the record to your sink. The emitter is
`audr-adapter-nemo-relay` at this package's own release, with component `harness`, so a
mapping defect is attributed to the adapter version that produced it rather than to Relay.
`requests` and `call_count` are one per completed operation. `total_tokens`, raw payloads
and opaque results are never copied.

## Cost

An LLM record carries `cost.total_cost` and `cost.currency` only when Relay's
`annotated_response.usage.cost` has `source` `provider_reported`, the cost the provider
returned with the response.
