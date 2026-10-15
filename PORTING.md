# Porting EmbryoMaker to Flow

This file is the contract every porter follows. Read it before writing code.

## Source and scope

- Original: https://github.com/HugoCanoFernandez/EmbryoMaker at commit
  `9d1224d2bad430edce11505b448a749b64520362`, copied to `reference/`.
- Fortran sources: `reference/fortran/src/`. Examples: `reference/examples/`.
- Scope: the headless simulator. Read an EmbryoMaker input file, run the Node
  Model and the gene network, write snapshots in the original `.dat` format.
- Out of scope for now: OpenGL drawer, editor, NetworkMaker GTK GUI,
  `ic.mod.f90` presets (`default_ic`), the Delaunay neighbour modes
  (`neighbor_build_triang_*`, geompack3), gnuplot output, evolution/ensemble
  filters that shell out. Keep a stub that prints
  `not ported: <routine>` to stderr and exits with code 3 if reached.

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
  `docs/flow-gaps.md` (one line per gap, with the file that needed it).

## Layout

```
src/general.flow          general.mod: constants, Nod and Cel, all globals
src/rng.flow              gfortran-exact random_number / random_seed
src/aleas.flow            aleas.mod
src/genetic.flow          genetic.mod
src/io.flow               io.mod (readsnap, writesnap, param matrices)
src/shell.flow            shell.mod
src/neighboring.flow      neighboring.mod
src/polarization.flow     polarization.mod
src/energy.flow           energy.mod
src/biomechanic.flow      biomechanic.mod
src/biomechanic_pola.flow biomechanic_pola.mod
src/growth.flow           growth.mod
src/death.flow            death.mod
src/ecm.flow              ecm.mod
src/pola.flow             pola.mod
src/mitosis.flow          mitosis.mod
src/single_node.flow      single_node.mod
src/nexus.flow            nexus.mod.f03
src/model.flow            model.mod
src/inicial.flow          inicial.mod (file input path only)
src/embryomaker.flow      entry point, same CLI as emaker_ref
tests/                    test_<module>.flow, main() returns 0 or a check number
tools/snapdiff.flow       numeric diff of two .dat snapshots
```

Imports follow the Fortran `use` graph, which is acyclic. One Flow file per
Fortran module. Each file owns the module-level variables its Fortran module
declares.

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
10. Port only the code paths reachable from the headless driver. If a routine
    is dead in the headless path, leave the not-ported stub.

## Parity

The target is a bitwise match of the `.dat` snapshots against `emaker_ref` on
each example for a short run, and agreement within a relative tolerance of
1e-9 on longer runs. `tools/snapdiff.flow` reports the largest absolute and
relative difference per field and exits nonzero above the tolerance.
