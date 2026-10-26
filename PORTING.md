# Porting EmbryoMaker to Flow

This file is the contract every porter follows. Read it before writing code.

Follow [the Flow idiom guideline](FLOW_IDIOMS.md) when choosing Flow
constructs. The [reduction stages](docs/flow-idioms.md) record how the port
has reduced scaffolding while preserving simulator behavior.

## Source and scope

- Original: https://github.com/HugoCanoFernandez/EmbryoMaker at commit
  `9d1224d2bad430edce11505b448a749b64520362`, copied to `reference/`.
- Fortran sources: `reference/fortran/src/`. Examples: `reference/examples/`.
- Scope: the simulator, command-line drivers, and browser UI. Read EmbryoMaker
  input files, run the Node Model and gene network, write original `.dat`
  snapshots, and match the original drawer and editor behavior in `ui/` and
  `src/editor.flow`. Use the Fortran OpenGL drawer as the rendering reference.
- The original window setup in `elli.f90` enables depth testing and fixed
  function lighting. `GL_LIGHT0` has white diffuse light at `(1.5, -0.5, 2.0)`
  and the global ambient term is `(0.5, 0.5, 0.5)`. The drawer sets node
  materials through `GL_AMBIENT_AND_DIFFUSE`; the renderer must shade its
  geometry with transformed normals. The original setup does not enable
  normal normalization. Transparent sphere display radii use
  `smax_scale * normalized_value * 0.1`. The drawer scales sphere coordinates
  before model-view transforms, so sphere normals keep the rotation-only scale.
  The Flow renderer compensates for its model-view scene scale on sphere paths.
- The reference `config_file.txt` starts at translation `(0, 0, -12)`, with
  model rotations `(0, 135)` degrees and a 10 degree perspective field of
  view. The browser renderer uses those display defaults.
- Out of scope: NetworkMaker GTK GUI, `ic.mod.f90` presets (`default_ic`),
  gnuplot output, and evolution or ensemble filters that shell out. Unsupported
  simulation configurations must return an error to the caller. They must not
  terminate the long-lived browser server.

## Reference binary

```
make -C reference/fortran            # builds reference/fortran/build/emaker_ref
cd <run dir> && emaker_ref <input.txt> 1 <time_per_snapshot> <snapshots>
```

`reference/fortran/src/headless.f90` is the only added Fortran file. It runs
the `aut=1` path of `elli.f90` without OpenGL.

## Toolchain

- Flow 2.0.0 at `~/flow`, CLI `flow` (host `flowc`). `println` works on flowc.
- Read `~/flow-skills/AGENTS.md` and `~/flow-skills/references/syntax-card.md`.
  They say `println` needs the Python host. That is stale: the Python host is
  gone and flowc handles `println`.
- Verify syntax against `~/flow/tests/lang/` and `~/flow/examples/` when unsure.
- `flow compile` and `flow run` write `<basename>.c` and the binary into
  `~/flow/build/`. Several porters run at once, so every entry file must have a
  unique basename (`tests/test_<module>.flow`, never `main.flow`).
- Build for parity with `FLOW_CFLAGS="-ffp-contract=off"`. The reference is
  built with `-ffp-contract=off` as well. Fused multiply-add changes the last
  bits and breaks bitwise comparison.
- When Flow cannot express something, work around it and record the gap in
  this file with the affected source path.

## Apple acceleration

The simulation keeps its `f64` state and adaptive RK stages on the CPU. MLX
supports `float64` arrays on CPU operations, while its GPU backend does not
support `float64` arrays. Flow also emits native Metal compute kernels, with
GPU buffers for `f32`, `f16`, and integer data. Moving the parity-sensitive
solver to either GPU path would require changing its precision or its ordered
pair-force updates. Keep those calculations on the CPU. See the
[MLX data type reference](https://ml-explore.github.io/mlx/build/html/python/data_types.html)
and Flow's `docs/library/gpu-tensor.md`.

The browser renderer uses WebGL, requests a high performance adapter, and
uses `ANGLE_instanced_arrays` when available. Chrome selects the WebGL backend.
On the M4 Max, a direct browser check selected ANGLE's Metal renderer. The
renderer records the WebGL renderer string in its frame diagnostics when the
browser exposes it. Set
`UI_SMOKE_METAL=1` to require ANGLE Metal in the browser smoke run. Ordinary
headless runs may select SwiftShader, so they check drawing behavior and WebGL
errors without proving Metal selection.

### CPU profile and measured changes (2026-10-20, M4 Max)

Serial cost per model iteration with the C backend at `-O3`:

| Example | Nodes | Genes | Per iteration |
| --- | ---: | ---: | ---: |
| migration | 364 | 3 | 0.16 ms |
| Figure_7A (morphospace) | 1144 | 22 | 1.2 ms |
| ecm_secretion | 1073 | 4 | 1.6 ms |
| apical_contraction (triangulation) | 1274 | 2 | 12 ms |
| sea_urchin (triangulation) | 3534 | 5 | 59 ms |

Sampled time on the box grid examples sits in `neighbor_build` (30 to 40
percent), `forces` (25 to 35 percent) and `genestep` (8 to 20 percent). The
ECM example spends a third of its time in `diffusion_apply_prepared`, because
`update_node_properties` runs one diffusion sweep per epithelial node, as the
Fortran does. The triangulation examples add `restore_neighbors`,
`sync_old_neighbor_row`, `neighbor_build_node` and `energia`.

Compiler flags, all producing bitwise identical snapshots on 19 inputs:
`-mcpu=apple-m4`, `-mcpu=native` and `-flto` changed nothing measurable.
Homebrew clang 22 was about 5 percent faster than Apple clang 17.
Profile guided optimisation gave 15 percent on the previous source and 2 to
10 percent on the current source. `tools/build-pgo.sh` trains a profile on
the bundled examples and writes `build/pgo/embryomaker.profdata`;
`tools/run-ui.sh` reuses that file when it exists. The profile changes code
layout and inlining only, and the parity harness confirms the output.

Source changes kept, each verified bitwise identical on all 19 inputs and
timed back to back against the previous build:

- `neighbor_build`: the candidate scan reads scalar globals through locals,
  tests the distance before the layer types, and writes the row count once.
  13 to 17 percent on the box grid examples.
- `forces`: the twelve pair accumulators are one row per node, so a scatter
  into the partner touches adjacent cache lines. `px`, `py` and `pz` are
  cleared only in the uncapped adhesion mode, and the display vectors are
  zeroed per fixed node instead of twelve bulk clears per call. A further
  10 to 20 percent.
- `genestep`: neighbor facts and the `1 / (1 + distance)` factor are gathered
  once per node and shared by every gene. Neutral with 3 to 5 genes, 4 percent
  with 22 genes.
- `diffusion_apply_prepared`: a packed copy of `grd` persists across the
  sweeps of one iteration; callers pass the two ids they changed. 19 percent
  on ecm_secretion, 5 percent on sea_urchin.

Changes measured slower and removed: per-axis early exits in the neighbor
scan (40 percent slower on migration, the extra branches mispredict), and a
packed copy of the hot node fields refreshed at each force and neighbor call
(5 percent slower, the refresh costs more than the record reads save). The
node records stay in L2 on this machine, so the remaining cost is instruction
count and dependent loads rather than cache misses.

### Worker pool and deterministic parallel passes

Flow's `parallel for` lowers to OpenMP only when the toolchain probe links
`-fopenmp`. Apple clang 17 rejects that flag, and the
`-Xpreprocessor -fopenmp -lomp` form only links when Homebrew libomp is on
the library path, so on this machine the probe fails and `parallel for` falls
back to `flow_parallel_for_i32`, which creates and joins one pthread per
worker on every call. That was the build measured at 15.94 seconds against
9.23 serial.

`native/embryo_pool.c` is the replacement: persistent workers that spin for
the next job and park after a few milliseconds, one atomic counter handing
out index ranges, and the calling thread working as thread 0. A fork and
join costs 3 microseconds with 8 threads (`EMBRYO_POOL_SPINS` sets the spin
budget). Jobs call `embryo_parallel_entry` in `src/workers.flow`, registered
at start by `parallel_init`, which dispatches to a range body in the owning
module. `EMBRYO_THREADS` sets the count (default: performance cores minus
two, 8 here; 1 keeps everything serial) and `EMBRYO_PARALLEL_MIN_NODES`
(default 512) keeps small models serial. `EMBRYO_PARALLEL_STATS=1` prints
wall time per pass at exit.

Four passes run on the pool, each bitwise equal to its serial form:

- `neighbor_scan_range`: the box candidate scan, one node per thread, rows
  written in place.
- `genestep_range`: gene derivatives, with per-thread neighbor scratch.
- `force_pairs_range` and `force_reduce_range`: the pair forces in two
  phases. The serial routine updates both ends of a pair when it visits the
  pair from its lower index (or from the moving node when the partner is
  fixed), so a node's sums form in a fixed order: partner terms from lower
  ids ascending, its own pairs in column order, then partner terms from
  higher ids (fixed nodes only). Phase 1 computes every pair term in
  parallel and writes it twice, into the visiting node's row and into the
  partner's row at the partner's column; phase 2 replays each node's terms
  in that order. Generation stamps replace per-call clearing, and the
  partner column is cached and checked before use.

`EMBRYO_PARALLEL_VERIFY=1` runs the serial force routine after every
parallel or GPU call and compares px, py, pz, dex, fmeanl, fmeanv and every
dneigh row; a difference stops the run. It caught two ordering mistakes
during development. `tools/backend_parity.sh` runs the reference serial and
compares snapshots bitwise, which all 19 inputs pass with 8 threads.

Measured headless, best of three, other apps running (M4 Max, 8 threads):

| Input | Nodes | Start of day | Serial now | 8 threads | GPU exact64 | GPU preview |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Figure_7A, 400 it | 1144 | 0.56 s | 0.44 s | 0.21 s | 3.60 s | 1.04 s |
| blastula with mesenchyme, 400 it | 1144 | 0.45 s | 0.36 s | 0.19 s | 3.32 s | 1.24 s |
| ecm_secretion, 300 it | 1073 | 0.58 s | 0.50 s | 0.34 s | 5.55 s | 2.12 s |
| apical_contraction, 100 it | 1274 | 0.89 s | 0.85 s | 0.79 s | 2.66 s | 1.31 s |
| sea_urchin, 40 it | 3534 | 2.61 s | 2.45 s | 2.31 s | 8.52 s | 3.16 s |
| migration, 3000 it | 364 | 0.62 s | 0.50 s | 0.52 s | serial | serial |

The box grid inputs run 2.7 times faster than at the start of the day and
2.1 times faster than serial. On Figure_7A the pool passes take about 120
of the 210 ms (neighbor scan 57 us per call, gene step 45, force pairs
17, force reduce 21). The rest is serial by the model's structure: growth,
noise, cell behaviours, the Runge-Kutta position loops and the
per-iteration bookkeeping, each a few percent. Two serial costs were
removed on the way: node buffers now grow geometrically instead of ten
slots at a time (a full copy of every buffer was 12 percent of an
iteration), and the neighbor table is no longer cleared on every build
(another 12 percent at a 540 column stride). The triangulation inputs gain
little, apical contraction 7 percent and sea urchin 6 percent, because
their time is in `restore_neighbors`, the Delaunay rebuild and the energy
routine, which are sequential in the reference. The ECM input is bounded
by its per-node diffusion sweeps, which are sequential by construction.
The Delaunay face and boundary tables now start at capacities estimated from
the point count. This avoids repeated growth and copying on every rebuild. In
three 40-iteration Sea urchin runs, median time fell from 2.65 to 2.48 seconds
serial and from 2.20 to 2.06 seconds with eight threads. All six resulting
snapshots matched their corresponding baseline bitwise.
The saved neighbor graph also reuses its buffers between rebuilds. Its row
counts reset each iteration, and active entries are rewritten in place. On
the same input, median time fell from 2.48 to 2.35 seconds serial and from
2.06 to 1.92 seconds with eight threads. Three snapshots per mode remained
bitwise identical.

The CPU box scan now copies positions and contact radii into a compact
read-only buffer before dispatch. Candidate traversal and floating-point
operation order stay unchanged. Three paired Sea urchin runs at 40 iterations
measured median serial times of 2.515 seconds before and 2.441 seconds after.
Eight-thread medians were 1.976 and 1.975 seconds. This is a small serial gain;
the threaded result is within timing noise. All six snapshots matched bitwise.
The complete 19-example suite also matched bitwise against the saved serial
baseline with the candidate using eight threads.

The candidate reuse cache is enabled by default in `native/embryo_candidates.c`.
Candidate sets up to 32 items use an inlined insertion sort with the box
ordering comparator, avoiding indirect function calls from `qsort`.
In `src/neighboring.flow`, `grow_neighbor_buffers` and `ensure_old_neighbor_capacity`
copy active rows using `memcpy`. `restore_neighbors` skips mutual-link checks
when fewer than two shared neighbors exist.
In `src/nexus.flow`, `diffusion_apply_prepared` writes intermediate sweeps
into the packed field buffer and updates `node[i].grd` only for touched nodes,
flushing all nodes in one pass at the exit of `update_node_properties`.
`src/dynamics.flow` declares continuous dynamics through native Flow `flow`
blocks with compiler-generated RK4 integrators, verified in
`tests/test_flow_dynamics.flow`. All 19 benchmark inputs retain bitwise parity.

### Dynamic 3D Delaunay update experiment

`native/delaunay_update_cgal.cpp` is an isolated CGAL moving-vertex prototype.
It remains outside the simulator. Generate raw geometry with
`tools/delaunay_trace.flow`, then compare it using
`tools/cgal_dynamic_parity.py --library <shared-library> --trace-prefix <prefix> --steps <count>`.
The checker compares raw Flow edges, fresh CGAL edges and moving CGAL edges
at identical coordinates. Missing frames, invalid updates and mismatches fail
the check. Edge equality alone does not establish force or trajectory parity.

The earlier Studio comparison was invalid. Studio displays filtered and
restored neighbors after positions have advanced. Sea urchin also has
`ffu[8] = 0`: it uses box neighbors. Its performance does not depend on the
Delaunay builder. The previous Jaccard measurements cannot establish a
triangulation tie-policy difference.

With the corrected check, moving CGAL matches fresh CGAL on all 41 Sea urchin
frames and all six apical contraction frames. Raw Flow edges match on 16
Sea urchin frames and zero apical frames. The Flow builder fails on 11 and
five frames respectively. Both initial frames differ. These results
keep the CGAL prototype outside the parity-preserving simulation path.
The cause of Flow's differences needs a separate predicate and topology audit.
On Sea urchin, 40 CGAL moves took 1.586 seconds, while 41 fresh builds
took 0.552 seconds. On apical contraction, five moves took 0.110 seconds
and six fresh builds took 0.026 seconds. These measurements exclude validity
checks and edge extraction. Moving every vertex sequentially costs more than
rebuilding on these traces.

The C interface rejects nonfinite coordinates and marks partially failed
updates unusable. Callers must destroy and rebuild failed contexts. Edge
extraction uses finite edges, including lower-dimensional triangulations,
and provides an output-size query.

### GPU verification

`EMBRYO_GPU_REQUIRED=neighbors`, `forces`, or `any` requires completed work
from the selected GPU pass. The CLI returns status 6 when that work did not
execute. `tools/build-gpu.sh` uses this gate for verification and parity.
`tools/backend_parity.sh` requires bitwise snapshot equality; its tolerance
report is diagnostic and a differing snapshot fails.

### Offline Metal compilation

The local MTLCompilerService lookup returns error 141. GPU execution now works
through offline libraries and native GPU binary archives. A `.metallib` alone
still requires driver compilation. The matching archive supplies the compiled
pipeline, and `MTLPipelineOptionFailOnBinaryArchiveMiss` prevents an archive
miss from silently requesting runtime compilation.

`tools/build-metal-offline.py` uses Apple's `metal`, `metallib` and `metal-tt`
tools. It targets the local GPU architecture and macOS version. On this Mac,
the compiler was recovered from an existing cached Metal toolchain image under
`/System/Library/AssetsV2/com_apple_MobileAsset_MetalToolchain/`. Extracting the
image with 7-Zip avoided the failing installer and image-mount services.
The extracted toolchain is in `build/gpu/toolchain/Metal.xctoolchain`.

Run the normal build:

```sh
tools/build-gpu.sh --verify
```

For a toolchain at another location:

```sh
EMBRYO_METAL_TOOLCHAIN=/path/to/Metal.xctoolchain tools/build-gpu.sh --verify
```

The build installs the libraries and archives in `embryomaker-metal` beside
the executable. The runtime finds that directory automatically.
`EMBRYO_METAL_LIBRARY_DIR` can select another directory. Missing or incompatible
explicit assets fail GPU initialization. Rebuild the archives when changing
GPU architecture, target OS or kernel sources. Source compilation remains
available when no offline asset directory is present.

The installed build passed the million-pair binary64 check with zero
mismatches for addition, subtraction, multiplication, division, square root
and comparison. Sea urchin at 40 steps completed 40 GPU neighbor passes and
711 GPU force passes, with a bitwise-identical snapshot. All 19 examples in
the full parity suite matched bitwise with GPU execution required and
`EMBRYO_GPU_MIN_NODES=0`. Each log confirms completed GPU dispatches.
The missing-archive regression returns status 6 under required-GPU mode.

Exact GPU force evaluation is slower on this workload. The full-suite Sea
urchin case at 100 steps took 24.969 seconds on exact GPU mode and 8.052
seconds on the serial reference during concurrent benchmark work. CPU mode
remains the default. The GPU path is available for verification and further
optimization.

### Sea urchin at 10,000 steps

A full eight-thread CPU run completed in 4865.712 seconds, or 81 minutes
6 seconds. The earlier estimate of eight minutes extrapolated from the first
40 steps and was too low. Iteration cost changes substantially during the run.
The first 500 steps took 35.3 seconds; steps 3501 through 4000 took 593.1
seconds; the final 500 took 226.9 seconds.

This run wrote a checkpoint every 500 iterations. Build and GPU verification
work overlapped its early portion, so it is an observed end-to-end duration
rather than an isolated benchmark. Allow roughly 80 minutes for the same
10,000-step run on this machine, with variation from system load.
[Recorded timings](docs/benchmarks/sea-urchin-10000.json) include each checkpoint,
the final node count and binary and snapshot hashes. The final snapshot is
`build/timing/sea.dat` and its iteration field is 10000.

### Neighbor restoration optimization

The slower portion of Sea urchin spends substantial main-thread time in
`restore_neighbors`, including saved-row synchronization during noise updates.
Restoration now collects shared neighbors directly from the existing membership
marks. Saved rows retain their storage when membership and order are unchanged.
Each saved row also keeps its incoming-edge count, maintained through insertion,
removal, capacity growth and node deletion.

Three paired eight-thread runs measured these median times:

| Starting state | Steps | Before | After | Time reduction |
| --- | ---: | ---: | ---: | ---: |
| Initial Sea urchin | 40 | 2.075 s | 1.938 s | 6.6% |
| Sea urchin checkpoint at step 10000 | 20 | 8.436 s | 7.879 s | 6.6% |

All six snapshot pairs were bitwise identical. The full 19-example suite also
matched the saved baseline bitwise. The suite compares the serial baseline
with an eight-thread candidate, so its timings include the existing threading
gain. The paired timings above use eight threads for both binaries.

`tests/test_neighbor_restore_graphs.flow` checks 10,240 graph and row-order
combinations against an independent restoration implementation, including
asymmetric rows. It also checks the saved-prefix invariant after 512 local
rebuilds and three node deletions. The existing restoration fixtures pass.
[Raw paired timings](docs/benchmarks/neighbor-restoration.json) record each run.
The complete 10,000-step duration has not been remeasured after this change.

The 5 times target therefore holds only for the passes themselves; the
remaining serial parts cap the whole iteration near 2 to 2.5 times on the
box grid inputs under the parity contract.

In the viewer on Figure_7A at maximum playback, fresh session each time:
serial 260 to 300 iterations per second, 8 threads 430 to 455, GPU preview
113. The server runs with a short worker spin budget
(`EMBRYO_POOL_SPINS=20000` in `tools/run-ui.sh`); with the headless
default the spinning workers took cores from the browser and threads came
out slower than serial there.

### GPU modes

`EMBRYO_GPU` selects the GPU path; `EMBRYO_GPU_MIN_NODES` (default 1000)
keeps smaller models on the CPU. The viewer switches modes at run time
through `/api/compute` and the Compute select.

| Mode | What runs on the GPU | Result |
| --- | --- | --- |
| `exact` (or `1`) | box neighbor candidate prefilter, float32 with a widened test; CPU repeats the exact test | bitwise |
| `exact64` | prefilter plus the pair forces in software binary64 | bitwise |
| `preview` | prefilter plus the pair forces in float32 | diverges |
| `verify` | exact prefilter checked against the serial scan on every call | check |

Apple GPUs have no double type, so `gpu/metal/softdouble.metal` implements
IEEE 754 binary64 on 64 bit integers: add, sub, mul (128 bit product from
32 bit halves), div (restoring long division) and sqrt (digit by digit on
128 bits), all rounding to nearest even, with subnormals, zeros, infinities
and NaN. `tools/softdouble_check.flow` runs 1,000,000 random operand pairs
drawn from several magnitude ranges through the GPU and the CPU; every
result matches bit for bit.

`gpu/metal/force_pairs.metal` is phase 1 of the two-phase force
computation as a kernel, one thread per node, written once as a template
over the arithmetic type: `float` for the preview and the software double
for `exact64`. It writes the same records the CPU phase 2 replays, through
shared-storage buffers that both sides address without copies
(`embryo_gpu_shared_alloc`). Node fields and compacted neighbor rows go in
by copy, a few hundred kilobytes per call.

Measured on Figure_7A (1144 nodes), one force call: 17 us for the CPU
pool, 363 us for the float32 kernel, 1,266 us for the binary64 kernel.
Most of the float32 time is Metal's command submission and completion
latency; the binary64 kernel is bound by its division and square root
loops. At this model size the GPU modes are slower than the CPU pool; they
are exact (or an honest preview) and they scale with node count, so they
pay only for models well past ten thousand nodes. The preview's deviation
from the exact trajectory on Figure_7A: 5e-8 after one iteration, 2.6e-6
after ten, 0.23 after four hundred, which is the model's own sensitivity to
rounding rather than a defect.


The viewer used to request one iteration per HTTP round trip, with a 140 ms
timer between steps and the whole model as 2.6 MB of JSON per response.
Measured on apical contraction (1274 nodes, 12 ms per solver iteration) that
played at 5.7 iterations per second. The play loop now has four modes in the
speed select: slow (300 ms between single steps), smooth (one iteration per
screen update), fast (batches sized to about 40 ms per request) and maximum
(about 200 ms per request). Batch sizes adapt to the measured time per
iteration. Measured in Chrome on the same input: 19, 34 and 53 iterations
per second for smooth, fast and maximum.

Model responses are a packed frame when the request body carries
`"binary": true`, which `sendSession` in `ui/index.html` always sends. The
layout is documented above `make_model_binary` in `ui/server.flow`: a JSON
header without the node and edge arrays, then little endian f64 and i32
matrices and the edge triples. Figure_7A drops from 2.57 MB of JSON to
0.95 MB, and a single-step request from 6 ms to 3 ms server side, of which
the solver is about 1.2 ms. The JSON form still answers requests without the
flag, so `tools/ui_smoke.cjs` and other callers keep working.

The iteration slider moved from the left panel to a bar across the top of
the model view. It scrubs while dragging, runs the model when the thumb
rests, steps with the arrow keys, and shows the run target as an editable
number. Playback extends that target by half when it reaches it unless the
user typed one.

## MLIR lowering pipeline

`tools/build-mlir.sh` lowers `src/embryomaker.flow` through MLIR and links
`build/mlir/embryomaker`:

1. `flow flow-to-mlir --lenient` writes `build/mlir/embryomaker.mlir`.
2. `tools/mlir_unfuse.py` splits every `llvm.intr.fmuladd` into `llvm.fmul`
   and `llvm.fadd`. flowc contracts `a * b + c` the way clang does with
   contraction on, while the C build runs with `-ffp-contract=off`. Before
   this step every example differed from the C build; the rewrite is exact
   for each form the emitter produces.
3. `flow mlir-optimize --opt-level O1|O2|O3` when `MLIR_OPT_LEVEL` is set.
4. `flow mlir-lower` runs the mlir-opt conversion pipeline and
   `mlir-translate --mlir-to-llvmir`.
5. Homebrew clang links the IR with the Flow runtime archive. Apple clang 17
   rejects the `captures(none)` syntax that LLVM 22 emits.

`tools/build-mlir.sh --parity` runs `tools/backend_parity.sh`, which builds
the C reference, runs both binaries over the 19 bundled inputs, compares the
snapshots bitwise and runs `tools/snapdiff.flow` on any that differ. Result
on this machine: 16 inputs bitwise identical, and migration, differential
adhesion and figure 6 within the 1e-9 tolerance with a largest relative
difference of 5.4e-16 (four node rows in the last bit on migration; the
remaining source has not been isolated). The MLIR binary runs 2 to 10
percent slower than the C build. The MCP tool's `backend: "mlir"` uses this
script.

## GPU lowering pipeline

`tools/build-gpu.sh` lowers the candidate scan of the box neighbor search to
Metal and links it into the ordinary simulator binary:

1. `flow gpu gpu/kernels/neighbor_prefilter.flow` emits the `@gpu` kernel as
   `build/gpu/neighbor_prefilter.metal`.
2. `tools/gen_metal_header.py` embeds that source in
   `native/embryo_metal_kernels.h`.
3. `native/embryo_metal.m` compiles the kernel once, keeps shared-storage
   buffers, and dispatches one thread per node. The `[native]` table in
   `flow.toml` compiles and links it, with the Metal and Foundation
   frameworks, into every build. Other platforms get stubs.
4. `flow compile src/embryomaker.flow` as usual.

The kernel walks the same 27 boxes in the same order as the serial scan,
reading a compressed row copy of the box chains, with single precision and a
contact test widened by 0.1 percent. `neighbor_scan_rows_gpu` in
`src/neighboring.flow` then repeats the exact double precision test on the
survivors in that order, so the neighbor rows match the serial scan bit for
bit. Any kernel failure or row overflow falls back to the serial scan.

`EMBRYO_GPU=1` enables the path for models with at least 1000 nodes
(`EMBRYO_GPU_MIN_NODES` changes the threshold); `EMBRYO_GPU=verify` runs the
serial scan after every GPU scan and stops on any row difference.
`tools/build-gpu.sh --verify --parity` runs that check on migration and
Figure_7A and then the parity table with `EMBRYO_GPU=1`. All 19 inputs match
the C build bitwise. Timing is the honest part: at 1144 nodes the GPU scan
is level with the serial scan, and below the threshold it was 2.3 times
slower on migration because the input rebuilds neighbors at every
Runge-Kutta stage and each dispatch costs more than the 364 node scan. The
path exists for larger models and for the MCP tool's `backend: "gpu"`, and
it keeps the parity contract; it does not speed up the bundled examples.

The `--mlir-gpu` flag of `flow flow-to-mlir` emitted no `gpu` dialect ops for
a `parallel for` loop on this machine, and `flow mlir-spirv msl` needs
`spirv-cross`, which is not installed, so the MLIR GPU dialect route was not
used.

## Layout

```
src/                      Flow simulation modules and CLI entry point
ui/server.flow            Flow HTTP server for the browser UI
ui/index.html             browser controls and menu
ui/renderer.js            WebGL drawing stages
tests/                    Flow parity, IO, and regression checks
tests/fixtures/            Fortran-generated expected values
tools/                    Flow comparison tools and Fortran reference drivers
flow.toml                 project module mapping
```

Imports follow the Fortran `use` graph, which is acyclic. One Flow file per
Fortran module. `flow.toml` maps the `embryo` module root to `src/`, so source
uses dotted imports such as `import embryo.general { Nod, nd }`. Flow modules
export a deliberate symbol list. Mutable shared state lives in its owning
module and is exported there.

## Translation rules

1. Keep Fortran names. A subroutine `neighbor_build_node(i)` becomes
   `function neighbor_build_node(i: i32) -> void`. Lower-case, same spelling.
   Cross-module calls then resolve without coordination.
2. Keep 1-based indexing. Allocate `n + 1` elements and leave index 0 unused.
   Loop `for i in 1 to n + 1`. Do not shift indices.
3. Two-dimensional arrays are flat `ptr<T>` in row-major order with 1-based
   indices on both axes: element `(i, j)` of an array declared `(n1, n2)` sits
   at `i * (n2 + 1) + j`. Store the stride in a global next to the pointer
   (`gex`, `gex_ld`). Use the helpers in `general.flow`. Every reallocation
   goes through a resize helper in the owning module that copies old values.
4. Keep the order of floating-point operations. Do not simplify `a*b + a*c`,
   reorder sums, hoist reciprocals, or replace `x**2` by anything other than
   `x*x`. `x**y` with real `y` is `pow(x, y)`. `nue**(-ae/kl)` is
   `pow(2.71828, ...)`, since `nue` is the truncated constant.
5. Fortran real-literal kinds matter. `0.1` without `d0` is single precision.
   Assigned to `real*8` it becomes `0.10000000149011612`. Write it as
   `(0.1 as f32) as f64`, or as the exact double, with a comment. `real(n)` is
   `real*4`. Integer division truncates toward zero. `int(x)` truncates,
   `nint(x)` rounds half away from zero (`round` in C).
6. Every `call random_number(x)` becomes `x = rng_real()` from `rng.flow`, in
   the same order. The random stream is shared and global, so an extra or
   missing draw breaks parity for the rest of the run.
7. `general.mod` declares public scratch variables (`i j k ii jj kk a b c d
   ...`). Routines that read one of them without assigning it first depend on
   a value left by a caller. Mirror that with the same global in
   `general.flow`. Otherwise use locals.
8. `goto` becomes structured control flow. Keep the behaviour identical.
9. Keep the original comments that explain the model, translated to `#`
   comments. Drop dated initials (`!>>> Is 18-4-15`) and dead commented code.
10. Port every path exposed by the CLI and browser. Return errors for
    unsupported modes through the owning module's result and error fields.

## Parity

The target is a bitwise match of the `.dat` snapshots against `emaker_ref` on
each example for a short run, and agreement within a relative tolerance of
1e-9 on longer runs. `tools/snapdiff.flow` reports the largest absolute and
relative difference per field and exits nonzero above the tolerance.

## Port status

Implemented in Flow: the shared `Nod` and `Cel` records and buffers, the
GFortran 15 `random_seed` / `random_number` stream, `aleas.inialea3d`, parameter
and seed restoration, function flags, node and initial-node records, cell
records and cell membership lists, gene network matrices, WW reaction records,
per-gene metadata, network classification and expression indices, catalytic
reaction indices, and the per-node gene expression matrix. The simple and
legacy box based neighbor searches match reference node order for migration,
apoptosis, and differential adhesion. Pair distances match within 1e-12.
NUL bytes are removed with corrected bounds for the cleaned input buffer.
Focused Flow executables in `tests/` check these paths against the examples.

Reaction and
diffusion, Euler gene updates, and RK4 gene updates exist in `src/genetic.flow`.
Per-node gene derivatives match the Fortran `genestep` routine within relative
tolerance 1e-9 on all eight documented examples. `tools/gene_reference.f90`
generates the fixtures checked by `tests/test_gene_derivative_parity.flow`.
Kinds 7 and 8 and their reaction forms are included in these input examples.

`write_snapshot` serializes parameters, flags, seeds, gene data, node records,
and cells using the reference fixed-width rows. Round-trip checks cover all
eight documented input examples. A standalone program linked to the vendored
Fortran objects read the generated migration snapshot and reported `READ_OK
364 3 26`. `tools/snapdiff.flow` compares numeric fields using a scaled 1e-9
tolerance. The snapshot writer clears energy in serialized current-node rows,
matching the reference writer without changing the live Flow state. One-step
snapshots match on all six examples that use supported box neighbors.
The input cleaner also inserts the omitted `E` in Fortran values with
three-digit exponents. Cell minimum and maximum division size updates are
ported in `src/nexus.flow` and match the Fortran results on all eight examples.
The division signal and phase accumulation match across all eight inputs when
the thresholds are raised to isolate that update. `mitosis.flow` now computes
the physical division axis, chemical weighting, asymmetric split point,
connectivity correction, and daughter-cell membership. `should_i_divide`
triggers this path. Forced phase-triggered division matches node ownership,
epithelial pairs, cell memberships, centers, and phase values on six examples.
The `figure_6` and sea-urchin inputs have no movable cell with four or more
nodes, so the division parity fixture skips them.

`src/biomechanic.flow` now contains spring and contact forces, epithelial
projection cases, adhesion gene forces, torsion, adhesion limiting, fixed-node
restoring forces, adaptive differential steps, and RK4 position integration.
Per-node force vectors match the Fortran routine within relative tolerance
1e-9 on all eight documented examples. `tools/force_reference.f90` generates
the force and neighbor fixtures. `tests/test_biomechanic_force_parity.flow`
checks those fixtures. `tests/test_biomechanic_migration.flow` also advances
the migration example through RK4 and adaptive RK4 steps. Fixed step and
adaptive positions match Fortran within relative tolerance 1e-9 on migration.
`fill_co_griders` and `restore_neighbors` now save epithelial contacts, restore
missing links using the shared-neighbor check, preserve Fortran's single
precision distance calculation, and refresh the saved contact list. The
restoration parity check covers three legacy-box examples, a full recovery
after clearing all current links, and a single removed link. Triangulation and
Gabriel neighbor modes have focused parity checks. The force parity check also
loads Fortran neighbor fixtures for those modes.
`src/death.flow` ports the cell death signal, node-radius reduction, paired
epithelial apoptosis, node and gene row compaction, and empty-cell compaction.
The `test_apoptosis_parity.flow` check matches node indexing, pair links, cell
membership, positions, and radii after direct apoptosis and one death update
on all eight inputs.
`src/model.flow` now updates cell centroids and `rdiffmax` at iteration start.
The Flow results match the reference calculations for all eight examples in
`test_model_prepare_parity.flow`. `advance_model_iteration` connects neighbor
construction and restoration, adaptive force-step selection, gene updates,
nexus behaviors, position integration, and gene-expression commit. One step
completes for six examples with supported neighbor modes.
`src/growth.flow` ports cell compression gating, gene-controlled growth
signals, current and previous radius updates, node and gene-row capacity
expansion, and growth-node creation and placement. It includes polar growth
placement branches. The one-step radius parity check passes on all eight inputs.
Forced growth additions match seven examples. Figure 6 reaches an undefined
reference branch, so its growth check verifies node counts and placement bounds
instead of exact coordinates.
`src/ecm.flow` also ports the per-node ECM accumulation in
`should_I_secrete`. `tests/test_ecm_secretion.flow` compares post-update ECM
values against Fortran fixtures for all eight examples. ECM node creation now
handles epithelial secretion and the unpolarized mesenchymal paths. Forced
single-node emissions match Fortran placement, node fields, and gene transfer
on all eight examples. The polar mesenchymal path uses zero for an
uninitialized blend value in the Fortran routine. Parity for that branch
cannot be established from the vendored source.
Node capacity growth now preserves shared node records, force and energy
buffers, neighbor rows, and gene expression matrices. `test_general.flow` and
`test_node_resize.flow` check the copied state and zeroed new slots.
The Fortran `nexus.polarization` routine has a Flow implementation and
reference fixtures for the examples where its output is stable. The `polar_growth`
check verifies normalized polarity invariants because the vendored routine reads
local `d` without assigning it for node types 2 and 4. Repeated instrumented
reference runs selected different center nodes, so those outputs do not define a
reliable parity target.

The `src/embryomaker.flow` entry point reads an input file, advances a requested
number of iterations, and writes a `.dat` snapshot. The writer includes the
reference filter section. Build with `flow build`.
Single-node division now creates daughter nodes and cells. Its parity check
matches the Fortran result on six examples with supported neighbor modes. The
neighbor-axis length keeps the Fortran power operation because multiplication
rounding can change which of two symmetric axes wins. Single-node polarization
matches both `ffu(9)` branches on six examples with a synthetic gene signal.
Contraction requirement diffusion matches a fixed-signal reference check on
the six examples with supported neighbor modes.
One model iteration completes on all ten shipped UI examples. The iteration
check reloads them sequentially in one process, so it also checks that
neighbor caches reset between input files. Adaptive position integration is
connected to the iteration path. The nexus updates differentiation,
contraction, growth, volume conservation, epithelial and mesenchymal node
properties, EMT, lonely-node cleanup, and contraction requirement diffusion.
The Flow check set passes all 58 checks. The polar growth polarization check
tests invariants because the vendored reference output is unstable for that
input.

Apoptosis now reindexes live neighbor rows and the saved neighbor restoration
graph as nodes are removed. The Flow server previously failed on apoptosis at
iteration 119 because an old neighbor ID remained after the node count fell
from 518 to 504. `tests/test_apoptosis_dynamic_neighbors.flow` advances the OG
example through 120 iterations and checks every neighbor ID after each step.

`src/delaunay.flow` contains the initial tetrahedron selection, point location,
interior, face, edge, and hull insertion, and empty-sphere face swaps from
`geompack3.f90`. The focused check builds the apical contraction triangulation
and validates face hashes and reciprocal boundary links. The no-Gabriel
triangulation neighbor graph matches reference fixtures on apical contraction
and figure 6 with Gabriel screening disabled. Gabriel screening also matches
the apical contraction fixture with `ffu(2)=1`, and the legacy box path matches
migration with `ffu(2)=1`. The figure 6 legacy full-graph branch skips assigning
the screening center when `ffu(9)=1`, preserving the older reference behavior.
Gabriel screening therefore uses compiler-state-dependent coordinates for that
input, and its reference graph is not a stable parity target. The modern
extended box mode (`ffu(23)=1`, `ffu(24)=1`) matches
ordered neighbor IDs and distances on migration with both `ffu(17)` settings.
The `ffu(24)=0` extended mode returns an unsupported-mode error to the caller.
The `ffu(9)=1` legacy extended path uses its own radius checks and box scan,
and matches fixtures on migration with both `ffu(17)` settings. Both supported
extended modes rebuild the moved node's neighbors from the current box grid.

One-step snapshots match all six supported examples within scaled tolerance
1e-9. A previous 42-node mismatch came from a reference command that advanced
about a thousand internal steps. Unbiased random movement now follows the
model iteration path and matches direct `itera` references on migration,
apoptosis, and differential adhesion. The headless entry point accepts the
reference driver's interval and snapshot count arguments and writes numbered
snapshots. A two iteration migration run and a two snapshot run complete. One
model iteration now completes on apical contraction and figure 6 with
triangulation neighbors. The standard box neighbor rebuild resets each node's
neighbor count before filling its row. Energy based random noise uses the
reference retry loop. The figure 6 iteration preserves its empty daughter
cells, matching the Fortran node and cell counts. The figure 6 snapshot still
differs at node 1 after Gabriel screening because the legacy Fortran routine
skips assigning the local screening center. Its growth fixture also reaches
`findepixyz_nodel` with no epithelial candidate at least 0.01 from the cell
center, then reads `jj` without assigning it.

OG `iteracio(tf)` advances simulated time when `ffu(7)=0` and `ffu(14)=0`.
Fixed-step mode and real-iteration mode advance `tf` solver iterations.
`advance_model_batch` follows this rule. Its one-unit checks match the Fortran
iteration counts for migration (181), apoptosis (414), differential adhesion
(1215), polar growth (109), ECM secretion (388), and figure 6 (2).

## Browser UI parity

The WebGL renderer records the `drawer.mod.f90:draw_func` stage order: common
lines, eggshell, epithelial springs, box grid, the per-node draw loop,
connectivity, slice plots, and cell centroids. Supported geometry is submitted
in that order. Cursor markers enter the per-node loop before node geometry. The
browser smoke check verifies the source stage contract and active draw order.
WebGL supplies the graphics API, so OG GLUT fixed-function calls are translated
into WebGL draws. The eggshell path builds the OG 20 by 20 spheroid mesh from
the active node count and maximum EQD, then applies the source clipping and
color rules. Slice plots sample the Flow energy routine over the requested
plane and submit the resulting scalar points in the OG slice stage.

The right-click menu exposes the active drawer, display, selection, editor,
movement, and input/output actions. Save-present-time and periodic snapshots
write the original `.dat` format under `output/<model>/`. Automatic view frames
write PNG files under `images/<model>/`. Movie capture records the model canvas
and converts it to an animated GIF with FFmpeg. If FFmpeg is unavailable, the
browser saves the WebM recording instead. The UI smoke check exercises snapshot
round trips, periodic snapshots, PNG capture, GIF output, all ten examples,
custom `.txt` input, editor actions, camera controls, menu hover navigation,
and rewind snapshot equality. It advances apoptosis one step and verifies the serialized OG
adhesion/repulsion vectors reach the WebGL force overlay. The force fixture
suite compares movement, spring, adhesion/repulsion, lateral tension, and axial
tension components with the OG arrays across all eight stable inputs. The smoke
check fails on browser console or runtime errors.
The root menu keeps the OG category order, direct iteration commands, the
no-op `fitness` entry, and `quit`. In the browser, `quit` stops scheduled
iterations and navigates the app page to `about:blank`; the Flow server remains
available for another page.
Gene history starts collecting when a model loads, matching the OG `lock=0`
default. It stores every node's gene values after each returned iteration and
supports plots for up to ten node indices and ten genes. The plot keeps the OG
grouping: multiple nodes share a graph, while multiple genes can be selected
when both lists contain multiple entries.
Keyboard rewind preserves the current camera and reproduces the prior `.dat`
snapshot byte for byte for the checked migration run.
An invalid custom input leaves the current model visible. The same valid file
can be selected again afterward. `read_snapshot_parameters` clears its prior
error status before starting each parse, so a rejected input cannot poison the
next load. The Flow server saves the active session before replacing its global
model state. If parsing or neighbor preparation fails, it reloads that snapshot
so the existing session can continue.

The original drawer uses GLUT and fixed-function OpenGL. The Flow renderer uses
WebGL and mirrors the source geometry and state. Build the original GUI on macOS
with `make -C reference/fortran gui`, then run `reference/fortran/build/emaker_gui`
from `reference/` with an example path. Its Fortran GLUT binding now passes a
valid argument vector, and the display callback no longer requests an endless
redraw loop. Two menu entries for disabled source menus were removed to avoid
invalid GLUT submenu warnings. Matching apoptosis views have been captured at
800 by 800. `tools/render_diff.flow` compares model crops after downsampling the
native Retina capture. It reads PNG pixels directly and reports model bounds,
silhouette overlap, and color error. On this pair, the model bounds match at 358 by 290
pixels, the centered silhouette intersection-over-union is 0.992, and the
overlap color mean absolute error is 3.1 on an 8-bit channel. Viewport
registration also places the model at `(220, 272)` in both 800 by 800 views,
with matching width and height. Across all 640,000 viewport pixels, RGB mean
absolute error is 0.63 on an 8-bit channel, with 2.7% of pixels differing after
downsampling the OG Retina capture. This includes antialiasing and the transient
status line in the Flow capture. The display-box mode was also captured on the
same apoptosis input with the OG `conf_flag(18)` and Flow "display box
boundaries" enabled. Model bounds and placement match. Its whole-view RGB mean
absolute error is 0.647, with 2.70% of pixels differing. The model silhouette
IoU is 0.992 and overlap color error is 3.07. The neighboring box grid also
matches placement and bounds. Its silhouette IoU is 0.982, overlap color error
is 3.13, and whole-view RGB error is 0.639. Turning cylinders off exposes the
GLUT sphere shading path. A fresh paired capture of the apoptosis example
matches the sphere bounds at 358 by 282 pixels and placement at `(220, 276)`.
Silhouette IoU is 1.000, overlap color MAE is 11.86, and whole-view RGB MAE is
1.60. The OG capture is `/tmp/og-apoptosis-spheres-current.png`; the Flow
capture is `/tmp/flow-apoptosis-spheres-original-azimuth.png`. Testing the
FreeGLUT negative-longitude formula on this same pair gives silhouette IoU
0.993 and overlap color MAE 13.21. The reference GUI links macOS GLUT, so the
paired capture sets the sphere phase used by Flow.
The variable-radius index comparison uses the apoptosis model with base balls
and epithelial cylinders hidden. OG uses sphere selection 42, color selection
29, and the default range `[1, 518]`. It draws 517 transparent spheres with
material alpha 0.25. The fresh captures have identical bounds at 392 by 313
pixels and identical placement at `(207, 256)`. Silhouette IoU is 1.000,
overlap color MAE is 3.93, and whole-view RGB MAE is 0.84. The OG capture is
`/tmp/og-apoptosis-transparent-index-fresh.png`; the Flow capture is
`/tmp/flow-apoptosis-transparent-index-fresh.png`. The WebGL context must keep
an opaque drawing buffer. An alpha channel causes the browser to composite the
already blended spheres over black a second time. A temporary native GL probe
confirmed blending factors 770/771 at the draw call.
The type-arrow comparison uses the apoptosis input with 259 arrows, range
`[1, 7]`, and scale `1`. An isolated arrow capture exposed a draw-offset bug.
`taperedCylinder` writes absolute offsets into its accumulated surface and
outline buffers. The caller added the arrowhead buffer offset a second time,
so head triangles indexed later node geometry. The caller now preserves the
returned offsets. The UI smoke check asserts that every arrow face and outline
draw stays within its own vertex range. A fresh paired capture with the OG
default node display has matching bounds at 358 by 290 pixels and placement
at `(220, 272)`. Silhouette IoU is 0.992, overlap color MAE is 3.30, and
whole-view RGB MAE is 0.67. The OG capture is
`/tmp/og-apoptosis-arrows-fresh.png`; the Flow capture is
`/tmp/flow-apoptosis-arrows-fresh.png`. An earlier isolated arrow capture
without node balls or epithelial cylinders had bounds 344 by 249 pixels,
matching placement, silhouette IoU 0.992, overlap color MAE 5.16, and whole
viewport RGB MAE 0.36 after a 1.3 arrow color compensation.
Reproduce the display-box comparison with:

Build the analyzer first with `flow compile tools/render_diff.flow`.

```sh
"$(dirname "$(readlink "$(command -v flow)")")/build/render_diff" /tmp/og-apoptosis-box.png /tmp/flow-apoptosis-box.png \
  --reference-scale 2 \
  --reference-view 112 140 1600 1600 \
  --candidate-view 0 0 800 800
```

The sphere comparison uses:

```sh
"$(dirname "$(readlink "$(command -v flow)")")/build/render_diff" /tmp/og-apoptosis-spheres-current.png /tmp/flow-apoptosis-spheres-original-azimuth.png \
  --reference-scale 2 \
  --reference-view 112 140 1600 1600 \
  --candidate-view 0 0 800 800
```

The variable-radius index comparison uses a lower color mask because its
transparent pixels are dimmer:

```sh
"$(dirname "$(readlink "$(command -v flow)")")/build/render_diff" /tmp/og-apoptosis-transparent-index-fresh.png /tmp/flow-apoptosis-transparent-index-fresh.png \
  --reference-scale 2 \
  --reference-view 112 140 1600 1600 \
  --candidate-view 0 0 800 800 \
  --blue-min 1 --green-max 70 --blue-red-ratio 1.1
```

The default comparison uses:

```sh
"$(dirname "$(readlink "$(command -v flow)")")/build/render_diff" /tmp/og-apoptosis.png /tmp/flow-apoptosis.png \
  --reference-scale 2 \
  --reference-view 68 116 1600 1600 \
  --candidate-view 320 50 800 800
```

The viewport rectangles are `(x, y, width, height)` in screenshot pixels. The
tool reports model bounds inside each viewport, silhouette overlap, color
error, and whole-viewport pixel differences after downsampling the OG Retina
capture. When the model bounds differ, it still reports registered viewport
metrics and exits with status 1.

Each command runs the executable in Flow's `build` directory.
