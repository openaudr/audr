.PHONY: install lint format typecheck schema schema-check test conformance build examples isolation verify clean
NPM ?= npm
ROOT := ../../..
# Every TypeScript package installs from the repository's root lockfile, which links the
# local core; the root target also builds the core, which dependents resolve through `dist/`.
install:
	$(MAKE) -C $(ROOT) typescript-install
lint:
	$(NPM) run lint
	$(NPM) run typecheck
format:
	$(NPM) run format
typecheck:
	$(NPM) run typecheck
schema:
	node scripts/gen-schema.ts
schema-check:
	node scripts/gen-schema.ts --check
test:
	$(NPM) test
conformance:
	npx vitest run tests/conformance.test.ts
build:
	$(NPM) run build
examples: build
	node examples/write-to-file.ts
	node examples/decode-json.ts
	node examples/custom-sink.ts
isolation: build
	$(NPM) run check:package
	node $(ROOT)/tools/verify-npm-package.mjs .
verify: lint schema-check test examples isolation
clean:
	rm -rf dist coverage *.tgz
