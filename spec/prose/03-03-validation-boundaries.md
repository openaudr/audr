JSON Schema validation does not enforce every AUDR invariant. Conformant sinks
and conformance tooling are responsible for the following requirements:

- A record missing `attribution.environment` MUST be ignored and MUST NOT be
  rated.
- Sinks MUST apply `record_id` deduplication and correction replacement.
- Unknown `x_*` extension counters MUST be accepted, not rejected.
- Each block has one writer for a given `run_id` and `span_id` merge key.
- Rating components MAY check cost-component consistency without overwriting
  `cost.total_cost`.
- A merge key MUST identify one metered operation.
- A correction MUST use the same `emitter.component` as the corrected record.
