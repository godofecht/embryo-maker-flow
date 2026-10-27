#!/usr/bin/env python3
"""Build curved shoot, forked shoot, and branched root simulator inputs."""
from pathlib import Path
import math

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "reference/examples/auxin_stem_growth/auxin_stem_growth.txt"
OUT = ROOT / "reference/examples/plant_morphologies"
RING = (
    (0.35, 0.0),
    (0.21822143065055674, 0.27364101886381043),
    (-0.077882326884710015, 0.34122476926363826),
    (-0.31533910376584662, 0.15185930869114536),
    (-0.31533910376584662, -0.15185930869114536),
    (-0.077882326884710015, -0.34122476926363826),
    (0.21822143065055674, -0.27364101886381043),
)


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def scale(a, amount):
    return tuple(x * amount for x in a)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def unit(a):
    length = math.sqrt(dot(a, a))
    if length < 1e-9:
        raise ValueError("Plant segment has zero length")
    return scale(a, 1 / length)


def fmt(value):
    return f"{value: .16E}"


def update_model(path_points, edges, source_cells, output_name):
    lines = SOURCE.read_bytes().decode("latin1").replace("\x00", "").splitlines()
    node_sections = [
        next(i for i, line in enumerate(lines) if line.strip() == "node properties"),
        next(i for i, line in enumerate(lines) if line.strip().startswith("node properties at time 0")),
    ]
    nodes_by_cell = {cell: [] for cell in range(1, 8)}
    node_cells = {}
    cell_starts = []
    for i, line in enumerate(lines):
        fields = line.split()
        if len(fields) >= 2 and fields[0] == "cell" and fields[1].isdigit():
            cell_starts.append((i, int(fields[1])))

    for section in node_sections:
        found = 0
        for i in range(section + 3, len(lines)):
            fields = lines[i].split()
            if len(fields) < 35:
                continue
            try:
                cell_id = int(fields[29])
            except ValueError:
                continue
            if not 1 <= cell_id <= 7:
                continue
            node_id = found + 1
            ring_index = len(nodes_by_cell[cell_id]) % 14
            ring, point = divmod(ring_index, 7)
            start, end = edges[cell_id]
            origin, destination = path_points[start], path_points[end]
            tangent = unit(sub(destination, origin))
            reference = (0.0, 0.0, 1.0)
            if abs(dot(tangent, reference)) > 0.92:
                reference = (1.0, 0.0, 0.0)
            lateral = unit(cross(tangent, reference))
            normal = unit(cross(tangent, lateral))
            along = 0.14 if ring == 0 else 0.86
            center = add(origin, scale(sub(destination, origin), along))
            rx, ry = RING[point]
            position = add(center, add(scale(lateral, rx), scale(normal, ry)))
            fields[0:3] = [fmt(v) for v in position]
            fields[16:19] = [fmt(v) for v in position]
            lines[i] = "  " + "  ".join(fields)
            nodes_by_cell[cell_id].append(node_id)
            node_cells[node_id] = cell_id
            found += 1
            if found == 98:
                break
        if found != 98:
            raise RuntimeError(f"Expected 98 node rows in section {section}, found {found}")

    if any(len(nodes) != 28 for nodes in nodes_by_cell.values()):
        raise RuntimeError("Expected 14 nodes per cell in both geometry sections")

    for line_index, cell_id in cell_starts:
        centroid_line = next(i for i in range(line_index, len(lines)) if "centroid x,y and z" in lines[i])
        start, end = edges[cell_id]
        midpoint = scale(add(path_points[start], path_points[end]), 0.5)
        lines[centroid_line] = "  " + "  ".join(fmt(v) for v in midpoint) + " centroid x,y and z coordinated"

    expression = next(i for i, line in enumerate(lines) if "G matrix: gene expression" in line)
    changed = 0
    for i in range(expression + 1, len(lines)):
        fields = lines[i].split()
        if len(fields) != 3 or not fields[0].isdigit():
            continue
        node_id = int(fields[0])
        if node_id not in node_cells:
            continue
        auxin = 1.0 if node_cells[node_id] in source_cells else 0.0
        lines[i] = f"{node_id:6d}  {fmt(0.0)}  {fmt(auxin)}"
        changed += 1
        if changed == 98:
            break
    if changed != 98:
        raise RuntimeError(f"Expected 98 gene-expression rows, found {changed}")

    while lines and not lines[-1].strip():
        lines.pop()
    destination = OUT / output_name
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text("\n".join(line.rstrip() for line in lines) + "\n", encoding="latin1")
    print(f"wrote {destination.relative_to(ROOT)}")


def main():
    curved = [
        (0, 0, 0), (0, 0, .7), (0, 0, 1.4), (.05, 0, 2.1),
        (.25, 0, 2.75), (.6, 0, 3.35), (1.1, 0, 3.9), (1.75, 0, 4.35),
    ]
    chain = {i: (i - 1, i) for i in range(1, 8)}
    update_model(curved, chain, {7}, "curved_shoot.txt")

    fork_points = [
        (0, 0, 0), (0, 0, .7), (0, 0, 1.4), (0, 0, 2.1),
        (-.25, 0, 2.75), (-.7, 0, 3.3), (.25, 0, 2.75), (.7, 0, 3.3),
    ]
    fork_edges = {1: (0, 1), 2: (1, 2), 3: (2, 3), 4: (3, 4), 5: (4, 5), 6: (3, 6), 7: (6, 7)}
    update_model(fork_points, fork_edges, {5, 7}, "forked_shoot.txt")

    root_points = [
        (0, 0, 2.1), (0, 0, 1.4), (0, 0, .7), (0, 0, 0),
        (-.3, 0, -.55), (-.7, 0, -1.05), (.3, 0, -.55), (.7, 0, -1.05),
    ]
    root_edges = {1: (0, 1), 2: (1, 2), 3: (2, 3), 4: (3, 4), 5: (4, 5), 6: (3, 6), 7: (6, 7)}
    update_model(root_points, root_edges, {5, 7}, "branched_root.txt")


if __name__ == "__main__":
    main()
