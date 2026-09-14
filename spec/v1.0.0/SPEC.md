<!-- GENERATED FILE -- field semantics are derived from audr.schema.json. -->

# Agent Usage Detail Record (AUDR)

**Technical Specification · Version 1.0.0**

A JSON record format for agent cost monitoring and monetization.

## Attribution

This document is a technical specification of the Agent Usage Detail Record
v1.0.0 JSON Schema. Its field semantics, constraints, and requirement language
are derived from the AUDR schema.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**,
**RECOMMENDED**, **MAY**, and **OPTIONAL** indicate requirement levels as
described by [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## 1. Introduction

### 1.1 Scope

This specification defines the Agent Usage Detail Record (AUDR), a JSON object
that describes one metered operation in an agent system. A record identifies its
emitter and resource, reports raw model or tool usage, associates the operation
with a run, and carries attribution required for downstream cost allocation. A
record MAY include an informational cost assertion.

### 1.2 Architecture

A typical AUDR-enabled agent workflow has five logical components:

1. **Agent Harness**: Runs the agent and performs tasks by requesting model
   operations and invoking tools. It manages sessions, tool execution and
   supplies run hierarchy.
2. **Router / AI Gateway**: Selects a model and provider through a normalized
   provider interface, forwards each operation, and captures resource and usage
   data.
3. **Provider**: Executes the model operation or provider-hosted tool and returns
   the result with native usage and cost observations when available.
4. **Sink**: The ingest layer that receives emitted usage records, then
   validates, deduplicates, merges, and stores them.
5. **Rating**: The downstream calculation of a billable amount from raw usage and
   billing configuration.

The application invokes the agent harness. Each metered operation passes from the
agent harness through the router role to the provider; roles MAY be co-located,
participating components MAY emit independent AUDR records, and the sink
assembles records that share a `run.run_id` and `run.span_id`. Rating consumes
stored records and is out of scope for this specification.

### 1.3 Out of Scope

- Rated customer amounts, invoice generation, and revenue recognition.
- Sink operational policies such as orphan wait duration and merge timing.
- Provider registry contents beyond the `resource.provider` slug convention.
- Agent internal state records and observability event formats.

### 1.4 Record Processing Model

Multiple components MAY describe the same metered operation or agentic run. A
sink assembles those observations using the pair `run.run_id` and `run.span_id`.
Each emitted record has an independent `record_id` for deduplication and
correction processing. Downstream rating components MAY use or ignore the
asserted `cost` object according to its own billing configuration.

**Schema ID**: `https://openaudr.dev/spec/v1.0.0/audr.schema.json`

**Root type**: JSON object

**Schema dialect**: `https://json-schema.org/draft/2020-12/schema`

**Version pattern**: `^1\.0\.\d+$`

## 2. Definitions

**Emitter**: The component that wrote the record, identified by
`emitter.component`.

**Harness**: The agent runtime or orchestration layer that runs the agent loop.
It builds prompts, calls the model, executes tools, returns the results, and
manages session state, context, and tool permissions.

**Merge key**: The pair `(run.run_id, run.span_id)`. It groups records from
different emitters that describe the same metered operation.

**Metered operation**: One model operation, tool execution, or retrieval
identified by a unique `run_id` and `span_id` pair.

**Provider**: The vendor or platform that serves the model or executes the
metered tool.

**Rating**: The downstream calculation of a billable amount from raw usage and
billing configuration.

**Record**: One emitted AUDR JSON object with its own `record_id`.

**Router / AI Gateway**: The layer that routes model requests to providers. This
provides a unified interface for agent harness to invoke multiple provider
models. The router tracks token consumption and optionally has a fallback
mechanism for optimizing model calls or during outages.

**SDK**: The client library role responsible for record construction fields such
as `spec_version` and `record_id`.

**Sink**: The ingest layer that validates, deduplicates, merges, and stores the
usage records. It is distinct from Rating in that Sink is responsible only for
validating and storing records, not for calculating a billable amount.

**Tools**: External capabilities invoked by an agent harness. Each request to one
of these capabilities is a tool invocation. Examples include web search, code
execution, file access, retrieval, database queries, and API calls.

## 3 Specification

## 3.1 Format

An AUDR record is represented as a JSON object. Property names are
case-sensitive. Objects use fixed fields unless a patterned `x_*` extension is
explicitly defined. All other additional properties are invalid.

## 3.2 Conformance

A conformant record MUST contain all top-level required properties and MUST
satisfy the cross-field operation constraints in [section 3.13](#313-cross-field-operation-constraints).

## 3.3 Validation Boundaries

JSON Schema validation does not enforce every AUDR invariant. Conformant sinks
are responsible for the following requirements:

- A record missing `attribution.environment` MUST be ignored and MUST NOT be
  rated.
- Sinks MUST apply `record_id` deduplication and correction replacement.
- Unknown `x_*` extension counters MUST be accepted, not rejected.
- Each block has one writer for a given `run_id` and `span_id` merge key.
- Rating components MAY check cost-component consistency without overwriting
  `cost.total_cost`.
- A merge key MUST identify one metered operation.
- A correction MUST use the same `emitter.component` as the corrected record.

## 3.4 AUDR Record Object

This is the root document object for the AUDR specification.

### 3.4.1 JSON Example

```json
{
  "spec_version": "1.0.0",
  "record_id": "01K4N8D2J4P7Q9R3S6T8V1W5XY",
  "emitter": {
    "component": "router",
    "name": "@audr/openrouter",
    "version": "0.5.1"
  },
  "timing": {
    "event_time": "2026-09-08T12:00:00.000Z"
  },
  "resource": {
    "provider": "anthropic",
    "type": "model",
    "name": "claude-sonnet-4-20250514",
    "operation": "generation",
    "modality": "text"
  },
  "run": {
    "run_id": "01K4N8B0M2C5F7H9J1L3N6P8QR",
    "name": "Resolve Acme support request",
    "span_id": "model-call-1",
    "run_type": "agent_run"
  },
  "attribution": {
    "environment": "production",
    "account_id": "account-42",
    "user_id": "user-7"
  },
  "usage": {
    "llm": {
      "input_tokens": 1200,
      "output_tokens": 300
    }
  }
}
```

### 3.4.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `spec_version` | string (pattern) | Required | AUDR schema version, constrained here to 1.0.x. Consumers MUST reject unsupported major versions. |
| `record_id` | string (8–64 chars) | Required | ULID or UUIDv7 idempotency key, unique to each emitted record rather than each logical event. Records from different components use distinct IDs and are merged, not deduplicated. |
| `emitter` | Emitter Object | Required | Identifies the software component that wrote the record. |
| `corrects` | string (8–64 chars) | Optional | Identifies one earlier record fully restated by this correction. The correction MUST contain full state, use a fresh record_id, and come from the same emitter.component; all-zero usage represents a void. |
| `timing` | Timing Object | Required | Event completion, ingest, and duration observations. |
| `resource` | Resource Object | Required | Identifies the consumed model or tool. Model operations require type=model; tool_execution and retrieval require type=tool. |
| `run` | Run Object | Required | Groups metered operations into a task and span hierarchy. Spawned agents reuse run_id, parent_span_id links within that run, and a harness outcome closes the run. |
| `attribution` | Attribution Object | Required | Carries billability and allocation dimensions. Emitters MUST supply environment; sinks ignore records missing it, and production records require account_id. |
| `usage` | Usage Object | Required | Raw, non-monetary counters with exactly one non-empty llm or tool block selected by resource.operation. An absent counter means unreported or inapplicable; zero means measured as zero and MUST NOT be inferred from absence. |
| `cost` | Cost Object | Optional | Provider- or router-asserted cost that rating MAY use or ignore according to its billing configuration. Components are gross, total_cost is net, and the single cost sub-block must match usage; rating MAY check consistency but MUST NOT overwrite the total. |

## 3.5 Record Identity

The REQUIRED `spec_version` and `record_id` properties declare schema version
and record identity. The OPTIONAL `corrects` property identifies the earlier
record fully restated by a correction.

### 3.5.1 JSON Example

```json
{"spec_version": "1.0.0", "record_id": "01K4N8D2J4P7Q9R3S6T8V1W5XY"}
```

### 3.5.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `spec_version` | string (pattern) | Required | AUDR schema version, constrained here to 1.0.x. Consumers MUST reject unsupported major versions. |
| `record_id` | string (8–64 chars) | Required | ULID or UUIDv7 idempotency key, unique to each emitted record rather than each logical event. Records from different components use distinct IDs and are merged, not deduplicated. |
| `corrects` | string (8–64 chars) | Optional | Identifies one earlier record fully restated by this correction. The correction MUST contain full state, use a fresh record_id, and come from the same emitter.component; all-zero usage represents a void. |

## 3.6 `emitter` Object

The REQUIRED `emitter` object identifies the software component that wrote the
record.

### 3.6.1 JSON Example

```json
{"component": "router", "name": "@audr/openrouter", "version": "0.5.1"}
```

### 3.6.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `emitter.component` | enum (`harness`, `router`, `provider`) | Required | Component that wrote the record. This field identifies the caller that metered tool usage and cost. |
| `emitter.name` | string (min 1 chars) | Required | Package identifier for the emitter. |
| `emitter.version` | string (min 1 chars) | Required | Emitter release used to attribute data-quality issues. |

## 3.7 `timing` Object

The REQUIRED `timing` object records event completion and optional ingest and
duration observations.

### 3.7.1 JSON Example

```json
{"event_time": "2026-09-08T12:00:00.000Z", "duration_ms": 842}
```

### 3.7.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `timing.event_time` | string (pattern) | Required | Event invocation time in [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) format with millisecond precision; for streams, use stream termination. |
| `timing.received_time` | string (pattern) | Optional | Ingest time in [RFC 3339](https://www.rfc-editor.org/rfc/rfc3339) format with millisecond precision. Set by the sink. |
| `timing.duration_ms` | integer ≥ 0 | Optional | Event execution duration in milliseconds. |

## 3.8 `resource` Object

The REQUIRED `resource` object identifies the consumed model or tool and the
operation performed.

### 3.8.1 JSON Example

```json
{
  "provider": "anthropic",
  "type": "model",
  "name": "claude-sonnet-4-20250514",
  "operation": "generation",
  "region": "us-east-1",
  "deployment": "AWS"
}
```

### 3.8.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `resource.provider` | string (pattern) | Required | Canonical lowercase provider slug. For tool operations, identify the executing vendor or platform; use self-hosted for locally run tools. |
| `resource.type` | enum (`model`, `tool`) | Required | Named resource kind: model for model operations or tool for tool_execution and retrieval. resource.operation selects the usage block. |
| `resource.name` | string (min 1 chars) | Required | Verbatim provider model identifier for models, or stable logical tool/backend identifier for tools. Do not normalize model names or use URLs and versioned function symbols for tools. |
| `resource.operation` | enum (`generation`, `embedding`, `reranking`, `tool_execution`, `retrieval`) | Required | Operation class that selects resource.type and usage: model operations use model with usage.llm; tool_execution and retrieval use tool with usage.tool. |
| `resource.modality` | enum (`text`, `image`, `audio`, `multimodal`) | Conditional | The modality of the task or operation. This field is required when resource.type is model. |
| `resource.key_name` | string | Optional | Credential label from the gateway registry. It MUST contain no key material, prefix, hash, or other secret substring. |
| `resource.region` | string | Optional | Region affecting price and data residency. |
| `resource.deployment` | string (min 1 chars) | Optional | Open-vocabulary deployment platform or environment, such as AWS, GCP, Azure, or self-hosted. |

## 3.9 `run` Object

The REQUIRED `run` object associates one metered operation with a run and span
hierarchy.

### 3.9.1 JSON Example

```json
{
  "run_id": "01K4N8B0M2C5F7H9J1L3N6P8QR",
  "name": "Resolve Acme support request",
  "span_id": "tool-call-2",
  "parent_span_id": "model-call-1",
  "step": 2,
  "run_type": "agent_run"
}
```

### 3.9.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `run.run_id` | string (8–64 chars) | Required | Unique run identifier, generated by the harness or by the router when no harness exists. It MUST be account-unique and identical on every record in the run, including spawned-agent records. |
| `run.name` | string (min 1 chars) | Optional | Optional human-readable name of the agentic run. When absent, run_id is used in its place for display purposes. |
| `run.span_id` | string (min 1 chars) | Required | Span identifier for one metered operation, unique within run_id. Together they form the sink merge key, which MUST NOT be shared by different operations. |
| `run.parent_span_id` | string (min 1 chars) | Optional | Links nested tools and spawned agents to a span in the same run_id. Spawned agents MUST reuse the parent run_id and set this field to their spawning span. |
| `run.step` | integer ≥ 0 | Optional | Ordinal position within the run. |
| `run.trace_id` | string | Optional | W3C trace identifier for OpenTelemetry correlation. |
| `run.run_type` | enum (`agent_run`, `workflow`, `single_call`) | Optional | Overall work shape. |
| `run.error_code` | string (min 1 chars) | Optional | Error code when the run fails. Report consumed usage even on failure; downstream rating decides billability. |
| `run.error_reason` | string (max 32 chars) | Optional | Human-readable message of the run failure, limited to 32 characters. |
| `run.outcome` | enum (`resolved`, `escalated`, `abandoned`, `failed`) | Optional | The agent run's final outcome, emitted only by the harness. |

## 3.10 `attribution` Object

The REQUIRED business `attribution` object carries environment, user, account,
subscription, and label dimensions.

### 3.10.1 JSON Example

```json
{
  "environment": "production",
  "user_id": "user-7",
  "account_id": "account-42",
  "subscription_id": "subscription-9",
  "labels": {
    "team": "platform"
  }
}
```

### 3.10.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `attribution.environment` | enum (`production`, `staging`, `development`, `test`, `evaluation`) | Conditional | Deployment environment. A conformant emitter MUST populate it; a missing value triggers default-deny ignore. |
| `attribution.user_id` | string | Optional | Pseudonymous identity of the triggering user; never an email or name. It MUST NOT be used by rating; account_id MUST be used for rating. |
| `attribution.account_id` | string (min 1 chars) | Conditional | The account that pays the bill. Rating may aggregate usage by this account. Required for production traffic; optional otherwise. |
| `attribution.subscription_id` | string | Optional | Subscription associated with the paying account for this usage record. |
| `attribution.labels` | object (≤ 20 key-value pairs) | Optional | Up to 20 free-form dimensions for non-billable metadata. Labels MUST NOT contain PII. |

## 3.11 `usage` Object

The REQUIRED `usage` object contains raw, non-monetary counters. Exactly one
non-empty sub-object MUST be present: `llm` for model operations or `tool` for
tool execution and retrieval.

### 3.11.1 JSON Example

```json
{"llm": {"input_tokens": 1200, "output_tokens": 300, "requests": 1}}
```

### 3.11.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `usage.llm` | object | Conditional | Non-empty model-call counters. A harness may emit counters read from the provider response. |
| `usage.tool` | object | Conditional | Non-empty counters reported by the component that executed the tool: harness for caller-held contracts, router for provider-executed tools. |

### 3.11.3 `usage.llm` Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `usage.llm.input_tokens` | integer ≥ 0 | Optional | Uncached input tokens; MUST exclude cache reads. |
| `usage.llm.output_tokens` | integer ≥ 0 | Optional | Output tokens; exclude reasoning tokens when reasoning_tokens is present. |
| `usage.llm.cache_read_tokens` | integer ≥ 0 | Optional | Prompt-cache read tokens, reported separately for distinct pricing. |
| `usage.llm.cache_write_tokens` | integer ≥ 0 | Optional | Tokens written to a prompt cache by this call. |
| `usage.llm.reasoning_tokens` | integer ≥ 0 | Optional | Reasoning tokens, separate from output for independent pricing. |
| `usage.llm.requests` | integer ≥ 0 | Optional | Request count for per-request pricing. No default applies: absent means unreported, while one request is encoded as 1. |
| `usage.llm.images_processed` | integer ≥ 0 | Optional | Images supplied in model input. |
| `usage.llm.audio_input_seconds` | number ≥ 0 | Optional | Seconds of audio submitted. |
| `usage.llm.audio_output_seconds` | number ≥ 0 | Optional | Seconds of audio generated. |
| `usage.llm.x_*` | integer \| number | Optional | Non-negative provider counter named x_&lt;provider&gt;_&lt;name&gt;. |

### 3.11.4 `usage.tool` Field Descriptions

```json
{"tool": {"type": "code_execution", "call_count": 1, "sandbox_time": 4250}}
```

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `usage.tool.type` | string (min 1 chars) | Optional | The tool operation being metered, such as invocation, api, web_search, code_execution, or retrieval. It complements resource.operation and resource.name. |
| `usage.tool.call_count` | integer ≥ 0 | Optional | Invocation or run count used for per-call pricing. For retrieval, this is usually the query count. |
| `usage.tool.sandbox_time` | number ≥ 0 | Optional | Sandbox compute wall-clock time in milliseconds, distinct from whole-operation timing.duration_ms. Used when an agent run spins up a sandbox for tool execution. |
| `usage.tool.x_*` | integer \| number | Optional | Non-negative implementation counter named x_&lt;name&gt;. |

## 3.12 `cost` Object

The OPTIONAL `cost` object records an asserted event cost. When present, it MUST
contain `total_cost` and `currency`. A rating component MAY use or ignore this
assertion according to its own billing configuration.

### 3.12.1 JSON Example

```json
{"total_cost": 0.0084, "currency": "USD", "llm": {"total_token_cost": 0.0084, "input_token_cost": 0.0036, "output_token_cost": 0.0048}}
```

### 3.12.2 Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `cost.total_cost` | number ≥ 0 | Required | Event-level total cost after discounts. |
| `cost.currency` | string (pattern) | Required | Currency code of the costs in uppercase according to ISO 4217 format. |
| `cost.original_cost` | number ≥ 0 | Optional | List cost before commitments, negotiated rates, or promotions. |
| `cost.discount_amount` | number ≥ 0 | Optional | Difference between original_cost and total_cost. |
| `cost.discount_percent` | number ≥ 0 ≤ 100 | Optional | Any provider promotional discount percentage. |
| `cost.llm` | object | Conditional | The gross cost of the model operation calls. The breakdown is similar to usage.llm and is present only for model operations. |
| `cost.tool` | object | Conditional | The gross cost of the tool execution calls. The breakdown is similar to usage.tool and is present only for tool_execution and retrieval. |

### 3.12.3 `cost.llm` Field Descriptions

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `cost.llm.total_token_cost` | number ≥ 0 | Required | Total token cost for this model call event. Reference only and MAY have rounding differences with the sum of individual token costs. |
| `cost.llm.input_token_cost` | number ≥ 0 | Optional | Cost of uncached input tokens. This would be the total input token cost if cache_read_cost were absent. |
| `cost.llm.output_token_cost` | number ≥ 0 | Optional | Output token cost and MUST exclude reasoning_cost. |
| `cost.llm.cache_read_cost` | number ≥ 0 | Optional | Prompt-cache read cost. |
| `cost.llm.cache_write_cost` | number ≥ 0 | Optional | Prompt-cache write cost. |
| `cost.llm.reasoning_cost` | number ≥ 0 | Optional | Reasoning-token cost. |

### 3.12.4 `cost.tool` Field Descriptions

```json
{"total_cost": 0.012, "currency": "USD", "tool": {"type": "code_execution", "call_cost": 0.002, "sandbox_cost": 0.01}}
```

| Field Name | Type | Required | Description |
| --- | --- | --- | --- |
| `cost.tool.type` | string (min 1 chars) | Optional | The tool operation being metered. It SHOULD match usage.tool.type on the same record. |
| `cost.tool.call_cost` | number ≥ 0 | Optional | Per-invocation charge corresponding to usage.tool.call_count. |
| `cost.tool.sandbox_cost` | number ≥ 0 | Optional | Charge corresponding to usage.tool.sandbox_time. |
| `cost.tool.x_*` | number ≥ 0 | Optional | Charge amount for an implementation-specific field named x_&lt;name&gt;. |

## 3.13 Cross-Field Operation Constraints

`resource.operation` determines the required `resource.type`, `usage` and `cost`
sub-objects. These constraints are enforced by the schema's root `allOf`.

| Operation class | resource.type | usage | cost |
| --- | --- | --- | --- |
| Model operations (`generation`, `embedding`, `reranking`) | `model` | `usage.llm` present; `usage.tool` absent | `cost.llm` MAY be present; `cost.tool` absent |
| Tool operations (`tool_execution`, `retrieval`) | `tool` | `usage.tool` present; `usage.llm` absent | `cost.tool` MAY be present; `cost.llm` absent |

```json
{
  "resource": {
    "provider": "anthropic",
    "type": "model",
    "name": "claude-sonnet-4-20250514",
    "operation": "generation",
    "modality": "text"
  },
  "usage": {
    "llm": {
      "requests": 1
    }
  }
}
```

```json
{
  "resource": {
    "provider": "self-hosted",
    "type": "tool",
    "name": "search_tickets",
    "operation": "retrieval"
  },
  "usage": {
    "tool": {
      "type": "retrieval",
      "call_count": 1
    }
  }
}
```

---

| Status | Schema dialect | Record unit | Content model |
| --- | --- | --- | --- |
| **Versioned schema**<br>This document describes AUDR version 1.0.0. | **Draft 2020-12**<br>JSON Schema validation vocabulary. | **One operation**<br>Each record describes one metered event. | **Closed objects**<br>Unspecified properties are rejected except defined extensions. |

Agent Usage Detail Record · Specification v1.0.0
