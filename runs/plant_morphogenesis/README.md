# Simple plant growth mechanisms

This deterministic toy model makes three rules visible in the Studio timeline. The paired shoot comparison keeps lateral buds dormant while a shoot tip supplies an auxin transport proxy. Removing that tip lets the proxy decay and releases bud growth. A second model bends new shoot segments toward a light vector. A third model changes root tip direction toward gravity and delays lateral root emergence.

The branching rule is a reduced auxin transport switch inspired by [Control of bud activation by an auxin transport switch](https://pubmed.ncbi.nlm.nih.gov/19805140/). The root rule is a reduced differential growth response inspired by [An Integrative Model of Plant Gravitropism Linking Statoliths Position and Auxin Transport](https://pmc.ncbi.nlm.nih.gov/articles/PMC8039511/). This model does not represent PIN transport, statoliths, tissue layers, or measured parameter values. It is a qualitative mechanism demonstration.

Reproduce with `python3 tools/run_plant_morphogenesis.py`. The script writes compressed Studio trajectories under `ui/plant_models/` and metrics under `runs/plant_morphogenesis/metrics.csv`.
