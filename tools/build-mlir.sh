#!/bin/sh
# MLIR lowering pipeline for the headless simulator.
#
#   src/embryomaker.flow
#     -> build/mlir/embryomaker.mlir          flowc MLIR emission (flow flow-to-mlir)
#     -> build/mlir/embryomaker.unfused.mlir  fused multiply-add split (tools/mlir_unfuse.py)
#     -> build/mlir/embryomaker.opt.mlir      mlir-opt pass pipeline, when MLIR_OPT_LEVEL is set
#     -> build/mlir/embryomaker.ll            mlir-opt lowering + mlir-translate (flow mlir-lower)
#     -> build/mlir/embryomaker               clang link against the Flow runtime archive
#
# `flow compile --backend=mlir` runs the same emission and lowering, but its
# emitter contracts a * b + c into one fused op, which the C build turns off
# with -ffp-contract=off. The unfuse step restores separate operations so the
# MLIR binary stays within the snapshot tolerance of the C build. Pass
# --parity to run tools/backend_parity.sh on the result.
#
# Requirements: Homebrew LLVM (mlir-opt, mlir-translate, and a clang that
# reads the emitted LLVM IR). Apple clang rejects that IR's newer syntax.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_dir"
out_dir="$repo_dir/build/mlir"
mkdir -p "$out_dir"
parity=0
for arg in "$@"; do
    case $arg in
        --parity) parity=1 ;;
        *) echo "usage: tools/build-mlir.sh [--parity]" >&2; exit 2 ;;
    esac
done

llvm_prefix=${LLVM_PATH:-$(brew --prefix llvm 2>/dev/null || echo /opt/homebrew/opt/llvm)}
clang_bin="$llvm_prefix/bin/clang"
if [ ! -x "$clang_bin" ]; then
    echo "Homebrew LLVM clang not found at $clang_bin (brew install llvm, or set LLVM_PATH)" >&2
    exit 1
fi

echo "1/5 emit     src/embryomaker.flow -> build/mlir/embryomaker.mlir"
flow flow-to-mlir --lenient src/embryomaker.flow "$out_dir/embryomaker.mlir"

echo "2/5 unfuse   build/mlir/embryomaker.unfused.mlir"
python3 -I tools/mlir_unfuse.py "$out_dir/embryomaker.mlir" "$out_dir/embryomaker.unfused.mlir"

lowered_input="$out_dir/embryomaker.unfused.mlir"
if [ -n "${MLIR_OPT_LEVEL:-}" ]; then
    echo "3/5 optimise mlir-opt pipeline at $MLIR_OPT_LEVEL -> build/mlir/embryomaker.opt.mlir"
    flow mlir-optimize --opt-level "$MLIR_OPT_LEVEL" "$lowered_input" "$out_dir/embryomaker.opt.mlir"
    lowered_input="$out_dir/embryomaker.opt.mlir"
else
    echo "3/5 optimise skipped (set MLIR_OPT_LEVEL=O1|O2|O3 to run the mlir-opt pipeline)"
fi

echo "4/5 lower    -> build/mlir/embryomaker.ll"
flow mlir-lower "$lowered_input" "$out_dir/embryomaker.ll"

# The C backend links against a runtime archive under ~/flow/build; its
# directory name hashes the toolchain flags. Build the C reference first so the
# newest archive matches, or set EMBRYO_FLOW_RUNTIME_ARCHIVE.
echo "5/5 link     -> build/mlir/embryomaker"
FLOW_OPT_LEVEL=3 FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile src/embryomaker.flow > "$out_dir/c_reference_build.log" 2>&1
runtime_archive=${EMBRYO_FLOW_RUNTIME_ARCHIVE:-$(ls -t "$HOME"/flow/build/flowc_runtime/*/libflowrt.a | head -n 1)}
"$clang_bin" -O2 -w -Wno-override-module -ffp-contract=off -I"$HOME/flow/runtime" \
    -o "$out_dir/embryomaker" "$out_dir/embryomaker.ll" "$HOME/flow/build/embryomaker.mlir.c" \
    "$runtime_archive" -pthread -lm
ls -la "$out_dir/embryomaker"

if [ "$parity" = 1 ]; then
    EMBRYO_PARITY_REFERENCE="$HOME/flow/build/embryomaker" tools/backend_parity.sh "$out_dir/embryomaker" mlir
fi
