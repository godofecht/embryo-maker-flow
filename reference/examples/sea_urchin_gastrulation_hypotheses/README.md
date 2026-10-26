# Sea urchin gastrulation tests

The runner creates three parameter variants from the bundled sea urchin gastrulation state. Each changes one global parameter, runs from the same seed, and measures the resulting morphology.

The expected morphology is inward movement at the vegetal pole. The accompanying local run measured the starting gene 1-positive cap's z displacement against the equator after 500 iterations. A larger score means more inward cap movement. The C backend used one solver thread and the seed stored in the shared starting input.

![Four x-z projections after 500 iterations. Gray marks starting positions. Dark marks final positions. Color marks the starting vegetal cap at its final position.](../../../docs/assets/gastrulation-hypotheses.svg)

| Studio case | Change | Prediction | Score at 500 iterations | Result |
|---|---|---|---:|---|
| Low epithelial deformation | Parameter 28, M(DFE), 0.5 to 0.15 | Shallower invagination | 0.13856, control 0.20673 | In the predicted direction |
| High ECM threshold | Parameter 16, M(ECM), 0.1 to 0.3 | Shallower or delayed invagination | 0.32255, control 0.20673 | Opposite direction. Final node count was 3,553 versus 3,610 in control |
| Low req diffusion | Parameter 26, dif_req, 1.0 to 0.25 | Sharper, deeper invagination | 0.20673, control 0.20673 | No change in final node positions. Mean and maximum position differences were both zero |

The low deformation result agrees with its prediction. The ECM result runs against its prediction. The diffusion change has no measurable effect on this starting state at this horizon. Each result describes one paired run with one seed. The measurements describe simulator behavior under these inputs. Biological claims need separate evidence.

To reproduce all runs and regenerate the CSV, JSON, and morphology projection, run:

```sh
HYPOTHESIS_ITERATIONS=500 python3 tools/run_gastrulation_hypotheses.py
```

The measurements and final snapshots are written under `runs/gastrulation_hypotheses/`.

The run generates `morphology.svg`. To make a PNG copy, run `rsvg-convert -o runs/gastrulation_hypotheses/morphology.png runs/gastrulation_hypotheses/morphology.svg`.
