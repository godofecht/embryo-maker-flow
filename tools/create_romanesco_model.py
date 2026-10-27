#!/usr/bin/env python3
"""Create a native EmbryoMaker cell model for Romanesco-like meristem growth.

The starting state is a curved epithelial meristem. Local auxin sources activate
growth in a recursively arranged set of primordia. The EmbryoMaker solver moves,
grows, and divides the cells, so the visible relief develops during simulation.
"""
from __future__ import annotations

import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "reference/examples/auxin_stem_growth/auxin_stem_growth.txt"
OUTPUT = ROOT / "reference/examples/romanesco_growth/romanesco_growth.txt"
CELL_COUNT = 96
GOLDEN_ANGLE = math.pi * (3.0 - math.sqrt(5.0))


def fmt(value: float) -> str:
    return f"{value: .16E}"


def unit(v: tuple[float, float, float]) -> tuple[float, float, float]:
    length = math.sqrt(sum(x * x for x in v))
    return tuple(x / length for x in v)


def dot(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def cross(a: tuple[float, float, float], b: tuple[float, float, float]) -> tuple[float, float, float]:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def fibo_hemisphere(count: int, radius: float) -> list[tuple[float, float, float]]:
    # Restrict the meristem samples to the upper hemisphere of a compact curd.
    points = []
    for i in range(count):
        z = 1.0 - (i + 0.5) / count
        r = math.sqrt(max(0.0, 1.0 - z * z))
        theta = i * GOLDEN_ANGLE
        points.append((radius * r * math.cos(theta), radius * r * math.sin(theta), radius * z))
    return points


def local_tangent_basis(normal: tuple[float, float, float]):
    reference = (0.0, 0.0, 1.0) if abs(normal[2]) < 0.9 else (1.0, 0.0, 0.0)
    tangent_x = unit(cross(reference, normal))
    tangent_y = unit(cross(normal, tangent_x))
    return tangent_x, tangent_y


def recursive_primordia(radius: float) -> list[tuple[tuple[float, float, float], int]]:
    """Create initiation sites at three nested meristem scales.

    The parent meristem makes 12 primordia. Each stays indeterminate and
    produces 3 smaller primordia. Those make 2 finer primordia. This encodes
    the published repeated-meristem hypothesis while cell shape and growth are
    resolved by EmbryoMaker.
    """
    primary = fibo_hemisphere(12, radius)
    result = [(point, 0) for point in primary]
    for parent_index, parent in enumerate(primary):
        normal = unit(parent)
        tx, ty = local_tangent_basis(normal)
        phase = parent_index * GOLDEN_ANGLE
        for child in range(2):
            angle = phase + child * 2.0 * math.pi / 3.0
            displacement = tuple(0.32 * (math.cos(angle) * tx[k] + math.sin(angle) * ty[k]) for k in range(3))
            child_point = unit(tuple(parent[k] + displacement[k] for k in range(3)))
            child_point = tuple(radius * x for x in child_point)
            result.append((child_point, 1))
            cx, cy = local_tangent_basis(unit(child_point))
            child_phase = phase + child * GOLDEN_ANGLE
            for grandchild in range(1):
                sub_angle = child_phase + grandchild * math.pi
                sub_displacement = tuple(0.14 * (math.cos(sub_angle) * cx[k] + math.sin(sub_angle) * cy[k]) for k in range(3))
                result.append((tuple(radius * x for x in unit(tuple(child_point[k] + sub_displacement[k] for k in range(3)))), 2))
    return result


def numeric_rows(lines: list[str], start: int, width: int, count: int) -> list[list[str]]:
    rows = []
    for line in lines[start + 1:]:
        fields = line.split()
        if len(fields) != width:
            if rows:
                break
            continue
        try:
            float(fields[0])
        except ValueError:
            if rows:
                break
            continue
        rows.append(fields)
        if len(rows) == count:
            return rows
    raise RuntimeError(f"Expected {count} rows after line {start}, found {len(rows)}")


def find_parameter(lines: list[str], label: str, value: int) -> None:
    for i, line in enumerate(lines):
        if label in line:
            fields = line.split()
            lines[i] = f"{fields[0]:>4} {value: .16E} " + line.split(maxsplit=2)[2]
            return
    raise RuntimeError(f"Missing parameter {label!r}")


def main() -> None:
    lines = TEMPLATE.read_bytes().decode("latin1").replace("\x00", "").splitlines()
    node_sections = [i for i, line in enumerate(lines) if line.strip() == "node properties" or line.strip().startswith("node properties at time 0")]
    template_nodes = numeric_rows(lines, node_sections[0] + 1, 35, 14)
    template_nodes0 = numeric_rows(lines, node_sections[1] + 1, 35, 14)

    cell_header = next(i for i, line in enumerate(lines) if line.strip() == "cell properties")
    cell_start = next(i for i in range(cell_header + 1, len(lines)) if lines[i].strip().startswith("cell ") and lines[i].split()[1] == "1")
    cell_end = next(i for i in range(cell_start + 1, len(lines)) if lines[i].strip().startswith("cell "))
    template_cell = lines[cell_start:cell_end]

    radius = 2.6
    cell_centers = fibo_hemisphere(CELL_COUNT, radius - 0.25)
    source_points = recursive_primordia(radius - 0.25)
    source_cells: dict[int, int] = {}
    for point, level in source_points:
        cell_index = min(range(CELL_COUNT), key=lambda i: sum((cell_centers[i][k] - point[k]) ** 2 for k in range(3)))
        source_cells[cell_index] = max(source_cells.get(cell_index, -1), level)

    old_nodes = 98
    new_nodes = CELL_COUNT * 14
    find_parameter(lines, "Total number of nodes", new_nodes)
    find_parameter(lines, "Total number of cells", CELL_COUNT)

    # Create a curved, single-layer tissue from the same 14-node cell geometry.
    for section_index, template_rows in reversed(list(zip(node_sections, (template_nodes, template_nodes0)))):
        rows = []
        for cell_index, center in enumerate(cell_centers):
            normal = unit(center)
            tx, ty = local_tangent_basis(normal)
            for local_index, source in enumerate(template_rows):
                fields = source.copy()
                x, y, z = (float(source[k]) for k in range(3))
                world = tuple(center[k] + x * tx[k] + y * ty[k] + z * normal[k] for k in range(3))
                fields[0:3] = [fmt(v) for v in world]
                fields[16:19] = [fmt(v) for v in world]
                fields[29] = str(cell_index + 1)
                fields[30] = str(cell_index * 14 + int(source[30]))
                rows.append("  " + "  ".join(fields))
        start = section_index + 3
        end = start
        while end < len(lines):
            fields = lines[end].split()
            if len(fields) == 35:
                try:
                    float(fields[0])
                    end += 1
                    continue
                except ValueError:
                    pass
            if end > start:
                break
            end += 1
        lines[start:end] = rows

    # Replace the initial gene-expression table with a spatial field of local
    # auxin sources. The response gene drives cell growth in the native solver.
    gene_start = next(i for i, line in enumerate(lines) if "G matrix: gene expression" in line)
    gene_rows = []
    for node_id in range(1, new_nodes + 1):
        cell_index = (node_id - 1) // 14
        local_index = (node_id - 1) % 14
        level = source_cells.get(cell_index, -1)
        source_strength = (0.5, 1.0, 1.5)[level] if level >= 0 else 0.0
        # The apical ring faces away from the meristem center. A graded source
        # across the cell shell gives the native polarization routine a vector.
        auxin = source_strength if local_index >= 7 else 0.2 * source_strength
        response = source_strength if local_index >= 7 else 0.2 * source_strength
        gene_rows.append(f"{node_id:6d}  {fmt(response)}  {fmt(auxin)}")
    gene_data_start = next(i for i in range(gene_start + 1, len(lines)) if lines[i].strip().startswith("node") and "gene" in lines[i]) + 1
    gene_data_end = gene_data_start
    while gene_data_end < len(lines) and len(lines[gene_data_end].split()) == 3:
        gene_data_end += 1
    lines[gene_data_start:gene_data_end] = gene_rows

    # Limit auxin-like signal spread so each source retains a local growth zone.
    gene_two = next(i for i, line in enumerate(lines) if line.split() == ["gene", "2"])
    lines[gene_two + 1] = f"  {fmt(0.0)} diffusivity"

    # Increase the response-to-growth coupling while keeping the native growth
    # and mechanics routines intact. This makes primordium relief measurable in
    # a short inspectable run.
    ec = next(i for i, line in enumerate(lines) if "E and C matrix:" in line)
    response_row = next(i for i in range(ec + 2, ec + 6) if lines[i].split()[:2] == ["gen", "1"])
    response_values = lines[response_row].split()[2:]
    response_values[35] = fmt(20.0)
    response_values[42] = fmt(1.0)
    response_values[43] = fmt(0.75)
    lines[response_row] = "gen   1  " + "  ".join(response_values)

    # Replicate the native cell record and update centroids and node membership.
    new_cell_blocks = []
    for cell_index, center in enumerate(cell_centers):
        block = template_cell.copy()
        for i, line in enumerate(block):
            if line.strip().startswith("cell "):
                block[i] = f" cell {cell_index + 1:11d}"
            elif "centroid x,y and z" in line:
                block[i] = "  " + "  ".join(fmt(v) for v in center) + " centroid x,y and z coordinated"
            elif line.strip() == "list of the nodes in the cell":
                block[i + 1] = "  " + "  ".join(f"{node_id:11d}" for node_id in range(cell_index * 14 + 1, cell_index * 14 + 15))
        new_cell_blocks.extend(block)
    cell_header = next(i for i, line in enumerate(lines) if line.strip() == "cell properties")
    lines[cell_header + 2] = f"{CELL_COUNT:12d} number of cells"
    cell_start = next(i for i in range(cell_header + 1, len(lines)) if lines[i].strip().startswith("cell ") and lines[i].split()[1] == "1")
    lines[cell_start:] = new_cell_blocks

    while lines and not lines[-1].strip():
        lines.pop()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="latin1")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")
    print(f"native cells={CELL_COUNT}, nodes={new_nodes}, primordia_sites={len(source_cells)}")


if __name__ == "__main__":
    main()
