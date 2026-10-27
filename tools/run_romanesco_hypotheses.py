#!/usr/bin/env python3
"""Compare recursive and single-order primordium growth in EmbryoMaker."""
from __future__ import annotations

import argparse
import csv
import json
import math
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "reference/examples/romanesco_growth/romanesco_growth.txt"
CELL_COUNT = 96
NODES_PER_CELL = 14


def post(base: str, path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        return json.load(response)


def variant_text(source: str, mode: str) -> str:
    lines = source.splitlines()
    matrix = next(i for i, line in enumerate(lines) if "G matrix: gene expression" in line)
    data_start = next(i for i in range(matrix + 1, len(lines)) if lines[i].strip().startswith("node") and "gene" in lines[i]) + 1
    for i in range(data_start, data_start + CELL_COUNT * NODES_PER_CELL):
        fields = lines[i].split()
        node_id = int(fields[0])
        response = float(fields[1])
        auxin = float(fields[2])
        if mode == "source_off":
            response = 0.0
            auxin = 0.0
        elif mode == "primary_only" and auxin > 0.5:
            response = 0.0
            auxin = 0.0
        fields[1] = f"{response: .16E}"
        fields[2] = f"{auxin: .16E}"
        lines[i] = f"{node_id:6d}  {fields[1]}  {fields[2]}"
    return "\n".join(lines) + "\n"


def analyze(data: dict, label: str, iterations: int) -> dict:
    by_cell: dict[int, list[dict]] = {}
    for node in data["nodes"]:
        by_cell.setdefault(int(node.get("lineage", 0)), []).append(node)
    centers: dict[int, tuple[float, float, float]] = {}
    radii: dict[int, float] = {}
    responses: dict[int, float] = {}
    for cell_id, nodes in by_cell.items():
        center = tuple(sum(node[axis] for node in nodes) / len(nodes) for axis in ("x", "y", "z"))
        centers[cell_id] = center
        radii[cell_id] = math.sqrt(sum(value * value for value in center))
        responses[cell_id] = sum(node.get("genes", [0.0])[0] for node in nodes) / len(nodes)

    cell_ids = list(centers)
    mean_radius = sum(radii.values()) / max(1, len(radii))
    variance = sum((value - mean_radius) ** 2 for value in radii.values()) / max(1, len(radii))
    node_counts = {cell_id: len(nodes) for cell_id, nodes in by_cell.items()}
    higher_order = [cell_id for cell_id in cell_ids if responses[cell_id] > 0.01]
    return {
        "condition": label,
        "iterations": iterations,
        "cells": data["cellCount"],
        "nodes": data["count"],
        "new_nodes": data["count"] - CELL_COUNT * NODES_PER_CELL,
        "cells_with_growth": sum(count > NODES_PER_CELL for count in node_counts.values()),
        "higher_order_growth_cells": sum(node_counts[cell_id] > NODES_PER_CELL for cell_id in higher_order),
        "max_cell_node_count": max(node_counts.values(), default=0),
        "radial_cv": math.sqrt(variance) / max(mean_radius, 1e-12),
        "mean_radius": mean_radius,
        "max_radius": max(radii.values()),
        "mean_growth_response": sum(responses.values()) / max(1, len(responses)),
        "max_growth_response": max(responses.values(), default=0.0),
        "node_states": data["nodes"],
    }


def write_svg(results: list[dict], path: Path) -> None:
    width, height, panel_width, panel_height = 1020, 420, 340, 420
    all_nodes = [node for result in results for node in result["node_states"]]
    xmin, xmax = min(n["x"] for n in all_nodes), max(n["x"] for n in all_nodes)
    zmin, zmax = min(n["z"] for n in all_nodes), max(n["z"] for n in all_nodes)
    xspan, zspan = max(xmax - xmin, 1e-6), max(zmax - zmin, 1e-6)
    plot_x, plot_y, plot_w, plot_h = 35, 82, 265, 285
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Romanesco-like native cell growth hypotheses</title>',
        '<desc id="desc">Three EmbryoMaker runs show an auxin-source control, primary primordia, and recursive primordia after the same number of iterations.</desc>',
        '<rect width="100%" height="100%" fill="#101816"/>',
        '<style>text{font-family:system-ui,sans-serif;fill:#e4ede8}.muted{fill:#9aaca3}.cell{stroke:#07100c;stroke-width:.35}</style>',
    ]
    for panel, result in enumerate(results):
        ox = panel * panel_width
        parts.append(f'<text x="{ox + 18}" y="30" font-size="18" font-weight="650">{result["condition"]}</text>')
        parts.append(f'<text x="{ox + 18}" y="52" font-size="12" class="muted">{result["iterations"]:,} iterations · {result["nodes"]:,} cell nodes</text>')
        for node in result["node_states"]:
            px = ox + plot_x + ((node["x"] - xmin) / xspan) * plot_w
            py = plot_y + plot_h - ((node["z"] - zmin) / zspan) * plot_h
            response = min(max(node.get("genes", [0.0])[0], 0.0), 0.25) / 0.25
            red = round(32 + 26 * response)
            green = round(80 + 150 * response)
            blue = round(58 + 38 * response)
            parts.append(f'<circle class="cell" cx="{px:.2f}" cy="{py:.2f}" r="2.1" fill="rgb({red},{green},{blue})"/>')
        parts.append(f'<text x="{ox + 18}" y="390" font-size="12" class="muted">{result["cells_with_growth"]} cells grew · radial CV {result["radial_cv"]:.3f}</text>')
    parts.extend([
        '<text x="18" y="412" font-size="11" class="muted">Side projection of native cell nodes. Color shows gene 1 growth response.</text>',
        '</svg>',
    ])
    path.write_text("\n".join(parts), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--output", type=Path, default=ROOT / "runs/romanesco_growth")
    args = parser.parse_args()
    if not 1 <= args.iterations <= 10000:
        parser.error("iterations must be between 1 and 10000")

    source = MODEL.read_text(encoding="latin1")
    conditions = [("source_off", "Growth cue off"), ("primary_only", "Primary sites"), ("recursive", "Recursive sites")]
    results = []
    for mode, label in conditions:
        start = post(args.base_url, "/api/session", {"inputText": variant_text(source, mode), "fileName": label})
        if start.get("cellCount") != CELL_COUNT or start.get("count") != CELL_COUNT * NODES_PER_CELL:
            raise RuntimeError(f"{label}: unexpected native start geometry")
        post(args.base_url, "/api/compute", {"mode": "serial"})
        state = post(args.base_url, f"/api/session/{start['session']}/advance", {"steps": args.iterations, "includeSnapshot": False})
        if state.get("iterations") != args.iterations:
            raise RuntimeError(f"{label}: the native solver did not reach the requested iteration")
        if not state.get("nodes") or any(not math.isfinite(node[key]) for node in state["nodes"] for key in ("x", "y", "z")):
            raise RuntimeError(f"{label}: invalid native node state")
        results.append(analyze(state, label, args.iterations))

    off, primary, recursive = results
    if off["nodes"] != CELL_COUNT * NODES_PER_CELL or off["max_growth_response"] != 0.0:
        raise RuntimeError("Source-off control should have no growth response")
    if recursive["max_growth_response"] <= 0.0:
        raise RuntimeError("Recursive meristem sources did not activate native cell growth")
    if recursive["new_nodes"] <= primary["new_nodes"]:
        raise RuntimeError("Recursive initiation did not produce more native cell growth than primary initiation")
    if recursive["higher_order_growth_cells"] < 1:
        raise RuntimeError("Higher-order primordia did not grow in the recursive model")
    if recursive["radial_cv"] <= primary["radial_cv"]:
        raise RuntimeError("Recursive initiation did not increase resolved surface variation over primary initiation")

    args.output.mkdir(parents=True, exist_ok=True)
    public_results = [{key: value for key, value in result.items() if key != "node_states"} for result in results]
    with (args.output / "metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(public_results[0]))
        writer.writeheader()
        writer.writerows(public_results)
    (args.output / "results.json").write_text(json.dumps(public_results, indent=2) + "\n", encoding="utf-8")
    write_svg(results, args.output / "morphology.svg")
    print(json.dumps(public_results, indent=2))


if __name__ == "__main__":
    main()
