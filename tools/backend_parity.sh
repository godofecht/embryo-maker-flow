#!/bin/sh
# Compare a simulator binary against the C reference build on every bundled
# example: bitwise snapshot equality, the snapdiff tolerance report for any
# snapshot that differs, and wall time for both.
#
# usage: tools/backend_parity.sh <candidate-binary> [tag]
#
# The reference is built from src/embryomaker.flow with the C backend at -O3
# and -ffp-contract=off into build/parity/embryomaker_c. Set
# EMBRYO_PARITY_REFERENCE to reuse a binary instead. Environment variables
# such as EMBRYO_GPU=exact64 or EMBRYO_THREADS=8 reach the candidate only; the
# reference always runs serial on the CPU (EMBRYO_THREADS=1, no EMBRYO_GPU).
# Snapshots and timings land in build/parity/<tag>/.
set -u

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
candidate=${1:-}
tag=${2:-candidate}
if [ -z "$candidate" ] || [ ! -x "$candidate" ]; then
    echo "usage: tools/backend_parity.sh <candidate-binary> [tag]" >&2
    exit 2
fi
case $candidate in /*) ;; *) candidate="$PWD/$candidate" ;; esac
cd "$repo_dir"
examples="$repo_dir/reference/examples"
out_dir="$repo_dir/build/parity"
mkdir -p "$out_dir/$tag"

reference=${EMBRYO_PARITY_REFERENCE:-}
if [ -z "$reference" ]; then
    FLOW_OPT_LEVEL=3 FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile src/embryomaker.flow > "$out_dir/reference_build.log" 2>&1 || {
        echo "reference build failed, see $out_dir/reference_build.log" >&2
        exit 1
    }
    cp "$HOME/flow/build/embryomaker" "$out_dir/embryomaker_c"
    reference="$out_dir/embryomaker_c"
fi
FLOW_CFLAGS="${FLOW_CFLAGS:+$FLOW_CFLAGS }-ffp-contract=off" flow compile tools/snapdiff.flow > "$out_dir/snapdiff_build.log" 2>&1 || {
    echo "snapdiff build failed, see $out_dir/snapdiff_build.log" >&2
    exit 1
}
snapdiff="$HOME/flow/build/snapdiff"

now() { python3 -I -c 'import time; print(time.time())'; }
max_steps=${EMBRYO_PARITY_MAX_STEPS:-2147483647}
case $max_steps in ''|*[!0-9]*) echo "EMBRYO_PARITY_MAX_STEPS must be a positive integer" >&2; exit 2 ;; esac
if [ "$max_steps" -lt 1 ]; then echo "EMBRYO_PARITY_MAX_STEPS must be positive" >&2; exit 2; fi
status=0
printf '%-24s %6s %10s %10s  %s\n' example iters reference "$tag" result
run_case() {
    name=$1; input=$2; iters=$3
    if [ "$iters" -gt "$max_steps" ]; then iters=$max_steps; fi
    ref_out="$out_dir/$tag/${name}_reference.dat"
    cand_out="$out_dir/$tag/${name}_${tag}.dat"
    t0=$(now)
    env -u EMBRYO_GPU -u EMBRYO_GPU_REQUIRED EMBRYO_THREADS=1 "$reference" "$input" "$iters" "$ref_out" > "$out_dir/$tag/${name}_reference.log" 2>&1
    ref_rc=$?
    t1=$(now)
    "$candidate" "$input" "$iters" "$cand_out" > "$out_dir/$tag/${name}_${tag}.log" 2>&1
    cand_rc=$?
    t2=$(now)
    ref_time=$(python3 -I -c "print(f'{$t1 - $t0:.3f}s')")
    cand_time=$(python3 -I -c "print(f'{$t2 - $t1:.3f}s')")
    if [ "$ref_rc" != 0 ] || [ "$cand_rc" != 0 ]; then
        verdict="EXIT reference=$ref_rc $tag=$cand_rc"
        status=1
    elif cmp -s "$ref_out" "$cand_out"; then
        verdict=BITWISE
    else
        if "$snapdiff" "$ref_out" "$cand_out" > "$out_dir/$tag/${name}_snapdiff.txt" 2>&1; then
            status=1
            verdict="WITHIN-TOLERANCE ($(grep -c . "$out_dir/$tag/${name}_snapdiff.txt") lines)"
        else
            verdict="DIFFERS see build/parity/$tag/${name}_snapdiff.txt"
            status=1
        fi
    fi
    printf '%-24s %6s %10s %10s  %s\n' "$name" "$iters" "$ref_time" "$cand_time" "$verdict"
}

run_case migration "$examples/migration/migration.txt" 3000
run_case apoptosis "$examples/apoptosis/apoptosis.txt" 1500
run_case differential_adhesion "$examples/differential_adhesion/differential_adhesion.txt" 1500
run_case ecm_secretion "$examples/ecm_secretion/ecm_secretion.txt" 1500
run_case polar_growth "$examples/polar_growth/polar_growth.txt" 1500
run_case apical_contraction "$examples/apical_contraction/apical_contraction.txt" 300
run_case figure_6 "$examples/figure_6/gastrula.txt" 100
run_case sea_urchin "$examples/sea_urchin_gastrulation/sea_urchin.txt" 100
run_case blastula "$examples/blastula-like_initial_conditions/Epithelial_blastula.dat" 400
run_case blastula_mesenchyme "$examples/blastula-like_initial_conditions/Epithelial_blastula_filled_with_mesenchyme.dat" 400
for figure in 4D 4E 4F 7A 7B 7C 7D 7E 7F; do
    run_case "figure_$figure" "$examples/morphospace_exploration/Figure_$figure.dat" 400
done
exit $status
