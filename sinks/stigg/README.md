# Stigg

A [sink](../README.md) that delivers [AUDR](../../spec/SPEC.md) records to Stigg's raw events
endpoint, for metering, entitlements and credits. Stigg routes on `attribution.account_id`
as the customer, takes `attribution.subscription_id` as the resource when present, and
de-duplicates on `record_id`; a record without an `account_id`, or one that corrects another
record, is rejected by name rather than sent.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-stigg?include_prereleases&label=%40openaudr%2Faudr-sink-stigg)](https://www.npmjs.com/package/@openaudr/audr-sink-stigg) | [`typescript/README.md`](typescript/README.md) — setup, usage, configuration, delivery; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a
new sink, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
