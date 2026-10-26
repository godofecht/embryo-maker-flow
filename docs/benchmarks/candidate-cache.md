# Production candidate-cache experiment

The optional standard-box cache is selected with `EMBRYO_CANDIDATES=1`.
`EMBRYO_CANDIDATE_STATS=1` reports builds, reuse calls, and bypasses.
The default remains the ordinary box scan.

The cache stores candidates inside the contact radius plus a buffer. Both
endpoint displacement and radius growth consume the buffer. Before scanning,
candidates are filtered to the current 27 boxes and sorted in the original
z, y, x, descending-node order. Flow performs the shared binary64 contact
calculation. Three short cache lifetimes trigger a 32-call cooldown.

The initial experiment compared the saved pre-cache executable with the
shared-scan executable on an M4 Max using eight threads. Three paired runs
alternated execution order. All six final snapshot pairs were byte-identical.

| Input | Steps | Baseline median | Cache median | Cache behavior |
| --- | ---: | ---: | ---: | --- |
| Initial Sea urchin | 40 | 1.734 s | 1.919 s | 2 builds, 38 reuses |
| Saved 10,000-step Sea urchin | 20 | 7.342 s | 7.259 s | 3 builds, 17 bypasses |

These are exploratory timings. Another parity job overlapped the final late
pair. The late result is too small to establish a speedup. The initial result
is slower despite frequent reuse. The earlier 1.2x to 1.5x whole-simulation
estimate remains unsupported. The 10,000-step run has not been repeated.

All 19 bundled examples matched the pre-cache executable byte for byte at
the full step counts in `tools/backend_parity.sh`, after an initial run with
a 100-step cap. Sea urchin uses 100 steps in that suite. The production
cache also passed 400 synthetic frames under AddressSanitizer and UBSan,
checking ordered contacts against an independent box scan, radius growth,
node-count changes, movement, cooldown, and reset.

Artifacts: `build/candidate-reuse/`, `build/parity/candidates100/`, and `build/parity/candidates_full/`.
The cache test is `tests/test_candidate_cache.c`.

## Shared scan with caching disabled

A separate three-pair run, with no overlapping validation job, measured the
shared Flow contact function against the pre-cache executable:

| Input | Baseline median | Shared scan median |
| --- | ---: | ---: |
| Initial Sea urchin, 40 steps | 1.719 s | 1.590 s |
| Saved 10,000-step Sea urchin, 20 steps | 7.135 s | 7.096 s |

All six snapshot pairs were byte-identical. This suggests an improvement in
the initial section. The late difference is small. These samples do not
establish a whole-run speedup. Raw timings are in
`build/candidate-reuse/default-timings.jsonl`.

The final default-path build, including the adaptive cache-scope cleanup,
also passed all 19 bundled comparisons at the suite's full step counts.
Results: `build/candidate-reuse/scope-parity.log`. A separate two-step run
with `function_12=1` exercised adaptive integration and matched the preceding
build byte for byte. This exercises successful scope cleanup; allocation and
force-failure exits were not injected.
