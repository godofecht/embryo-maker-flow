#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

if ! command -v pandoc >/dev/null 2>&1; then
    printf '%s\n' "Pandoc is required to render docs/flow-idioms.html." >&2
    exit 1
fi

pandoc docs/flow-idioms.md \
    --from=markdown+fenced_divs+bracketed_spans \
    --to=html5 \
    --standalone \
    --syntax-highlighting=breezedark \
    --template=docs/flow-idioms.template.html \
    --output=docs/flow-idioms.html
