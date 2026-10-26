# Flow idiom guideline

Use Flow constructs to remove repeated mechanics and make intent visible.
Keep the simulator's numeric behavior and public contracts stable.

## Prefer

- `for index in start to end` for bounded counters. Keep `while` for conditions
  whose end depends on runtime progress, such as simulated elapsed time.
- `match` for dispatch and mode selection. Keep guarded arms where the compiler
  needs them for integer constants.
- `defer` next to temporary allocations or resources that must be released on
  every return path.
- Shared functions for repeated capacity checks, indexing, and state
  transitions. Merge algorithms when they traverse and accumulate the same
  state in the same order. Keep a serial and parallel path on one shared range
  body when their ordering permits it.
- Flow ranges throughout bounded domain passes, including nested node, gene,
  neighbor, cell, and geometry loops. Keep the bounds visible at the loop.
- `while` for scans and algorithms whose bounds change during execution, such
  as shifted-index deletion, capacity growth, and search-until-found.
- Pipeline syntax for readable value transformations. Use it when each stage
  consumes the previous value and the chain is clearer than nested calls.
- `flow` declarations for continuous state with explicit derivatives and
  parameters. Keep discrete events and external side effects at explicit
  boundaries.

## Preserve

- Floating-point accumulation order when parity depends on it.
- Mutation order in algorithms that update both a node and its neighbors.
- Existing numeric error codes at compatibility boundaries.
- Stable serialization and command line formats.

## Check before adopting a feature

- Confirm syntax and implementation support in the installed Flow compiler.
- Confirm any differences in indexing, loop bounds, or integer widths.
- Preserve accumulation order and mutation order when consolidating passes.
- Compile without type warnings after changing dispatch or data structures.
- Compare the relevant snapshots or subsystem outputs against the reference
  before extending the change.

Shorter code is a useful result when it removes repeated rules. Avoid wrappers
that add another name while leaving the same state and branching in place.

## Candidate scans

Keep candidate discovery separate from the contact rule. The ordinary box
scan and buffered-candidate scan call `scan_contact`, which owns the distance
arithmetic, layer exclusion, and neighbor output. Use ranges for bounded
candidate spans and grid coordinates. Keep linked-list traversal as `while`.

Preserve z, y, x traversal and descending node order inside each box. Algebraic
rearrangement of the distance sum can change trajectories. A shorter shared
implementation still needs snapshot comparisons and performance measurements.

## Scope-owned cache state

Use `defer release_force_gene_cache()` immediately after pinning the adaptive
integrator's active-gene cache. The scope owns cleanup across successful and
failed integration calls. Keep one release function for the paired pin and
validity flags. This removes repeated cleanup branches while retaining their
state transition.

## Gene-to-property signals

`genetic.node_gene_effect(node_id, property_id)` owns the ordered sum of
positive gene expression multiplied by property effects. ECM secretion,
polarization, and node-property updates share this rule. Keep factors inside
an accumulation when moving them outside would change floating-point order.
