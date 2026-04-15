#!/bin/bash
set -a
source ~/work/.env
set +a
exec node "$(dirname "$0")/test-search-tier.mjs" "$@"
