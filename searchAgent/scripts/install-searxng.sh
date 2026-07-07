#!/usr/bin/env sh
set -eu

SEARXNG_REPO_URL="https://github.com/searxng/searxng.git"
SEARXNG_HOME="/usr/local/searxng"
SEARXNG_CLONE_DIR="${SEARXNG_HOME}/searxng-src"
SEARXNG_VENV="${SEARXNG_HOME}/searx-pyenv"

if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        libffi-dev \
        libssl-dev \
        libxml2-dev \
        libxslt1-dev \
        libyaml-dev \
        pkg-config \
        python3-babel \
        python-is-python3 \
        python3 \
        python3-dev \
        python3-venv \
        zlib1g-dev
fi

mkdir -p "${SEARXNG_HOME}"
if [ ! -d "${SEARXNG_CLONE_DIR}/.git" ]; then
    git clone "${SEARXNG_REPO_URL}" "${SEARXNG_CLONE_DIR}"
else
    git -C "${SEARXNG_CLONE_DIR}" pull --ff-only
fi
chmod -R a+rX "${SEARXNG_CLONE_DIR}"

mkdir -p "$(dirname "${SEARXNG_VENV}")"
if [ ! -x "${SEARXNG_VENV}/bin/python" ]; then
    python3 -m venv "${SEARXNG_VENV}"
fi

"${SEARXNG_VENV}/bin/python" -m pip install --upgrade pip setuptools wheel
"${SEARXNG_VENV}/bin/python" -m pip install --upgrade pyyaml msgspec typing-extensions pybind11
cd "${SEARXNG_CLONE_DIR}"
"${SEARXNG_VENV}/bin/python" -m pip install --use-pep517 --no-build-isolation -e .

node /code/scripts/configure-searxng-settings.mjs
