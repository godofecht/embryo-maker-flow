#!/bin/sh
# GPU lowering pipeline.
#
#   gpu/kernels/neighbor_prefilter.flow      @gpu kernel -> build/gpu/neighbor_prefilter.metal (flow gpu)
#   gpu/metal/softdouble.metal               software IEEE binary64 for Metal
#   gpu/metal/force_pairs.metal              pair forces, templated: float32 preview and exact binary64
#     -> native/embryo_metal_*.h             tools/gen_metal_header.py (embedded sources)
#     -> native/embryo_metal.m               Metal host, compiled through [native] in flow.toml
#     -> ~/flow/build/embryomaker            flow compile, same binary as the C backend
#
# Modes, through EMBRYO_GPU in the environment of the simulator or the server:
#   exact    Metal candidate prefilter for the box neighbor search (bitwise)
#   preview  prefilter plus float32 pair forces (fast path, diverges from exact)
#   exact64  prefilter plus software binary64 pair forces (bitwise)
#   verify   exact prefilter checked against the serial scan on every call
# Pass --verify to run the binary64 conformance check and the row check,
# and --parity to run tools/backend_parity.sh for exact64 (bitwise) and
# report the preview's deviation.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
out_dir="$repo_dir/build/gpu"
mkdir -p "$out_dir"
parity=0
verify=0
for arg in "$@"; do
    case $arg in
        --parity) parity=1 ;;
        --verify) verify=1 ;;
        *) echo "usage: tools/build-gpu.sh [--verify] [--parity]" >&2; exit 2 ;;
    esac
done

echo "1/4 kernel   gpu/kernels/neighbor_prefilter.flow -> build/gpu/neighbor_prefilter.metal"
flow gpu gpu/kernels/neighbor_prefilter.flow > "$out_dir/flow_gpu.log" 2>&1
cp "$HOME/flow/build/gpu/neighbor_prefilter.metal" "$out_dir/neighbor_prefilter.metal"

echo "2/4 embed    -> native/embryo_metal_kernels.h"
python3 -I tools/gen_metal_header.py native/embryo_metal_kernels.h embryo_metal_neighbor_prefilter_source "$out_dir/neighbor_prefilter.metal"
python3 -I tools/gen_metal_header.py native/embryo_metal_softdouble.h embryo_metal_softdouble_source gpu/metal/softdouble.metal gpu/metal/softdouble_test.metal
python3 -I tools/gen_metal_header.py native/embryo_metal_force.h embryo_metal_force_source gpu/metal/softdouble.metal gpu/metal/force_pairs.metal

echo "3/4 compile  Metal libraries and local GPU archives"
metal_toolchain=${EMBRYO_METAL_TOOLCHAIN:-}
if [ -z "$metal_toolchain" ] && [ -x "$out_dir/toolchain/Metal.xctoolchain/usr/bin/metal" ]; then
    metal_toolchain="$out_dir/toolchain/Metal.xctoolchain"
fi
if [ -z "$metal_toolchain" ]; then
    metal_compiler=$(xcrun --find metal 2>/dev/null || true)
    if [ -n "$metal_compiler" ] && "$metal_compiler" --version >/dev/null 2>&1; then
        metal_toolchain=$(dirname "$(dirname "$(dirname "$metal_compiler")")")
    fi
fi
offline=0
if [ -n "$metal_toolchain" ]; then
    python3 tools/build-metal-offline.py --toolchain "$metal_toolchain" --output "$out_dir/offline" > "$out_dir/offline-build.log" 2>&1
    offline=1
    echo "          offline libraries and archives compiled"
else
    echo "          no offline toolchain found; runtime compilation requires MTLCompilerService"
fi

echo "4/4 build    flow compile src/embryomaker.flow (links native/embryo_metal.m)"
FLOW_OPT_LEVEL=3 FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile src/embryomaker.flow > "$out_dir/build.log" 2>&1
binary="$HOME/flow/build/embryomaker"
ls -la "$binary"
if [ "$offline" = 1 ]; then
    library_dir="$(dirname "$binary")/embryomaker-metal"
    mkdir -p "$library_dir"
    cp "$out_dir/offline/"*.metallib "$out_dir/offline/"*.archive "$out_dir/offline/manifest.json" "$library_dir/"
    export EMBRYO_METAL_LIBRARY_DIR="$library_dir"
    echo "          installed offline assets in $library_dir"
fi

if [ "$verify" = 1 ]; then
    echo "verify   software binary64 against the CPU on 1,000,000 operand pairs"
    FLOW_OPT_LEVEL=3 FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile tools/softdouble_check.flow > "$out_dir/softdouble_build.log" 2>&1
    "$HOME/flow/build/softdouble_check" 1000000
    echo "verify   EMBRYO_GPU=verify on migration and Figure_7A"
    EMBRYO_GPU_REQUIRED=neighbors EMBRYO_GPU=verify "$binary" reference/examples/migration/migration.txt 2000 /dev/null
    EMBRYO_GPU_REQUIRED=neighbors EMBRYO_GPU=verify "$binary" reference/examples/morphospace_exploration/Figure_7A.dat 300 /dev/null
    echo "          rows matched the serial scan"
    echo "verify   EMBRYO_GPU=exact64 phase 1 against the serial forces on Figure_7A"
    EMBRYO_GPU_REQUIRED=forces EMBRYO_GPU=exact64 EMBRYO_PARALLEL_VERIFY=1 "$binary" reference/examples/morphospace_exploration/Figure_7A.dat 60 /dev/null
    echo "          forces matched"
fi
if [ "$parity" = 1 ]; then
    cp "$binary" "$out_dir/embryomaker_gpu"
    echo "parity   EMBRYO_GPU=exact64 against the serial CPU build"
    EMBRYO_GPU_MIN_NODES=0 EMBRYO_GPU_REQUIRED=any EMBRYO_GPU=exact64 EMBRYO_PARITY_REFERENCE="$binary" tools/backend_parity.sh "$out_dir/embryomaker_gpu" gpu_exact64
    echo "preview  deviation from the exact trajectory on Figure_7A (expected to grow)"
    for iterations in 1 10 100 400; do
        EMBRYO_GPU=preview "$binary" reference/examples/morphospace_exploration/Figure_7A.dat $iterations "$out_dir/preview_$iterations.dat" > /dev/null 2>&1
        EMBRYO_THREADS=1 "$binary" reference/examples/morphospace_exploration/Figure_7A.dat $iterations "$out_dir/exact_$iterations.dat" > /dev/null 2>&1
        printf '          %4d iterations: ' $iterations
        "$HOME/flow/build/snapdiff" "$out_dir/exact_$iterations.dat" "$out_dir/preview_$iterations.dat" | tail -n 1
    done
fi
