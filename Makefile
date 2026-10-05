.PHONY: help spec check schema examples conformance lint fresh links versions tools-test install clean all
.PHONY: python core-python adapter-litellm-python adapter-nemo-relay-python sink-chargebee-python
.PHONY: typescript typescript-install typescript-lint core-typescript adapter-merge-gateway-typescript adapter-openrouter-typescript adapter-vercel-ai-typescript adapter-mastra-typescript sink-chargebee-typescript

PYTHON ?= python3

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install the tooling dependencies
	$(PYTHON) -m pip install -r requirements.txt

spec: ## Regenerate the specification from the schema, outline and prose
	@$(PYTHON) tools/render.py

check: schema examples conformance lint fresh links versions tools-test ## Everything CI runs
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

tools-test: ## Test the repository tools
	@$(PYTHON) -m unittest discover -s tools/tests -t tools/tests

core-python: ## Verify the core Python SDK (adapters/core/python)
	@$(MAKE) -C adapters/core/python verify

adapter-litellm-python: ## Verify the LiteLLM Python adapter
	@$(MAKE) -C adapters/litellm/python verify

adapter-nemo-relay-python: ## Verify the NeMo Relay Python adapter
	@$(MAKE) -C adapters/nemo-relay/python verify

sink-chargebee-python: ## Verify the Chargebee Python sink
	@$(MAKE) -C sinks/chargebee/python verify

python: core-python adapter-litellm-python adapter-nemo-relay-python sink-chargebee-python ## Verify every Python package

typescript-install: ## Install every TypeScript package from the root lockfile and build the core
	npm ci
	node tools/check-workspace-core.mjs
	npm run build --workspace adapters/core/typescript

typescript-lint: typescript-install ## Check the formatting of the shared TypeScript tooling at the repository root
	npx prettier --check package.json tsconfig.base.json .prettierrc.json eslint.base.mjs tools/*.mjs

core-typescript: typescript-install ## Verify the core TypeScript SDK (adapters/core/typescript)
	@$(MAKE) -C adapters/core/typescript verify

adapter-merge-gateway-typescript: typescript-install ## Verify the Merge Gateway TypeScript adapter
	@$(MAKE) -C adapters/merge-gateway/typescript verify

adapter-openrouter-typescript: typescript-install ## Verify the OpenRouter TypeScript adapter
	@$(MAKE) -C adapters/openrouter/typescript verify

adapter-vercel-ai-typescript: typescript-install ## Verify the Vercel AI TypeScript adapter
	@$(MAKE) -C adapters/vercel-ai/typescript verify

adapter-mastra-typescript: typescript-install ## Verify the Mastra TypeScript adapter
	@$(MAKE) -C adapters/mastra/typescript verify

sink-chargebee-typescript: typescript-install ## Verify the Chargebee TypeScript sink (sinks/chargebee/typescript)
	@$(MAKE) -C sinks/chargebee/typescript verify

typescript: typescript-lint core-typescript adapter-merge-gateway-typescript adapter-openrouter-typescript adapter-vercel-ai-typescript adapter-mastra-typescript sink-chargebee-typescript ## Verify every TypeScript package

all: check python typescript ## Everything CI runs, across the repository

clean: ## Remove generated specification outputs
	@rm -f spec/SPEC.md
	@echo "  removed generated outputs (run 'make spec' to restore)"
