#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir/tests"
export FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off"
count=0
for test_file in test_*.flow; do
    if flow run "$test_file"; then
        count=$((count + 1))
    else
        printf 'FAILED %s\n' "$test_file" >&2
        exit 1
    fi
done
printf 'Passed %s Flow checks.\n' "$count"
