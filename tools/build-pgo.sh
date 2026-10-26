#!/bin/sh
# Profile guided build of the headless simulator.
#
# 1. Compile src/embryomaker.flow with clang instrumentation.
# 2. Run short training simulations over bundled examples that cover the box
#    grid, triangulation, growth, apoptosis, and ECM paths.
# 3. Merge the counters into build/pgo/embryomaker.profdata.
# 4. Recompile with that profile. tools/run-ui.sh reuses the same profile for
#    ui/server.flow, since both programs share the simulation modules.
#
# The profile only changes code layout and inlining. Floating point results
# are unchanged; the parity harness compares snapshots bitwise either way.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
profile_dir="$repo_dir/build/pgo"
examples="$repo_dir/reference/examples"
build_root=${FLOW_BUILD_ROOT:-"$HOME/flow/build"}
cc=${CC:-clang}

if ! command -v "$cc" >/dev/null 2>&1; then
    printf 'Profile guided builds require clang. Compiler not found: %s\n' "$cc" >&2
    exit 1
fi

if command -v llvm-profdata >/dev/null 2>&1; then
    profdata=$(command -v llvm-profdata)
elif command -v xcrun >/dev/null 2>&1; then
    profdata=$(xcrun --find llvm-profdata)
else
    printf 'Profile guided builds require llvm-profdata.\n' >&2
    exit 1
fi

mkdir -p "$profile_dir"
rm -f "$profile_dir"/*.profraw

export FLOW_OPT_LEVEL=3
export CC="$cc"
export FLOW_BUILD_ROOT="$build_root"
FLOW_CFLAGS="-ffp-contract=off -fprofile-instr-generate" flow compile src/embryomaker.flow
binary="$build_root/embryomaker"

train() {
    LLVM_PROFILE_FILE="$profile_dir/%p.profraw" "$binary" "$1" "$2" /dev/null > /dev/null
}
train "$examples/migration/migration.txt" 4000
train "$examples/apoptosis/apoptosis.txt" 1500
train "$examples/differential_adhesion/differential_adhesion.txt" 1500
train "$examples/ecm_secretion/ecm_secretion.txt" 400
train "$examples/polar_growth/polar_growth.txt" 1500
train "$examples/apical_contraction/apical_contraction.txt" 100
train "$examples/sea_urchin_gastrulation/sea_urchin.txt" 20
train "$examples/morphospace_exploration/Figure_7A.dat" 600
train "$examples/morphospace_exploration/Figure_4D.dat" 600

"$profdata" merge -output="$profile_dir/embryomaker.profdata" "$profile_dir"/*.profraw
rm -f "$profile_dir"/*.profraw

FLOW_CFLAGS="-ffp-contract=off -fprofile-instr-use=$profile_dir/embryomaker.profdata -Wno-profile-instr-out-of-date -Wno-profile-instr-unprofiled" flow compile src/embryomaker.flow
printf 'Profile written to %s\n' "$profile_dir/embryomaker.profdata"
