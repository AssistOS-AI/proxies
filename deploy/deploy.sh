#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' \
    'ERROR: the legacy proxy deployment helper is disabled under runtime contract v5.' \
    'This checkout has no reviewed immutable Kiro or Antigravity runtime-v5 agent artifacts, so deployment must fail before reading local configuration or contacting a remote host.' \
    'Do not supply credentials to this script. A replacement requires a separately reviewed Ploinky operator flow and a secret provider that never places values in output, command arguments, generated scripts, or artifacts.' >&2
exit 1
