The `*_neighbors.ref` files contain node neighbor counts, ordered node IDs, and
pair distances emitted by the vendored Fortran `neighbor_build` routine after
loading each documented example. Flow tests compare box, triangulation, and
Gabriel lists where the reference path has defined behavior. Force tests load
these lists to isolate force parity from neighbor mode parity.

`apical_gabriel_neighbors.ref` contains the apical contraction graph with
`ffu(2)` set to 1. Generate it with `tools/neighbor_mode_reference.f90` from
`reference/fortran/build` after running `make -C reference/fortran`:

```
gfortran -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy -I. \
  -o neighbor_mode_reference ../../../tools/neighbor_mode_reference.f90 \
  ./*.mod.o ./geompack3.o
./neighbor_mode_reference ../../../reference/examples/apical_contraction/apical_contraction.txt gabriel \
  > ../../../tests/fixtures/apical_gabriel_neighbors.ref
```

`figure_6_triang_neighbors.ref` contains the figure 6 graph with Gabriel
screening disabled for a direct triangulation parity check. Generate it with:

```
./neighbor_mode_reference ../../../reference/examples/figure_6/gastrula.txt triang \
  > ../../../tests/fixtures/figure_6_triang_neighbors.ref
```

The `*_neighbors_restored.ref` files contain neighbor lists after clearing
the current list and calling the Fortran `restore_neighbors` routine. The
migration single-link fixture removes one existing edge before restoration.
`tests/test_neighbor_restore_parity.flow` checks these cases against Flow.
Generate them with `tools/restore_neighbors_reference.f90` from
`reference/fortran/build` after running `make -C reference/fortran`.

The `*_model_prepare.ref` files contain cell centroids and `rdiffmax` after
the Fortran iteration setup calculations. The model preparation parity check
compares these values on all eight examples. `tools/model_prepare_reference.f90`
generates the fixtures from `reference/fortran/build`.

`migration_energy.ref`, `apoptosis_energy.ref`, and
`differential_adhesion_energy.ref` contain the per-node total and six component
energies from the Fortran `energia` routine. The Flow tests compare all seven
fields at every node with relative tolerance 1e-9.

The `*_forces.ref` and added `*_neighbors.ref` files contain per-node force
vectors and neighbor lists emitted by `tools/force_reference.f90` for all eight
documented input examples. Each force row includes the net movement vector,
spring vector, adhesion/repulsion vector, lateral tension vector, and axial
tension vector. `tests/test_biomechanic_force_parity.flow` checks all fifteen
values against the reference with relative tolerance 1e-9. The extra neighbor
fixtures cover examples that use triangulation.

The `*_gene_derivatives.ref` files contain `genestep` derivatives from the
vendored Fortran implementation. `tests/test_gene_derivative_parity.flow`
checks every node and gene for all eight documented inputs with relative
tolerance 1e-9. Rebuild this helper from `reference/fortran/build` with:

```
gfortran -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy -I. \
  -o gene_reference ../../../tools/gene_reference.f90 ./*.mod.o ./geompack3.o
```

Pass an example input path. The helper writes node ID, gene ID, and derivative
rows to standard output.

To rebuild the reference helper after `make -C reference/fortran`, run this
from `reference/fortran/build`:

```
gfortran -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy -I. \
  -o force_reference ../../../tools/force_reference.f90 ./*.mod.o ./geompack3.o
```

Pass an example input and `forces` or `neighbors`. For example:

```
./force_reference ../../../reference/examples/migration/migration.txt forces
```

`migration_rk4.ref` and `migration_movement.ref` contain the node positions
after one fixed RK4 step and one adaptive RK4 step. `tools/movement_reference.f90`
generates them. `tests/test_biomechanic_movement_parity.flow` checks both
against Flow within relative tolerance 1e-9. Build the helper from
`reference/fortran/build` with:

```
gfortran -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy -I. \
  -o movement_reference ../../../tools/movement_reference.f90 ./*.mod.o ./geompack3.o
```

Pass the migration input path and optionally `rk4` to select the fixed step.

The `*_ecm.ref` files contain per-node ECM accumulation after one call to the
Fortran `should_I_secrete` routine. `tests/test_ecm_secretion.flow` compares
the Flow update across all eight examples with relative tolerance 1e-9. These
inputs do not cross the secretion threshold, so the reference emits no ECM
nodes during this check.

The `*_ecm_emit.ref` fixtures contain one directly emitted ECM node and the
source and new-node gene matrices. `tests/test_ecm_node_parity.flow` checks
this path on all eight examples, then forces one threshold crossing in the
ECM secretion example to check the `should_I_secrete` call path.

Build the reference helper from `reference/fortran/build` with:

```
gfortran -w -O2 -ffp-contract=off -fallow-invalid-boz -std=legacy -I. \
  -o ecm_reference ../../../tools/ecm_reference.f90 ./*.mod.o ./geompack3.o
```

The default mode records per-node ECM accumulation. `emit` writes the fields
for one directly created ECM node. `trigger` forces one threshold crossing in
the ECM secretion example.

The `*_cell_control.ref` files contain the per-cell minimum and maximum node
counts after `change_minsize_for_div` and `change_maxsize_for_div`. The Flow
test checks both values for all eight examples.

The `*_division_phase.ref` files contain per-cell phase values after the
Fortran division signal update with both division thresholds raised above the
current cell sizes. This isolates phase accumulation from mitosis. The Flow
test compares phase values on all eight examples.

The `*_division.ref` files contain node ownership and cell state after one
forced phase-triggered division. `tests/test_mitosis_division_parity.flow`
checks six examples with a movable cell of at least four nodes.
`tools/division_reference.f90` generates the fixtures through the Fortran
`should_I_divide` path.

The `*_single_division.ref` files record the new nodes and daughter cell state
after a forced `should_I_divide_single` call. The Flow test checks six examples
with supported neighbor modes. `tools/single_division_reference.f90` generates
these fixtures.

The `*_single_polarization_new.ref` and `*_single_polarization_old.ref` files
record cell polarity after `polarization_single` with a synthetic spatial gene
signal. The two files exercise both `ffu(9)` branches on six examples.
`tools/single_polarization_reference.f90` generates the fixtures, and
`tests/test_single_node_polarization.flow` compares the Flow values.

The `*_contraction_diffusion.ref` files record node growth requirements after
one `diffusion_of_reqcr` call with a fixed node-index signal. The parity check
covers the six examples that use supported neighbor modes. The reference helper
is `tools/diffusion_reference.f90`.

The `*_unbiased_noise.ref` files record node positions after one unbiased
`itera` move. The parity check covers migration, apoptosis, and differential
adhesion. `tools/noise_reference.f90` generates the fixtures.

The `*_apoptosis.ref` fixtures record node and cell topology after removing
the first epithelial node and its pair. The `*_death_step.ref` fixtures record
the same state after one `should_I_die` call. The Flow parity check compares
node indexing, pair links, cell membership, positions, and node radii across
all eight examples.

The `*_growth.ref` fixtures contain per-node current and previous radii after
one `should_I_grow` call. `tests/test_growth_parity.flow` checks those values
on all eight examples. These cases exercise radius updates without reaching a
new-node threshold.

The `*_growth_add.ref` files record the full model state after forcing one cell
through one growth node addition. `tests/test_growth_add_parity.flow` checks all
node records and cell membership in seven cases. The `figure_6` case checks
node counts and placement bounds because its Fortran path uses an uninitialized
node index when no epithelial candidate is far enough from the cell center.
`tools/growth_add_reference.f90` generates these fixtures.

The `migration_extended_neighbors.ref` and `migration_extended_inter_neighbors.ref` files record the modern `ffu(23)=1`, `ffu(24)=1` graph for migration. The second fixture sets `ffu(17)=1`. Generate them with `tools/neighbor_mode_reference.f90` using `extended` or `extended_inter`. Flow checks ordered IDs and distances in `tests/test_neighbor_extended.flow` and `tests/test_neighbor_extended_inter.flow`.
The `migration_legacy_extended_neighbors.ref` and `migration_legacy_extended_inter_neighbors.ref` files cover the `ffu(9)=1`, `ffu(23)=1` legacy branch with both `ffu(17)` settings. Flow checks these graphs in `tests/test_neighbor_legacy_extended.flow` and `tests/test_neighbor_legacy_extended_inter.flow`.
The `*_extended_node_neighbors.ref` fixtures apply `neighbor_build_node(1)` after the full graph build. They cover modern and legacy extended modes with both `ffu(17)` settings.
