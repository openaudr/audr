# AGENTS.md — sinks

Guidance for work under `sinks/`. A package's own `AGENTS.md` takes precedence inside
that package; repository-wide rules are in the root [`AGENTS.md`](../AGENTS.md).
[`CONTRIBUTING.md`](CONTRIBUTING.md) explains the sink contract and what a new sink ships.
This file summarises the rules to observe and the steps to follow.

## Rules

1. Report outcomes from `deliver()` and `close()`. Never raise for a delivery failure.
2. Retry inside `deliver()`, bounded by a configured policy. The pipeline never retries,
   so report `RETRYABLE_FAILURE` only once that budget is spent.
3. Mark a record the destination did not confirm as `unknown`. Never assume it was sent.
4. Forward the whole record without adding, removing or re-validating any field. The
   data-handling rules in [`SECURITY.md`](../SECURITY.md) are enforced where the record is
   built.
5. Keep credentials out of logs, errors and `repr()`.
6. Run `audr.testing.assert_sink_contract()` in the test suite.

## Creating a new sink

Follow these steps when adding a sink for a destination. Confirm first that an accepted
issue agrees the routing key and the de-duplication key; if none exists, stop and report it.

1. **Read** [`CONTRIBUTING.md`](CONTRIBUTING.md) in full, then the contract in
   [`adapters/core/README.md`](../adapters/core/README.md#the-sink-contract), then the
   Chargebee sink (`chargebee/python/`) as the reference implementation.
2. **Create** `sinks/<target>/python/` by copying the shape of `chargebee/python/`.
   `CONTRIBUTING.md` lists every file the package ships. In `pyproject.toml`: name
   `audr-sink-<target>`, `requires-python = ">=3.11"`, `httpx` if the destination is HTTP,
   the shared Ruff/mypy/pytest configuration, `fail_under = 90`.
3. **Implement** as separate modules, with tests alongside each: credentials; the
   record-to-event encoding, including the routing and de-duplication keys; the transport
   with timeout and retry policy; the response-to-`BatchResult` mapping; the `Sink` class
   composing them. Add the `assert_sink_contract` test and a no-live-network test.
4. **Wire the repository:** `.github/workflows/sink-<target>-python-verify.yml` modelled
   on `sink-chargebee-python-verify.yml`, a root `Makefile` target `sink-<target>-python`
   added to `python`, a `CODEOWNERS` line, a row in [`README.md`](README.md), and
   `sinks/<target>/README.md` indexing the language.
5. **Write the README** for PyPI: install, configure, routing and delivery semantics, the
   data-handling restatement with a link to `SECURITY.md`. Absolute URLs. No version
   number. Execute every code block.
6. **Verify:** `make verify` in the package, then `make all` at the root.

A TypeScript sink follows the same steps in `sinks/<target>/typescript/`, modelled on
`chargebee/typescript/`: `@openaudr/audr` as a peer dependency, `assertSinkContract` from
`@openaudr/audr/testing`, a filter in the `changes` job of `typescript-verify.yml`, and a root
`Makefile` target `sink-<target>-typescript` added to `typescript`.
