.PHONY: install lint format typecheck test build examples isolation verify clean
NPM ?= npm
CORE := ../../core/typescript
# The core is linked from this repository, so a core change is tested against this package
# before either is released. It resolves through its built `dist/`, so it is built first.
install:
	$(MAKE) -C $(CORE) install build
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
build:
	$(NPM) run build
examples: build
	node examples/generate-text.ts
	node examples/agent-call-options.ts
	node examples/sub-agent.ts
isolation: build
	$(NPM) run check:package
verify: lint test examples isolation
clean:
	rm -rf dist coverage node_modules *.tgz
