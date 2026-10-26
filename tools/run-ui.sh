#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
build_root=${FLOW_BUILD_ROOT:-"$HOME/flow/build"}
cc=${CC:-cc}
cflags="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off"
# tools/build-pgo.sh writes a clang profile of the simulation modules. When it
# exists, the server build reuses it. A profile from older source still
# builds; functions whose shape changed simply get no profile data.
profile="$repo_dir/build/pgo/embryomaker.profdata"
if [ -f "$profile" ]; then
    cflags="$cflags -fprofile-instr-use=$profile -Wno-profile-instr-out-of-date -Wno-profile-instr-unprofiled"
    cc=${CC:-clang}
fi
CC="$cc" FLOW_OPT_LEVEL=3 FLOW_BUILD_ROOT="$build_root" FLOW_CFLAGS="$cflags" flow compile ui/server.flow
# Workers park sooner under the viewer: while the browser decodes and draws
# a frame, spinning workers would take cores from it. Measured 1.5 to 1.7
# times more iterations per second than serial with this budget.
export EMBRYO_POOL_SPINS="${EMBRYO_POOL_SPINS:-20000}"
exec "$build_root/server"
