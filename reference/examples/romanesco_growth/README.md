# Romanesco-like meristem growth

This is a native EmbryoMaker cell model. It starts from a curved epithelial dome with 96 cells. Each cell has 14 surface nodes. At each selected site, the input sets both a growth-response field and a co-located auxin-like field. The response field drives cell growth, node addition, and force-based movement in EmbryoMaker. The auxin-like field is a marker. It does not regulate growth through a gene network in this example.

The model places primary sites and recursively arranged second- and third-order sites before the run. The solver determines how their growth changes the cell geometry. This model tests the mechanical effect of recursive growth sites. It does not derive phyllotaxis from scratch.

The hypothesis follows work showing that cauliflower meristems can retain a transient floral state and continue as inflorescence meristems. The paper's model associated Romanesco-like cones with larger meristems and a decreasing plastochron. This EmbryoMaker example represents repeated meristem initiation with nested growth sources. It does not include the SALT floral gene network, a measured plastochron, or all of the tissue and organ processes in a broccoli head. [Azpeitia et al., "Cauliflower fractal forms arise from perturbations of floral gene networks" (2021)](https://pubmed.ncbi.nlm.nih.gov/34244409/).

## Native solver comparison

Three runs start from the same cell geometry and advance for 1,000 iterations.

| Condition | New nodes | Cells with growth | Radial variation |
|---|---:|---:|---:|
| Growth cue off | 0 | 0 | 0.0528 |
| Primary sites | 866 | 33 | 0.0740 |
| Recursive sites | 2,896 | 33 | 0.1185 |

The recursive condition adds more nodes and develops greater radial variation than the primary-only condition. The radial coefficient of variation measures the spread of cell-centre distances from the dome centre. It does not measure biological self-similarity by itself.

This run produces stronger surface relief around the nested source field. It still forms a rounded mound. The current 96-cell model does not resolve pointed, self-similar Romanesco cones. It tests a growth hypothesis and does not reconstruct broccoli development.

![Native EmbryoMaker cell nodes after matched simulation runs.](../../../runs/romanesco_growth/morphology.svg)

Rebuild the model and run the comparison with:

```sh
python3 tools/create_romanesco_model.py
python3 tools/run_romanesco_hypotheses.py
```
