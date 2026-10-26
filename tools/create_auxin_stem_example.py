#!/usr/bin/env python3
"""Build a seven-cell auxin-response stem input from an explicit geometry recipe."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "reference/examples/polar_growth/polar_growth.txt"
OUTPUT = ROOT / "reference/examples/auxin_stem_growth/auxin_stem_growth.txt"
RING = (
    (0.35, 0.0),
    (0.21822143065055674, 0.27364101886381043),
    (-0.077882326884710015, 0.34122476926363826),
    (-0.31533910376584662, 0.15185930869114536),
    (-0.31533910376584662, -0.15185930869114536),
    (-0.077882326884710015, -0.34122476926363826),
    (0.21822143065055674, -0.27364101886381043),
)


def fmt(value: float) -> str:
    return f"{value: .16E}"


def main() -> None:
    lines = TEMPLATE.read_bytes().decode("latin1").replace("\x00", "").splitlines()

    # Rebuild the seven-cell geometry as a one-cell-wide basal-to-apical tube.
    # Each cell gets two seven-node rings at radius 0.35 and half-height 0.25.
    node_sections = [
        next(i for i, line in enumerate(lines) if line.strip() == "node properties"),
        next(i for i, line in enumerate(lines) if line.strip().startswith("node properties at time 0")),
    ]
    centers = {}
    cell_sections = []
    for i, line in enumerate(lines):
        fields = line.split()
        if len(fields) >= 2 and fields[0] == "cell" and fields[1].isdigit():
            cell_sections.append((i, int(fields[1])))
    for start, cell_id in cell_sections:
        centroid = next(i for i in range(start, len(lines)) if "centroid x,y and z" in lines[i])
        centers[cell_id] = (0.0, 0.0, 0.7 * (cell_id - 1))
        target = centers[cell_id]
        lines[centroid] = "  " + "  ".join(fmt(v) for v in target) + " centroid x,y and z coordinated"

    node_cells = {}
    for section in node_sections:
        changed = 0
        for i in range(section + 3, section + 103):
            fields = lines[i].split()
            if len(fields) < 35:
                continue
            try:
                float(fields[0])
            except ValueError:
                continue
            node_id = changed + 1
            cell_id = int(fields[29])
            node_cells[node_id] = cell_id
            local = (node_id - 1) % 14
            ring, point = divmod(local, 7)
            target_z = 0.7 * (cell_id - 1)
            coords = (*RING[point], target_z + (-0.25 if ring == 0 else 0.25))
            fields[0:3] = [fmt(v) for v in coords]
            # Keep the reference coordinates consistent with the new geometry.
            fields[16:19] = [fmt(v) for v in coords]
            lines[i] = "  " + "  ".join(fields)
            changed += 1
            if changed == 98:
                break
        if changed != 98:
            raise RuntimeError(f"Expected 98 node rows, found {changed} in section {section}")

    # Gene 1 is an auxin response. Gene 2 is mobile auxin, supplied at the tip.
    # Gene 1 responds to gene 2 and drives the simulator's cell-growth property.
    w = next(i for i, line in enumerate(lines) if "W matrix:" in line)
    for gene_id in (1, 2):
        row = next(i for i in range(w + 1, w + 8) if lines[i].split()[:2] == ["gen", str(gene_id)])
        values = [0.0, 0.0]
        if gene_id == 1:
            values[1] = 1.0
        lines[row] = f"gen {gene_id:3d}  " + "  ".join(fmt(v) for v in values)

    ec = next(i for i, line in enumerate(lines) if "E and C matrix:" in line)
    for gene_id in (1, 2):
        row = next(i for i in range(ec + 1, ec + 6) if lines[i].split()[:2] == ["gen", str(gene_id)])
        values = [0.0] * 52
        if gene_id == 1:
            values[35] = 0.5
        lines[row] = f"gen {gene_id:3d}  " + "  ".join(fmt(v) for v in values)

    # Gene metadata: auxin response is a local regulatory molecule. Auxin is a
    # diffusible form, so the apex source spreads into nearby cells.
    for gene_id, diffusivity, degradation, kind in ((1, 0.0, 0.5, 1), (2, 0.5, 0.0, 4)):
        gene_line = next(i for i, line in enumerate(lines) if line.split() == ["gene", str(gene_id)])
        lines[gene_line + 1] = f"  {fmt(diffusivity)} diffusivity"
        lines[gene_line + 2] = f"  {fmt(degradation)} degradation rate"
        lines[gene_line + 3] = f"  {fmt(float(kind))} type, 0 TF, 1 modofiable FT, 2 form"

    g = next(i for i, line in enumerate(lines) if "G matrix: gene expression" in line)
    changed = 0
    for i in range(g + 1, len(lines)):
        fields = lines[i].split()
        if len(fields) != 3 or fields[0] != str(changed + 1):
            continue
        node_id = changed + 1
        cell_id = node_cells[node_id]
        response = 0.0
        auxin = 1.0 if cell_id == 7 else 0.0
        lines[i] = f"{node_id:6d}  {fmt(response)}  {fmt(auxin)}"
        changed += 1
        if changed == 98:
            break
    if changed != 98:
        raise RuntimeError(f"Expected 98 gene-expression rows, found {changed}")

    # Enable epithelial tissue growth.
    for i, line in enumerate(lines):
        if "L1 treat each" in line:
            lines[i] = "           1" + line[12:]
            break

    # Set the active movement and growth temperature.
    for i, line in enumerate(lines):
        if "M(TEM)" in line:
            lines[i] = line.replace("9.9999999999999995E-07", "1.0000000000000000E+00")
            break

    while lines and not lines[-1].strip():
        lines.pop()
    OUTPUT.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="latin1")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    print("initial state: 7 cells, basal-to-apical chain, auxin source in cell 7")


if __name__ == "__main__":
    main()
