# Chargebee

A [sink](../README.md) that delivers [AUDR](../../spec/SPEC.md) records to a Chargebee
site's usage-ingest batch endpoint, for Chargebee Usage-Based Billing. Chargebee routes on
`attribution.subscription_id` and de-duplicates on `record_id`; a record without a
`subscription_id` is rejected by name rather than sent.

| Language | Distribution | Package guide |
| --- | --- | --- |
| [Python](python/) | [![PyPI](https://img.shields.io/pypi/v/audr-sink-chargebee?include_prereleases&label=audr-sink-chargebee)](https://pypi.org/project/audr-sink-chargebee/) | [`python/README.md`](python/README.md) — setup, usage, configuration, delivery; the full reference is [`python/docs/reference.md`](python/docs/reference.md) |
| [TypeScript](typescript/) | [![npm](https://img.shields.io/npm/v/@openaudr/audr-sink-chargebee?include_prereleases&label=%40openaudr%2Faudr-sink-chargebee)](https://www.npmjs.com/package/@openaudr/audr-sink-chargebee) | [`typescript/README.md`](typescript/README.md) — setup, usage, configuration, delivery; the full reference is [`typescript/docs/reference.md`](typescript/docs/reference.md) |

To contribute a change, see [`python/AGENTS.md`](python/AGENTS.md) or
[`typescript/AGENTS.md`](typescript/AGENTS.md). To contribute a new
sink, see [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
