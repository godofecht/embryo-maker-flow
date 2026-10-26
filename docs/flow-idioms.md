# Reducing the Flow port

<p class="article-meta"><span>ENGINEERING NOTES</span><span>FLOW · EMBRYOMAKER</span></p>

This project began as a close port of EmbryoMaker's Fortran program. The first
goal was behavioral parity. The next goal has been to let Flow express the
same work with less scaffolding, while keeping the original model's operation
order and outputs.

## Stage 1: let ranges express counted loops

The port had many loops that declared an index, checked its limit, incremented
it, and handled the loop body. Flow's range loop expresses that pattern
directly:

::: {.compare}
::: {.example}
#### Before

```flow
let mut node_id: i32 = 1
while node_id <= nd {
    update_node(node_id)
    node_id = node_id + 1
}
```
:::

::: {.example .after}
#### With a range

```flow
for node_id in 1 to nd + 1 {
    update_node(node_id)
}
```
:::
:::

The compiler owns the counter and its increment. The body keeps the model's
one-based indexing visible. This pattern now appears in model preparation,
centroid updates, gene expression commits, growth buffers, geometry checks,
editor operations, and other bounded passes. `continue` and `break` still
express early movement when the algorithm needs them.

## Stage 2: use Flow's process and string libraries

The command line entry point used a C embedding bridge to read arguments and
environment variables. `std.process` now supplies those values. Parsing and
formatting use `std.string`, so the entry point keeps its platform-facing work
in Flow.

## Stage 3: make temporary memory scopes visible

Temporary C allocations now use `defer free(...)`. The release stays beside
the allocation, and it runs on each return path. This is used for formatted
error text, snapshot input buffers, and other short-lived strings.

::: {.compare}
::: {.example}
#### Before

```flow
let text: ptr<u8> = format_error(code)
print(text)
free(text as ptr<void>)
```
:::

::: {.example .after}
#### With `defer`

```flow
let text: ptr<u8> = format_error(code)
defer free(text as ptr<void>)
print(text)
```
:::
:::

## Stage 4: use `match` for dispatch

The parallel pass dispatcher keeps each worker kind beside its handler in one
Flow `match`. Guarded arms remain where the compiler needs them for integer
constants.

::: {.compare}
::: {.example}
#### Before

```flow
if kind == 1 { run_force_range(start, end) }
elif kind == 2 { run_gene_range(start, end) }
elif kind == 3 { run_neighbor_range(start, end) }
```
:::

::: {.example .after}
#### With `match`

```flow
match kind {
    value if value == PARALLEL_FORCE_PAIRS => { force_pairs_range(start, end, thread) }
    value if value == PARALLEL_GENE_STEP => { genestep_range(start, end, thread) }
    value if value == PARALLEL_NEIGHBOR_SCAN => { neighbor_scan_range(start, end, thread) }
    _ => {}
}
```
:::
:::

## Stage 5: share state transitions

Serial and parallel force setup used to carry duplicate capacity-growth code.
Both paths now call `ensure_force_active_genes_capacity()`.

The synchronous batch runner now enters the same batch state machine as the
chunked worker path. Both callers share stopping conditions and failure
handling.

## Stage 6: share algorithms with the same rule

The minimum and maximum division-size calculations followed the same traversal
and accumulation rule. A property parameter now selects which field is
updated. The wrappers preserve the existing call sites.

::: {.compare}
::: {.example}
#### Before

```flow
function change_minsize_for_div() -> bool {
    # traverse nodes and genes, accumulate the minimum
}

function change_maxsize_for_div() -> bool {
    # repeat the traversal and accumulation for the maximum
}
```
:::

::: {.example .after}
#### With one shared pass

```flow
function change_division_size(property_id: i32, minimum: bool) -> bool {
    for cell_id in 1 to ncels + 1 {
        let mut signal: f64 = 0.0
        for node_slot in 1 to cels[cell_id].nunodes + 1 {
            let node_id: i32 = cels[cell_id].node[node_slot]
            for gene_slot in 1 to npag[property_id] + 1 {
                let gene_id: i32 = whonpag[property_id * (ng + 1) + gene_slot]
                let expression: f64 = gex[gene_expression_index(node_id, gene_id)]
                if expression > 0.0 {
                    signal = signal + expression * gene_effects[gene_effect_index(gene_id, property_id)]
                }
            }
        }
        signal = signal * delta / cels[cell_id].nunodes as f64
        let mut size: f64 = if minimum { cels[cell_id].minsize_for_div } else { cels[cell_id].maxsize_for_div }
        size = size + signal
        if size < 1.0 { size = 1.0 }
        if minimum { cels[cell_id].minsize_for_div = size + signal }
        else { cels[cell_id].maxsize_for_div = size + signal }
    }
    return true
}
```
:::
:::

The implementation lives in [`src/nexus.flow`](https://github.com/godofecht/embryo-maker-flow/blob/main/src/nexus.flow). It retains the accumulation order.

## Stage 7: express arithmetic at the type's natural width

The random generator's local arithmetic uses Flow's native `u64` operations
and counted loops. Its persistent state remains split into `i32` words because
the current Flow module storage path does not support static `u64` values.
This keeps the generator compact without relying on unsupported global state.

## Stage 8: use ranges across whole domain passes

The range conversion now reaches Delaunay setup and checks, ECM and
polarization, growth and mitosis, single-node division, editor operations, and
gene expression updates. In the RK4 path, each node and gene pass remains a
separate stage. Ranges remove counter setup and increments while preserving
the stage boundaries and iteration order.

## Stage 9: keep progress-driven loops explicit

Some loops change their own bounds as they run. Node removal shifts later
indices. Buffer growth repeats until capacity is sufficient. Neighbor and
token scans stop when they find a match. These remain `while` loops because
their stopping conditions describe the algorithm's progress.

## Stage 10: keep computation structure when it protects behavior

Shorter source helps when it removes repeated rules and preserves
floating-point order, mutation order, and the model's error contract. The
pair-force and integration code keeps explicit accumulation steps where order
affects parity. Performance changes are measured against reference snapshots.
Changes that slow the workload are removed.

## Stage 11: organize hot force data by node

The force pass kept twelve values for each node in separate arrays. The new
scratch buffer stores those twelve values together. Each thread works on its
node row, and the serial reducer replays partner terms in the same order as
the reference routine.

::: {.compare}
::: {.example}
#### Before

```flow
adhesion_x[node_id] = adhesion_x[node_id] + force_x
adhesion_y[node_id] = adhesion_y[node_id] + force_y
repulsion_x[node_id] = repulsion_x[node_id] + repel_x
repulsion_y[node_id] = repulsion_y[node_id] + repel_y
```
:::

::: {.example .after}
#### Row of force scratch

```flow
let nrow: i32 = node_id * 12
acc[nrow + 0] = acc[nrow + 0] + force_x
acc[nrow + 1] = acc[nrow + 1] + force_y
acc[nrow + 3] = acc[nrow + 3] + repel_x
acc[nrow + 4] = acc[nrow + 4] + repel_y
```
:::
:::

The same pass gathers active adhesion genes once, reuses neighbor geometry,
and avoids clearing display arrays for nodes that overwrite their own values.
Prepared diffusion data is reused across the sweeps in one iteration. These
changes are measured in [the porting record](https://github.com/godofecht/embryo-maker-flow/blob/main/PORTING.md); each kept solver change was checked against the reference snapshots.

## Stage 12: split independent work into deterministic ranges

The worker pool handles neighbor scans, gene derivatives, and force work. Each
job receives a node range. Force computation has two phases: one records pair
terms, then a reducer adds them in the order used by the serial routine.

::: {.compare}
::: {.example}
#### One serial traversal

```flow
for node_id in 1 to nd + 1 {
    visit_neighbors_and_update_both_nodes(node_id)
}
```
:::

::: {.example .after}
#### Range jobs and ordered reduction

```flow
embryo_pool_run(FORCE_PAIRS, nd, grain)
embryo_pool_run(FORCE_REDUCE, nd, grain)
```
:::
:::

`src/workers.flow` dispatches jobs to range bodies in their owning modules.
Small models can remain serial. `EMBRYO_THREADS=1` selects the serial policy.
The parity switch compares parallel force results with the serial routine.

## Stage 13: expose exact and preview compute paths

The Metal neighbor kernel filters candidate pairs. Flow repeats the exact
binary64 distance test on the surviving candidates in their original order.
Forces can run on the CPU, in a float32 preview, or in software binary64 on the
GPU. Exact modes retain the snapshot result. Preview mode reports its numeric
tradeoff in the Studio.

The `gpu/` and `native/` directories contain the Metal kernels, software
binary64 operations, allocation bridge, and platform stubs. `flow.toml`
registers the native layer. GPU failures fall back to the CPU path.

## Stage 14: send compact frames and request work in batches

The viewer used to fetch a JSON model after every solver iteration. It now
requests a packed frame with typed arrays for node values, genes, and edges.
The server keeps the JSON response for callers that omit the binary request
flag.

::: {.compare}
::: {.example}
#### JSON arrays on every response

```json
{"nodes":[{"x":0.1,"y":0.2,"z":0.3}],"edges":[[1,2]]}
```
:::

::: {.example .after}
#### Header plus packed values

```text
EMB1 | metadata length | JSON metadata | f64 nodes | i32 fields | edges
```
:::
:::

Playback has slow, frame, fast, and maximum modes. The faster modes adapt the
number of solver iterations per request to the measured iteration time. The
timeline supports scrubbing, keyboard stepping, and an editable run target.
The compute selector changes CPU and GPU modes through the server API.

## Stage 15: make the build paths repeatable

`tools/build-pgo.sh` trains a profile and the normal UI build reuses it when
present. `tools/build-mlir.sh` lowers the Flow program through MLIR and applies
the floating-point contraction rewrite needed for parity. `tools/build-gpu.sh`
builds the Metal path. `tools/backend_parity.sh` compares snapshots across
backends. The MCP simulation tools can select C, MLIR, or GPU builds.

The UI's status and compute controls expose the selected backend and worker
settings. The notebook records the long-run performance hypothesis. The
measurements, platform limits, and remaining gaps are in [the porting record](https://github.com/godofecht/embryo-maker-flow/blob/main/PORTING.md).

## Change ledger

This ledger maps every source, runtime, build, and project file changed or
added in this worktree. The paired examples above show representative shapes;
the linked source and build notes cover the full implementation.

| Area | Files | Change |
| --- | --- | --- |
| Bounded simulation passes | `src/aleas.flow`, `src/death.flow`, `src/delaunay.flow`, `src/ecm.flow`, `src/editor.flow`, `src/energy.flow`, `src/growth.flow`, `src/mitosis.flow`, `src/noise.flow`, `src/nexus.flow`, `src/polarization.flow`, `src/single_node.flow` | Replaced explicit counted-loop counters with Flow ranges. Merged minimum and maximum division-size accumulation in `src/nexus.flow`. |
| State, genes, and time stepping | `src/general.flow`, `src/genetic.flow`, `src/model.flow`, `src/rng.flow` | Added environment-backed worker and GPU policy, geometric buffer growth, gene and RK4 range passes, shared batch state transitions, and native unsigned RNG arithmetic. |
| Mechanics and neighbor search | `src/biomechanic.flow`, `src/neighboring.flow`, `src/workers.flow` | Added cache-aware force scratch, prepared gene and diffusion data, deterministic range jobs, GPU candidate filtering, verification, and CPU fallback. |
| Input and server | `src/embryomaker.flow`, `src/io.flow`, `ui/server.flow` | Moved process and string handling into Flow libraries, scoped temporary allocations with `defer`, added compute-mode control, batched model execution, and packed binary model frames. |
| Browser client | `ui/index.html` | Added adaptive playback, a timeline and editable target, keyboard stepping, compute selection, and binary frame decoding. |
| Native and GPU support | `gpu/kernels/neighbor_prefilter.flow`, `gpu/metal/force_pairs.metal`, `gpu/metal/softdouble.metal`, `gpu/metal/softdouble_test.metal`, `native/embryo_metal.m`, `native/embryo_pool.c`, `native/embryo_metal_force.h`, `native/embryo_metal_kernels.h`, `native/embryo_metal_softdouble.h` | Added Metal kernels, software binary64 arithmetic, Flow kernel embedding, and native bridges. |
| Build and parity tools | `tools/backend_parity.sh`, `tools/build-gpu.sh`, `tools/build-mlir.sh`, `tools/build-pgo.sh`, `tools/gen_metal_header.py`, `tools/mlir_unfuse.py`, `tools/softdouble_check.flow`, `tools/run-ui.sh` | Added repeatable PGO, MLIR and Metal builds, backend comparisons, generated kernel headers, and software binary64 checks. |
| MCP and project wiring | `tools/embryomaker_mcp.py`, `flow.toml` | Added GPU backend selection and registered native build inputs. |
| Performance record | `notebooks/EmbryoMaker-Flow-long-run-hypothesis.ipynb`, `PORTING.md` | Recorded long-run questions, measurements, parity results, and backend limits. |
| Project and idiom docs | `README.md`, `CLAUDE.md`, `MCP.md`, `FLOW_IDIOMS.md`, `docs/_includes/header.html`, `docs/flow-idioms.md` | Linked the project guidance and rendered article from the project site. |
| Article renderer | `docs/flow-idioms.template.html`, `docs/assets/flow-idioms.css`, `docs/flow-idioms.html`, `tools/render-flow-idioms.sh` | Added the Pandoc template, responsive paired-code styles, generated page, and render command. |

## Stage 16: share the contact rule across candidate sources

The buffered-candidate experiment initially duplicated the contact calculation
inside two traversals. The shared `scan_contact` function now owns distance
arithmetic, layer filtering, and row output. The shared function and scan body occupy 57 lines. Bounded spans use Flow ranges.
Linked lists retain their terminating condition.

These excerpts show the two candidate sources after consolidation:

::: {.compare}
::: {.example}
#### Buffered candidates

```flow
for cursor in candidate_offsets[i] to candidate_ends[i] {
    count = scan_contact(i, candidate_ids[cursor], count)
}
```
:::
::: {.example .after}
#### Grid candidates

```flow
for z in zbin - 1 to zbin + 2 {
    for y in ybin - 1 to ybin + 2 {
        for x in xbin - 1 to xbin + 2 {
            let mut candidate: i32 = box_head_at(box_index(x, y, z))
            while candidate != 0 {
                count = scan_contact(i, candidate, count)
                candidate = list[candidate]
            }
        }
    }
}
```
:::
:::

The cache remains opt-in. Its initial Sea urchin measurements did not establish
a speedup. See [the experiment record](benchmarks/candidate-cache.md) for
parity checks, timings, and limits. The shared contact rule is used by the
default box scan too.

## Stage 17: let the adaptive integration scope release its cache

`adaptive_rungekutta` repeated the same two flag resets at three failure exits
and at successful completion. It now registers one deferred release after
pinning the cache. Its bounded node passes also use ranges. A two-step Sea
urchin check with adaptive integration enabled produced a byte-identical
snapshot before and after this change.

::: {.compare}
::: {.example}
#### Repeated failure cleanup

```flow
if rungekutta4(half_step) == false {
    force_active_gene_cache_pinned = false
    force_active_gene_cache_valid = false
    return false
}
```
:::
::: {.example .after}
#### Cleanup owned by the function scope

```flow
force_active_gene_cache_pinned = true
force_active_gene_cache_valid = false
defer release_force_gene_cache()
# The remaining integration stages share this cleanup.
if rungekutta4(half_step) == false { return false }
```
:::
:::

## Stage 18: centralize gene-to-property signals

ECM secretion, polarization, and node-property updates now call
`genetic.node_gene_effect(node_id, property_id)`. The helper preserves the
stored gene order and includes only positive expression. This removes four
copies of the same accumulation. Death and division retain their factors
inside their sums to preserve arithmetic order. All 19 bundled parity cases
passed at the suite's full step counts after consolidation.

## What comes next

Flow's `flow` declarations can own continuous state and generate an
integrator. A small experiment confirmed that the compiler generates the
state type and integrator. The simulator's mechanics still depend on shared
mutable arrays, discrete biological events, and legacy error codes. Moving
them into declared dynamics needs a clear state boundary and output
comparisons. Start with one isolated continuous subsystem, then compare
snapshots and trajectories before expanding the boundary.

The [Flow idiom guideline](https://github.com/godofecht/embryo-maker-flow/blob/main/FLOW_IDIOMS.md) records the rules for future changes.
