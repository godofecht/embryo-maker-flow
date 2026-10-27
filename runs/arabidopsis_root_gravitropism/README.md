# Arabidopsis thaliana primary-root gravitropism

Hypothesis: suppressing PIN2-dependent lower-side auxin asymmetry prevents the primary root from bending toward gravity after a 90-degree turn.

The Studio trajectory compares a Col-0 wild-type primary root with a `pin2/eir1`-like transport-deficient case after a 90-degree turn from vertical to horizontal. Gravity points down. The root cap is drawn at each growing tip. Curvature is confined to a 0.9 mm distal elongation zone. Color encodes the lower-side auxin-response proxy.

The model uses a 10.5 minute response latency from Mullen et al. (2000), a sine-rule gravity dependence from that study, and a gain fitted to 60 degrees of wild-type curvature at six hours, consistent with the reported control trajectory in Hou et al. (2004). The lower-to-upper DR5 response is calibrated to approximately 23:1 at four hours, as reported by Su et al. (2016). The `pin2/eir1` comparison suppresses the imposed auxin asymmetry, based on experiments where pin2 lines failed to establish the gravity-induced auxin response gradient.

The six-hour angle, response gain, and cell geometry are model calibrations. The mutant trajectory is a mechanistic comparison, not a digitization of a specific allele time series. The inferred lower-to-upper elongation ratio is calculated from root diameter and bend-zone length. PIN trafficking is represented by the reported relative changes at the two root sides. No cell-resolved transport or mechanical wall model is solved.

References: [Mullen et al. 2000](https://pmc.ncbi.nlm.nih.gov/articles/PMC59034/), [Hou et al. 2004](https://onlinelibrary.wiley.com/doi/10.1111/j.1365-313X.2004.02114.x), [Su et al. 2016](https://www.nature.com/articles/ncomms9822), [AUX1 acts upstream of PIN2](https://pubmed.ncbi.nlm.nih.gov/30449597/).

Regenerate with `python3 tools/run_arabidopsis_root_gravitropism.py`. Metrics are in `metrics.csv`; the compressed trajectory is in `ui/plant_models/arabidopsis_root_gravitropism.json.gz`.
