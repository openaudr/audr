# AUDR conformance fixtures

Shared, language-neutral test data for anything that emits, validates, or ingests
AUDR records. An implementation, whether an SDK, a validator or a sink, is conformant
when it reproduces every expected outcome in this suite.

## Layout

```
cases.json            manifest: every fixture, its expected outcome, and the
                      specification rule it exercises
fixtures/valid/       records a conformant validator MUST accept
fixtures/invalid/     records a conformant validator MUST reject
runner/python/run.py  reference runner
```

Every fixture is plain JSON, and so is `cases.json`. A runner in any language
reads the manifest, validates each file against `spec/audr.schema.json`, and
compares the outcome to `expect`.

## Running the suite

From the repository root:

```bash
make install                                  # the runner's dependencies
python3 conformance/runner/python/run.py      # -v to list every case
```

The runner prints a one-line summary of the cases it ran, and exits non-zero
naming every case whose outcome disagreed with the manifest.

## What the fixtures cover

| Rule | Covers |
| --- | --- |
| 3.1 | Closed objects; unspecified properties rejected |
| 3.4.1–3.4.4 | Required properties, `spec_version` family, `record_id` bounds, corrections |
| 3.4.5–3.4.9 | Per-object field constraints and closed sub-objects |
| 3.4.10 | Usage counters, absent-vs-zero, `x_*` extension naming |
| 3.4.11 | Cost components, currency format, required pairs |
| 3.5 | Cross-field operation constraints |

Two fixtures guard the schema's structure rather than a single field rule, and
both must keep failing:

- `invalid/allof-as-field.json`: if `allOf` is ever nested inside `properties`,
  every cross-field constraint stops applying and `allOf` becomes an accepted
  record field. This fixture guards against that regression.
- `invalid/unknown-operation.json` pins the `resource.operation` enum, so a
  value outside it cannot appear in an example.

## Format assertion

JSON Schema treats `format` as an annotation unless the validator is configured
to assert it. AUDR's `timing.event_time` and `timing.received_time` therefore
carry an RFC 3339 `pattern` alongside `format: date-time`, so the constraint
holds on every validator regardless of configuration. The reference runner also
enables format assertion explicitly.

## Requirements enforced outside the schema

Several AUDR requirements cannot be expressed in JSON Schema at all. They are
enforced by the sink, and are listed in section 3.3 of the specification. A
record can pass every fixture here and still be non-conformant at ingest — most
importantly, a record missing `attribution.environment` is schema-valid but
MUST be ignored and MUST NOT be rated.

## Adding a case

1. Add the JSON file under `fixtures/valid/` or `fixtures/invalid/`.
2. Append an entry to `cases.json` with `file`, `expect`, `rule`, and a `note`
   saying what the case proves.
3. Run the suite.

An invalid fixture should fail for exactly one reason. If it trips several
constraints at once it stops being a useful regression test.
