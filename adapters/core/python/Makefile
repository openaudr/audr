.PHONY: install models models-check test lint format typecheck conformance examples build isolation verify clean
UV ?= uv
install:
	$(UV) sync --locked --group dev
models:
	$(UV) run python scripts/gen_models.py
models-check:
	$(UV) run python scripts/gen_models.py --check
test:
	$(UV) run pytest --cov --cov-report=term-missing
conformance:
	$(UV) run pytest tests/test_conformance.py -q
lint:
	$(UV) run ruff check .
	$(UV) run ruff format --check .
	$(UV) run mypy
format:
	$(UV) run ruff format .
	$(UV) run ruff check --fix .
typecheck:
	$(UV) run mypy
examples:
	$(UV) run python examples/write_to_file.py
	$(UV) run python examples/from_json.py
	$(UV) run python examples/custom_sink.py
build:
	rm -rf dist && $(UV) build
isolation: build
	$(UV) run python scripts/verify_distribution.py
verify: lint models-check test examples isolation
clean:
	rm -rf dist .venv .pytest_cache .ruff_cache .mypy_cache .coverage
