.PHONY: install test lint format typecheck examples build isolation verify clean
UV ?= uv
install:
	$(UV) sync --locked --group dev
test:
	$(UV) run pytest --cov --cov-report=term-missing
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
	$(UV) run --extra runtime python examples/agent_scope.py
build:
	rm -rf dist && $(UV) build
isolation: build
	$(UV) run python scripts/verify_distribution.py
verify: lint test examples isolation
clean:
	rm -rf dist .venv .pytest_cache .ruff_cache .mypy_cache .coverage
