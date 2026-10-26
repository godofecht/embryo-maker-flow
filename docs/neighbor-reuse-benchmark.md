# Neighbor candidate reuse benchmark

The small test is 512 cells in an 8 by 8 by 8 periodic box. Each cell moves a short random distance per step. The contact cutoff is 1.15 cell spacings.

The baseline rebuilds a linked-cell grid every step. The alternative stores candidate pairs within 1.45 spacings and checks their current distance each step. It rebuilds before any cell moves 0.15 spacings from its saved position. Tracking both endpoints bounds the possible change in pair separation.

## Results at 512 cells

Single CPU thread on an Apple M4 Max. Each result is the median of five runs of 300 steps. Trajectory generation and verification are outside the timing. Both methods include their grid construction, distance checks and output writes.

| Maximum movement per axis per step | Grid, ms/step | Reuse, ms/step | Speedup | Rebuilds |
| ---: | ---: | ---: | ---: | ---: |
| 0.01 | 0.1274 | 0.0198 | 6.42x | 8/300 |
| 0.08 | 0.2232 | 0.1727 | 1.29x | 150/300 |
| 0.20 | 0.2531 | 0.3521 | 0.72x | 300/300 |

Small movements amortize the candidate rebuild. Rebuilding every step makes the wider candidate search more expensive than the baseline. An integrated implementation should select the strategy from measured rebuild frequency.

## Scaling

The same experiment runs at 64, 216, 512, 1000, 1728 and 4096 cells. The domain volume grows with cell count. Periodic boundaries keep density at one cell per unit volume throughout each trajectory. Cutoff, safety margin and movement amplitudes stay fixed.

Both methods have expected linear work in cell count for this fixed-density distribution. Candidate reuse aims to reduce the work per cell. Finite grids, cache effects and timing noise affect the fitted exponents. The measured small-movement exponents across these six sizes are:

- Grid: 1.05.
- Reuse: 1.12.

## Correctness and scope

Every one of 27,000 frames compared canonical edge IDs and bitwise squared distances. The 64-cell and 216-cell cases also checked an independent all-pairs oracle on all 9000 frames. Separate checks cover two approaching endpoints and movement across a periodic seam. The full matrix passed AddressSanitizer and UndefinedBehaviorSanitizer.

This is an isolated C benchmark for the proposed algorithm. The application remains unchanged. It has fixed interaction radii and cell counts. Integration must handle changing radii, division and deletion, and preserve production neighbor order before full trajectory parity can be claimed. These timings measure neighbor search only.

## Reproduce

```sh
python3 tools/benchmark-neighbor-reuse.py
```

The script compiles the prototype and writes CSV, JSON and a report under `build/neighbor-scaling`. The CSV pair-distance counters exclude displacement checks; the measured reuse time includes them.

[Raw measurements](benchmarks/neighbor-reuse-scaling.csv) and [summary with build metadata](benchmarks/neighbor-reuse-scaling.json).
