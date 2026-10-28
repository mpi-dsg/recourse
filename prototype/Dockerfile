# Reproduction image for the Recourse evaluation artifact.
# Provides the pinned forge, Bun, uv, Docker CLI, and Compose toolchains used by
# `scripts/reproduce.sh`. Provider-backed tests use the host Docker daemon.
#
# Build:
#   docker build -t recourse:repro .
# Run (mount the source tree and host Docker socket):
#   docker run --rm \
#     -v "$PWD":/work \
#     -v /var/run/docker.sock:/var/run/docker.sock \
#     -w /work recourse:repro \
#     ./scripts/reproduce.sh

FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

ARG FOUNDRY_VERSION=v1.3.5
ARG BUN_VERSION=1.3.5
ARG UV_VERSION=0.11.28

ENV DEBIAN_FRONTEND=noninteractive \
    PATH="/root/.foundry/bin:/root/.bun/bin:/root/.local/bin:${PATH}"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl git build-essential \
        python3.12 python3.12-venv python3-pip \
        docker.io docker-compose-v2 gnupg unzip jq \
        libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Foundry (forge / cast / anvil).
RUN curl -L https://foundry.paradigm.xyz | bash \
    && /root/.foundry/bin/foundryup -i "${FOUNDRY_VERSION}"

# Bun (TypeScript runtime + test runner).
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"

# uv (Python project/env manager).
RUN curl -LsSf "https://astral.sh/uv/${UV_VERSION}/install.sh" | sh

RUN test "$(forge --version | head -n1 | sed -E 's/^forge Version: ([^ -]+).*/\1/')" = "${FOUNDRY_VERSION#v}" \
    && test "$(bun --version)" = "${BUN_VERSION}" \
    && test "$(uv --version | awk '{print $2}')" = "${UV_VERSION}" \
    && docker --version \
    && docker compose version

WORKDIR /work

# Default to the reproduction entry point; override with any other command.
CMD ["bash", "scripts/reproduce.sh"]
