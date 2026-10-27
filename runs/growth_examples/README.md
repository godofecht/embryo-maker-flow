# Growth examples

## Arabidopsis thaliana Col-0 seedling

The 10-day trajectory shows the primary root, lateral root primordia and emerging laterals, hypocotyl, opposite cotyledons, and successive true leaves. The mean lateral-primordium spacing (1.6 mm) and day 5 to 10 primary-root extension (10.8 mm/day) come from published Col-0 plate measurements. Root length through day 5, lateral-root emergence timing and bending, cotyledon dimensions, and visible leaf dimensions are model assumptions. True leaves use a 24-hour plastochron and 137-degree divergence as approximate long-day pattern values. This model represents organ-scale development. Cell-level mechanics remain outside its scope.

## Neurospora crassa

The 16-hour trajectory shows conidial swelling, a germ tube, a leading hypha, and subapical branches. Germ tube polarization around 3 hours, a primary hypha by 5 hours, and branches by 10 hours follow published observations. Germling elongation uses a reported collar-stage rate; mature extension uses the reported 3 mm/hour colony growth rate as a simplified tip-growth approximation. Branch placement and branch geometry are illustrative.

## A673 human cancer spheroid

The trajectory shows a growing equatorial cross-section. A673 spheroids show hypoxia staining above 500 micrometres in diameter and visible central necrosis around 550 to 650 micrometres. Near maximum size, reported necrosis occupies 50 to 60 percent of spheroid volume. The model uses a 100 micrometre proliferative rim as a geometry assumption and ramps the necrotic core from zero at 550 micrometres to 55 percent of volume at 700 micrometres. Intermediate shapes and cell states are a compact reconstruction of those observations.

## C. elegans early embryo

This 90-minute trajectory shows the invariant lineage from the zygote through the 8-cell stage at 20 C. It displays the unequal P0 cleavage, AB and P1, ABa and ABp, EMS and P2, then ABal, ABar, ABpl, ABpr, MS, E, C, and P3. Cell division timings are approximate reconstructions of the published lineage. Cell positions and the eggshell outline are schematic. Cell fate colors encode lineage class. They are illustrative.

Rebuild with `python3 tools/run_growth_examples.py`. The compressed viewer trajectories are under `ui/plant_models/`. Per-frame values are in the CSV files here.

References:
- [Priming and positioning of lateral roots in Arabidopsis](https://pmc.ncbi.nlm.nih.gov/articles/PMC4762386/)
- [Phyllotactic regularity requires the Paf1 complex in Arabidopsis](https://pmc.ncbi.nlm.nih.gov/articles/PMC5769633/)
- [CLAVATA3 Signaling Buffers Arabidopsis Shoot Apical Meristem Activity](https://pmc.ncbi.nlm.nih.gov/articles/PMC11394970/)
- [The Genetic Basis of Cellular Morphogenesis in Neurospora crassa](https://pmc.ncbi.nlm.nih.gov/articles/PMC266756/)
- [Dissecting Colony Development of Neurospora crassa](https://pmc.ncbi.nlm.nih.gov/articles/PMC2547062/)
- [From Cap to Collar: Ontogeny of the Endocytic Collar](https://pmc.ncbi.nlm.nih.gov/articles/PMC12387980/)
- [Linking hypoxia, DNA damage and proliferation in multicellular tumor spheroids](https://pmc.ncbi.nlm.nih.gov/articles/PMC5437385/)
- [The embryonic cell lineage of the nematode Caenorhabditis elegans](https://pubmed.ncbi.nlm.nih.gov/6684600/)
