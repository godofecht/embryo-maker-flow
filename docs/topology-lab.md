# Optional topological vector-field laboratory

Open **Topological fields** in the Studio toolbar, or visit
`http://127.0.0.1:8765/topology` when the local server is running.

This lab is strictly isolated from the EmbryoMaker cell simulator. It generates
Néel/Bloch-type skyrmions, an antiskyrmion and a uniform reference in a square
2D unit-vector field. It measures the oriented Berg–Lüscher lattice solid-angle
charge, displays the out-of-plane component and in-plane arrows, injects seeded
noise, performs illustrative exchange + DMI-like + anisotropy tangent-field
relaxation, and exports the vector field as JSON.

The finite open boundary generally does **not** ensure integer-valued topological
charge. This is a numerical demonstration, not a validated living-tissue or
micromagnetic model. In particular, the relaxation model does not solve the
Landau–Lifshitz–Gilbert equation and skyrmions are not assumed stable for every
parameter combination.

Run `node tools/test_topology.cjs`. The test is also included in the normal CI
workflow and requires no server or additional JavaScript dependencies.
