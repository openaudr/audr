.PHONY: help spec check schema examples conformance lint fresh links versions install clean all
.PHONY: python core-python adapter-nemo-relay-python sink-chargebee-python
.PHONY: typescript core-typescript

PYTHON ?= python3

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install the tooling dependencies
	$(PYTHON) -m pip install -r requirements.txt

spec: ## Regenerate the specification from the schema, outline and prose
	@$(PYTHON) tools/render.py

check: schema examples conformance lint fresh links versions ## Everything CI runs
	@echo "All checks passed."

schema: ## Meta-validate the schema against JSON Schema Draft 2020-12
	@$(PYTHON) -c "import json,sys; from jsonschema import Draft202012Validator as V; \
	s=json.load(open('spec/audr.schema.json')); V.check_schema(s); \
	print('  schema is a valid Draft 2020-12 schema')"

examples: ## Validate every specification example against the schema
	@$(PYTHON) tools/validate_examples.py

conformance: ## Run the shared conformance fixtures
	@$(PYTHON) conformance/runner/python/run.py

lint: ## Check $$id cross-references resolve
	@$(PYTHON) tools/lint.py

fresh: ## Fail if any generated file is stale
	@$(PYTHON) tools/render.py --check

links: ## Check every relative link and heading anchor in Markdown resolves
	@$(PYTHON) tools/check_links.py

versions: ## Fail if a distribution version is written into any Markdown file
	@$(PYTHON) tools/check_versions.py

core-python: ## Verify the core Python SDK (adapters/core/python)
	@$(MAKE) -C adapters/core/python verify

adapter-nemo-relay-python: ## Lint and test the NeMo Relay Python adapter
	@$(MAKE) -C adapters/nemo-relay/python lint test

sink-chargebee-python: ## Lint and test the Chargebee Python sink
	@$(MAKE) -C sinks/chargebee/python lint test

python: core-python adapter-nemo-relay-python sink-chargebee-python ## Verify every Python package

core-typescript: ## Verify the core TypeScript SDK (adapters/core/typescript)
	@$(MAKE) -C adapters/core/typescript install verify

typescript: core-typescript ## Verify every TypeScript package

all: check python typescript ## Everything CI runs, across the repository

clean: ## Remove generated specification outputs
	@rm -f spec/SPEC.md
	@echo "  removed generated outputs (run 'make spec' to restore)"
