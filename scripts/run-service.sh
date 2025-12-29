#!/bin/bash
# Helper script to run wrangler commands for a specific service
# Usage: ./scripts/run-service.sh <service> <command> [args...]
#   e.g., ./scripts/run-service.sh paperless deploy
#   e.g., ./scripts/run-service.sh things tail

SERVICE=$1
COMMAND=$2
shift 2

if [ -z "$SERVICE" ] || [ -z "$COMMAND" ]; then
  echo "Usage: $0 <service> <command> [args...]"
  echo "Services: paperless, things"
  echo "Commands: dev, deploy, tail, rollback, secret"
  exit 1
fi

wrangler "$COMMAND" --config "wrangler.${SERVICE}.toml" "$@"
