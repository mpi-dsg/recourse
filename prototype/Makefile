.PHONY: help setup test test-all audit validate-paper-claims validate-reproduced-results freeze-paper-artifacts sync-paper-artifacts reproduce test-contracts test-ts test-py test-scripts test-integration test-providers local-test-results integration-up integration-down lint lint-contracts lint-schemas lint-scripts lint-abi lint-py typecheck typecheck-contracts typecheck-ts typecheck-py coverage coverage-contracts coverage-ts coverage-py abi artifact rq1 rq2 rq2-reasons rq3 rq4 rq5 rq5-adv rq8 rq9 rq10 rq-all clean

SHELL := /bin/bash
PYTHON ?= python3
PY_COVERAGE_MIN ?= 80
SOLIDITY_LINE_COVERAGE_MIN ?= 80
SOLIDITY_STATEMENT_COVERAGE_MIN ?= 80
SOLIDITY_BRANCH_COVERAGE_MIN ?= 80
TS_LINE_COVERAGE_MIN ?= 80
RECOURSE_PG_PORT ?= 55432
RECOURSE_LOCALSTACK_PORT ?= 54566
export RECOURSE_PG_PORT
export RECOURSE_LOCALSTACK_PORT
PAPER_CLAIMS_MANIFEST ?= reproducibility/paper-claims.v1.json
PAPER_CLAIMS_REPO_ROOT ?= .

help:
	@echo "Targets:"
	@echo "  setup           - install all toolchains (foundry, bun, uv)"
	@echo "  test            - run implemented test suites"
	@echo "  test-all        - run lint, typecheck, tests, and coverage"
	@echo "  audit           - scan locked Bun and Python dependencies"
	@echo "  validate-paper-claims - validate paper claim provenance and artifact parity"
	@echo "  validate-reproduced-results - compare a fresh result root with frozen evidence"
	@echo "  freeze-paper-artifacts - intentionally freeze a complete result root"
	@echo "  sync-paper-artifacts - checksum and sync frozen evidence to the paper"
	@echo "  reproduce       - run the complete clean-output paper reproduction"
	@echo "  lint            - run lint checks for all implemented components"
	@echo "  typecheck       - run Solidity, TS, and Python type checks"
	@echo "  coverage        - run coverage reports and enforce 80% minimums"
	@echo "  abi             - export public contract ABI snapshots"
	@echo "  artifact        - package reproducibility snapshot"
	@echo "  test-contracts  - forge test for all contract suites"
	@echo "  test-ts         - bun test for all runtime packages"
	@echo "  test-py         - pytest for classifier and harness"
	@echo "  test-scripts    - stdlib regression tests for result/deployment tools"
	@echo "  test-providers  - run local Postgres, Git, and LocalStack benchmarks"
	@echo "  local-test-results - regenerate local E2E gas and fuzz summaries"
	@echo "  rq1..rq10       - run a configured research question end-to-end"
	@echo "  rq-all          - run all synthetic research-question drivers"
	@echo "  clean           - remove build artifacts (preserves results/)"

setup:
	./scripts/bootstrap.sh

test-all: lint typecheck test coverage

audit:
	./scripts/check-dependencies.sh

validate-paper-claims:
	$(PYTHON) scripts/validate-paper-claims.py \
		--manifest "$(PAPER_CLAIMS_MANIFEST)" \
		--repo-root "$(PAPER_CLAIMS_REPO_ROOT)" \
		--paper-dir "$(RECOURSE_PAPER_DIR)"

validate-reproduced-results:
	cd harness && uv run python ../scripts/validate-reproduced-results.py \
		--results "$(RECOURSE_RESULTS_ROOT)" \
		--frozen "../reproducibility/paper-v1"

freeze-paper-artifacts:
	./scripts/freeze-paper-artifacts.sh

sync-paper-artifacts:
	./scripts/sync-paper-artifacts.sh sync

reproduce:
	./scripts/reproduce.sh

test: test-contracts test-ts test-py test-scripts

test-contracts:
	cd contracts && forge test

test-ts:
	cd runtime-ts && bun test

test-py:
	cd classifier && uv run pytest -q
	cd harness && uv run pytest -q

test-scripts:
	$(PYTHON) -m unittest discover -s scripts -p 'test_*.py'

local-test-results:
	$(PYTHON) scripts/local_test_results.py

integration-up:
	./scripts/integration-up.sh

integration-down:
	./scripts/integration-down.sh

test-integration: integration-up
	@set +e; cd runtime-ts && \
		RECOURSE_PG_URL=postgres://recourse:recourse@localhost:$(RECOURSE_PG_PORT)/recourse_test \
		RECOURSE_LOCALSTACK_URL=http://localhost:$(RECOURSE_LOCALSTACK_PORT) \
		bun test; status=$$?; cd ..; $(MAKE) integration-down; exit $$status

test-providers:
	./scripts/run-provider-benchmarks.sh

lint: lint-contracts lint-schemas lint-scripts lint-abi lint-py

lint-contracts:
	cd contracts && forge fmt --check

lint-schemas:
	find schemas -name '*.json' -print0 | xargs -0 -n1 $(PYTHON) -m json.tool >/dev/null

lint-scripts:
	bash -n scripts/*.sh
	find scripts -maxdepth 1 -name '*.py' -print0 | xargs -0 -n1 $(PYTHON) -m py_compile

lint-abi:
	./scripts/export-abi.sh --check

lint-py:
	cd classifier && uv run --extra dev ruff check src tests
	cd harness && uv run --extra dev ruff check src tests

typecheck: typecheck-contracts typecheck-ts typecheck-py

typecheck-contracts:
	cd contracts && forge build

typecheck-ts:
	cd runtime-ts && bun run typecheck

typecheck-py:
	cd classifier && uv run --extra dev mypy --ignore-missing-imports src tests
	cd harness && uv run --extra dev mypy --ignore-missing-imports src tests

coverage: coverage-contracts coverage-ts coverage-py

coverage-contracts:
	mkdir -p .coverage-tmp
	set -o pipefail; cd contracts && forge coverage --ir-minimum --exclude-tests --no-match-contract ".*Invariant.*" --no-match-coverage "script/.*" 2>&1 | tee ../.coverage-tmp/contracts.txt
	$(PYTHON) scripts/check-coverage-summary.py foundry .coverage-tmp/contracts.txt --line-min $(SOLIDITY_LINE_COVERAGE_MIN) --statement-min $(SOLIDITY_STATEMENT_COVERAGE_MIN) --branch-min $(SOLIDITY_BRANCH_COVERAGE_MIN)

coverage-ts:
	mkdir -p .coverage-tmp
	set -o pipefail; cd runtime-ts && bun test --coverage 2>&1 | tee ../.coverage-tmp/runtime-ts.txt
	$(PYTHON) scripts/check-coverage-summary.py bun .coverage-tmp/runtime-ts.txt --line-min $(TS_LINE_COVERAGE_MIN)

coverage-py:
	cd classifier && uv run --extra dev pytest --cov=recourse_classifier --cov-report=term-missing --cov-fail-under=$(PY_COVERAGE_MIN)
	cd harness && uv run --extra dev pytest --cov=recourse_harness --cov-report=term-missing --cov-fail-under=$(PY_COVERAGE_MIN)

abi:
	./scripts/export-abi.sh

artifact:
	./scripts/snapshot-results.sh

rq1 rq2 rq2-reasons rq3 rq4 rq5 rq5-adv rq8 rq9 rq10:
	./scripts/run-rq.sh $@

rq-all:
	./scripts/run-rq.sh all

clean:
	cd contracts && forge clean
	find runtime-ts -type d \( -name dist -o -name node_modules \) -prune -exec rm -rf {} + 2>/dev/null || true
	rm -rf runtime-ts/coverage classifier/.coverage classifier/htmlcov harness/.coverage harness/htmlcov .coverage-tmp artifacts
	find . -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .pytest_cache -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .ruff_cache -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d -name .mypy_cache -prune -exec rm -rf {} + 2>/dev/null || true
