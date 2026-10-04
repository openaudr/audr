## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## Type

- [ ] Editorial — prose, examples, typos, links
- [ ] Tooling — build, CI, runner
- [ ] SDK or sink — a package under `adapters/` or `sinks/`
- [ ] Normative — changes what a conformant record or sink must do

Normative changes need an accepted issue first; see [CONTRIBUTING.md](../CONTRIBUTING.md).

## If this touches the schema

- [ ] Examples still validate (`make examples`)
- [ ] A conformance fixture covers the rule I added or changed
- [ ] The generated specification is regenerated (`make spec`) and committed
- [ ] Version impact considered: does this invalidate a record that was
      conformant before? If so it is a major version, not a patch

## Checks

- [ ] `make check` passes locally (spec, schema, conformance)
- [ ] `make python` passes locally, if this touches a Python package under `adapters/` or `sinks/`
- [ ] `make typescript` passes locally, if this touches a TypeScript package under `adapters/` or `sinks/`
- [ ] Every generated file in this change was regenerated, never hand-edited

<!--
Generated files — never edit these directly:
  spec/SPEC.md                                              (run `make spec`)
  adapters/core/python/src/audr/record/_schema.py           (run `make models`)
  adapters/core/typescript/src/generated-schema.ts          (run `make schema` there)
  adapters/core/typescript/src/generated-validator.ts       (run `make schema` there)
-->
