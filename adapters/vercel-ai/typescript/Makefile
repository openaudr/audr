.PHONY: install lint format typecheck test build examples isolation verify clean
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
test:
	$(NPM) test
build:
	$(NPM) run build
examples: build
	node examples/generate-text.ts
	node examples/agent-call-options.ts
	node examples/sub-agent.ts
isolation: build
	$(NPM) run check:package
	node $(ROOT)/tools/verify-npm-package.mjs .
verify: lint test examples isolation
clean:
	rm -rf dist coverage *.tgz
