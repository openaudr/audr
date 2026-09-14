# Contributing to AUDR

AUDR is an open specification. This document describes how a change to it is
proposed, reviewed, and accepted.

Contributors are asked to review the existing specification and the open issues
before opening a new issue or pull request, to keep communication relevant and
concise, and to be able to answer questions about anything they submit.

## Reporting an issue

Use one of two channels:

- **[GitHub issues](https://github.com/openaudr/audr/issues)** — the default.
  Public discussion is preferred, because it records the reasoning behind a
  decision where the next implementer will find it.
- **<audr@chargebee.com>** — for matters that do not belong in a public tracker,
  such as those disclosing commercial pricing or volume data.

Do not report a suspected vulnerability through either channel. Follow
[SECURITY.md](SECURITY.md).

The most valuable report is a cost model that AUDR cannot express. State the
operation to be metered, the record that was attempted, and the constraint that
prevented it.

## Classes of change

### Editorial changes

_Examples: correcting a typographical error, repairing a broken link, rewording
a sentence without altering its meaning, correcting an example._

Submit a pull request directly. No issue is required.

### Normative changes

_Examples: adding, removing, or renaming a field; changing a type, requirement
level, or constraint; adding a value to a closed enumeration; altering the
meaning of an existing requirement._

Open an issue describing the problem and wait for it to be accepted before
submitting a pull request. A normative change alters what conformant
implementations are required to do, so the problem is agreed before a solution
is evaluated. A pull request opened without an accepted issue may be closed
without review.

A draft pull request may accompany the issue to illustrate a proposal, but it
does not substitute for one.

### Adapters and implementations

An adapter for a harness, router, or gateway is maintained in its own
repository, not this one. Open an issue describing it and it will be linked.

## Published versions

A published version of the specification is immutable. Its schema is served at a
permanent `$id` URL that implementations resolve at runtime, and records already
written declare that version.

No change is therefore made to the contents of a published version, however
trivial. A defect in a published version is corrected by publishing a new
version and recording what was wrong; it is never corrected by editing the
published artefacts in place.

## Pull requests

- Address one concern per pull request.
- Describe the problem being solved, not only the change being made.
- Reference the issue the pull request resolves, where one exists.
- Where the change affects [`audr.schema.json`](spec/v1.0.0/audr.schema.json),
  state which records become valid, or invalid, that were not before.

[`SPEC.md`](spec/v1.0.0/SPEC.md) is a generated document: the field tables are
derived from the schema. Propose a change to a field's type, requirement level,
or description in [`audr.schema.json`](spec/v1.0.0/audr.schema.json) rather than
in the rendered specification.

## Licensing

Contributions are accepted under the [Apache License 2.0](LICENSE), which covers
this repository. By submitting a contribution you certify that you have the
right to submit it under that licence.
