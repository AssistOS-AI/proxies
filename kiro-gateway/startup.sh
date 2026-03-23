#!/bin/bash
echo "Starting Kiro Gateway..."
mkdir -p /shared/kiro-gateway
cd /code
exec node server.mjs
