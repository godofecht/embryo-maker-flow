# Optional nematic defect field lab

The experimental page `http://127.0.0.1:8765/nematic` shows the
director-field topology of two-dimensional active nematics independently
from EmbryoMaker's cell simulation.

Unlike magnetic skyrmions, nematic defects involve an **unoriented**
director `n ≡ -n`. The implementation stores the **doubled director
angle** as `(cos 2θ, sin 2θ)`, so that there is no discontinuity
when the drawn director changes sign. A contour that winds this doubled
angle once corresponds to a physical director topological charge
`q = +1/2`; the negative counterpart winds it in reverse.

The square contour integrator sums principal angular differences over
the closed boundary and divides by `4π`. It supports selectable loop
radii and seeded director noise. The demonstrator also provides
diffusive nearest-neighbor alignment relaxation and JSON export.

The model has no coupling to tissue cells, active contractile stresses,
hydrodynamic velocities, shape deformation or biological signaling.
It demonstrates topological *classification* of director fields, not
causal morphogenesis.

```sh
node tools/test_nematic.cjs
```

The test covers ±½, +1 and uniform reference fields at multiple loop
radii, deterministic noise, relaxation and normalization. The main
GitHub Actions workflow runs it in addition to the cell simulation
and existing skyrmion lab checks.
