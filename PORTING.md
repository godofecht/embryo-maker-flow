# Porting EmbryoMaker to Flow

This file is the contract every porter follows. Read it before writing code.

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

On the M4 Max, a 50,000-iteration migration profile placed most sampled time in
`forces` and `neighbor_build`, followed by `genestep`. The force pass updates
both ends of each neighbor pair in source order, so parallelizing that loop
would introduce races and change accumulation order. An OpenMP build that
parallelized independent gene rows took 15.94 seconds for the same migration
run. The serial O3 build took 9.23 seconds. Keep that workload serial. MLX
`float64` operations run on CPU, so MLX does not add GPU acceleration while the
simulation keeps its double-precision parity contract.

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
