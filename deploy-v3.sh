#!/bin/sh
# Runs escrow.mjs on this server inside Docker (the host has no Node.js).
# Usage:  ./deploy-v3.sh /path/to/owner.key whoami    (check address + AVAX balance, sends nothing)
#         ./deploy-v3.sh /path/to/owner.key deploy    (deploys CommodexEscrow v3 on Fuji, once)
# The key file is mounted read-only and never printed.
set -e
KEY="$1"; CMD="${2:-whoami}"
[ -n "$KEY" ] && [ -f "$KEY" ] || { echo "usage: $0 /path/to/owner.key [whoami|deploy|token|status <id>]"; exit 2; }
shift 2 2>/dev/null || shift 1
cd "$(dirname "$0")"
[ -d node_modules ] || docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app node:22-alpine npm install --no-audit --no-fund --no-package-lock
exec docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/app -w /app \
  -v "$(readlink -f "$KEY")":/run/owner.key:ro -e COMMODEX_FUJI_KEY_FILE=/run/owner.key -e FUJI_RPC="${FUJI_RPC:-https://avalanche-fuji-c-chain-rpc.publicnode.com}" \
  node:22-alpine node escrow.mjs "$CMD" "$@"
