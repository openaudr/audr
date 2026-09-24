.PHONY: install lint format typecheck test conformance build examples isolation verify clean
NPM ?= npm
install:
	$(NPM) ci
lint:
	$(NPM) run lint
	$(NPM) run typecheck
format:
	$(NPM) run format
typecheck:
	$(NPM) run typecheck
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
	node scripts/verify-package.ts
verify: lint test examples isolation
clean:
	rm -rf dist coverage node_modules *.tgz
