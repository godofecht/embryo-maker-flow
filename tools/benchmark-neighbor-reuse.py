#!/usr/bin/env python3
"""Build and measure fixed-density neighbor search with candidate reuse."""
import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import statistics
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'build/neighbor-scaling')
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    source = ROOT / 'tools/neighbor_reuse_bench.c'
    binary = output / 'bench'
    compiler = os.environ.get('CC', 'cc')
    command = [compiler, '-O3', '-std=c11', '-Wall', '-Wextra', '-ffp-contract=off', str(source), '-lm', '-o', str(binary)]
    with (output / 'build.log').open('w') as log:
        subprocess.run(command, stdout=log, stderr=log, check=True)
    run = subprocess.run([str(binary)], text=True, capture_output=True)
    (output / 'errors.log').write_text(run.stderr)
    if run.returncode:
        raise RuntimeError(f'Benchmark failed: {run.stderr}')
    rows = list(csv.DictReader(io.StringIO(run.stdout)))
    sizes = [64, 216, 512, 1000, 1728, 4096]
    motions = [0.01, 0.08, 0.20]
    expected = {(n, m, r) for n in sizes for m in motions for r in range(5)}
    observed = {(int(r['cells']), float(r['motion']), int(r['repeat'])) for r in rows}
    if len(rows) != len(expected) or observed != expected or any(int(r['steps']) != 300 for r in rows):
        raise RuntimeError('Incomplete benchmark matrix')
    summary = []
    for motion in motions:
        for n in sizes:
            group = [r for r in rows if int(r['cells']) == n and float(r['motion']) == motion]
            grid = statistics.median(float(r['grid_seconds']) for r in group)
            reuse = statistics.median(float(r['reuse_seconds']) for r in group)
            if not all(math.isfinite(t) and t > 0 for t in (grid, reuse)):
                raise RuntimeError('Invalid timing')
            summary.append(dict(cells=n, motion=motion, grid_ms_per_step=grid*1000/300,
                                reuse_ms_per_step=reuse*1000/300, speedup=grid/reuse,
                                rebuilds=int(group[0]['rebuilds']), steps=300,
                                grid_distance_checks=int(group[0]['grid_checks']),
                                reuse_distance_checks=int(group[0]['reuse_checks'])))
    report = dict(machine=platform.machine(), system=platform.system(),
                  compiler=subprocess.check_output([compiler, '--version'], text=True).splitlines()[0],
                  source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
                  frames_checked=len(rows)*300, oracle_frames_checked=2*len(motions)*5*300,
                  setup=dict(density=1, cutoff=1.15, skin=0.3, boundaries='periodic',
                             seed=1234567, repetitions=5, steps=300, threads=1),
                  notes=['Median wall times exclude trajectory generation, sorting and validation.',
                         'Both methods use cell grids. The cache includes its displacement checks and rebuilds.',
                         'Every frame checks canonical edge IDs and bitwise squared distances.',
                         'Sizes 64 and 216 also check an independent all-pairs oracle on every frame.',
                         'Boundary tests cover approaching endpoints and a periodic seam.',
                         'This prototype measures graph equality. Production neighbor order and trajectory parity require separate verification.'],
                  summary=summary)
    # Fit observed timings across this finite size range.
    report['empirical_exponents'] = {}
    for motion in motions:
        group = [r for r in summary if r['motion'] == motion]
        xs = [math.log(r['cells']) for r in group]
        xbar = statistics.mean(xs)
        values = {}
        for name in ('grid_ms_per_step', 'reuse_ms_per_step'):
            ys = [math.log(r[name]) for r in group]
            ybar = statistics.mean(ys)
            values[name] = sum((x-xbar)*(y-ybar) for x,y in zip(xs,ys))/sum((x-xbar)**2 for x in xs)
        report['empirical_exponents'][str(motion)] = values
    (output / 'results.csv').write_text(run.stdout)
    (output / 'results.json').write_text(json.dumps(report, indent=2)+'\n')
    lines = ['# Neighbor candidate reuse', '',
             'Fixed density, periodic boundaries, one CPU thread. Medians of five runs at 300 steps.', '',
             '| Movement per axis | Cells | Rebuild each step, ms | Reuse, ms | Speedup | Cache rebuilds |',
             '| ---: | ---: | ---: | ---: | ---: | ---: |']
    for r in summary:
        lines.append(f"| {r['motion']:.2f} | {r['cells']} | {r['grid_ms_per_step']:.4f} | {r['reuse_ms_per_step']:.4f} | {r['speedup']:.2f}x | {r['rebuilds']}/300 |")
    lines += ['', 'All 27,000 frames matched. An independent all-pairs oracle checked 9,000 small frames.',
              'These are neighbor-search timings. Full simulation speedup has not been measured.', '']
    (output / 'report.md').write_text('\n'.join(lines))
    print('\n'.join(lines))


if __name__ == '__main__':
    main()
