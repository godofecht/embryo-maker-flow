#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
FLOW_OPT_LEVEL=3 FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile ui/server.flow
exec "$HOME/flow/build/server"
