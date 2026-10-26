#!/usr/bin/env python3
"""Run matched auxin-source and transport conditions through the local Studio API."""
import argparse
import csv
import json
import math
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "reference/examples/auxin_stem_growth/auxin_stem_growth.txt"


def get(base: str, path: str) -> dict:
    with urllib.request.urlopen(base.rstrip("/") + path, timeout=30) as response:
        return json.load(response)


def post(base: str, path: str, payload: dict) -> dict:
    request = urllib.request.Request(
        base.rstrip("/") + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def variant_text(source: str, diffusion: float, source_on: bool) -> str:
    lines = source.splitlines()
    gene = next(i for i, line in enumerate(lines) if line.split() == ["gene", "2"])
    lines[gene + 1] = f"  {diffusion: .16E} diffusivity"
    if not source_on:
        matrix = next(i for i, line in enumerate(lines) if "G matrix: gene expression" in line)
        for i in range(matrix + 1, len(lines)):
            fields = lines[i].split()
            if len(fields) == 3 and fields[0].isdigit():
                lines[i] = f"{int(fields[0]):6d}  {fields[1]}  0.0000000000000000E+00"
    return "\n".join(lines) + "\n"


def run_condition(base: str, label: str, source: str, diffusion: float, source_on: bool, steps: int) -> dict:
    text = variant_text(source, diffusion, source_on)
    initial = post(base, "/api/session", {"inputText": text, "fileName": label})
    if initial.get("cellCount") != 7 or initial.get("count") != 98:
        raise RuntimeError(f"{label}: unexpected starting geometry {initial.get('cellCount')} cells, {initial.get('count')} nodes")
    post(base, "/api/compute", {"mode": "serial"})
    result = post(base, f"/api/session/{initial['session']}/advance", {"steps": steps})
    nodes = result.get("nodes")
    if not nodes or result.get("iterations") != steps:
        raise RuntimeError(f"{label}: simulation did not return {steps} iterations and node data")
    for node in nodes:
        for value in (node.get("x"), node.get("y"), node.get("z"), *node.get("genes", [])):
            if value is None or not math.isfinite(value):
                raise RuntimeError(f"{label}: non-finite node state")
    by_cell = {cell: [] for cell in range(1, 8)}
    for node in nodes:
        by_cell.setdefault(int(node.get("lineage", 0)), []).append(node)
    means = {}
    for cell, cell_nodes in by_cell.items():
        means[cell] = [sum(n["genes"][g] for n in cell_nodes) / len(cell_nodes) for g in range(2)] if cell_nodes else [0.0, 0.0]
    xs = [n["x"] for n in nodes]
    zs = [n["z"] for n in nodes]
    return {
        "scenario": label,
        "auxin_diffusivity": diffusion,
        "auxin_source": source_on,
        "iterations": result["iterations"],
        "cells": result["cellCount"],
        "nodes": result["count"],
        "apical_auxin_mean": means[7][1],
        "apical_response_mean": means[7][0],
        "cell6_response_mean": means[6][0],
        "basal_response_mean": sum(means[c][0] for c in range(1, 5)) / 4,
        "response_max": max(n["genes"][0] for n in nodes),
        "nodes_by_cell": [len(by_cell[c]) for c in range(1, 8)],
        "stem_height": max(zs) - min(zs),
        "stem_width": max(xs) - min(xs),
        "node_states": nodes,
    }


def write_svg(results: list[dict], path: Path) -> None:
    width, height, panel_width, panel_height = 960, 600, 300, 600
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title desc">',
        '<title id="title">Auxin stem growth hypothesis runs</title>',
        '<desc id="desc">Three matched seven-cell stems colored by auxin-response gene expression after the same number of iterations.</desc>',
        '<rect width="100%" height="100%" fill="#101816"/>',
        '<style>text{font-family:system-ui,sans-serif;fill:#e4ede8}.muted{fill:#9aaca3}.cell{stroke:#07100c;stroke-width:1}</style>',
    ]
    labels = [
        ("Auxin source off", "No source"),
        ("Slow auxin", "Diffusion 0.05"),
        ("Mobile auxin", "Diffusion 0.5"),
    ]
    for panel, result in enumerate(results):
        ox = panel * panel_width
        parts.extend([
            f'<text x="{ox + 18}" y="32" font-size="20" font-weight="650">{labels[panel][0]}</text>',
            f'<text x="{ox + 18}" y="54" font-size="13" class="muted">{labels[panel][1]} · {result["nodes"]} nodes</text>',
        ])
        nodes = result["node_states"]
        xmin, xmax = min(n["x"] for n in nodes), max(n["x"] for n in nodes)
        zmin, zmax = min(n["z"] for n in nodes), max(n["z"] for n in nodes)
        xspan, zspan = max(xmax - xmin, 0.1), max(zmax - zmin, 0.1)
        plot_x, plot_y, plot_w, plot_h = ox + 48, 95, 205, 450
        for node in nodes:
            nx = plot_x + ((node["x"] - xmin) / xspan) * plot_w
            ny = plot_y + plot_h - ((node["z"] - zmin) / zspan) * plot_h
            response = min(max(node["genes"][0], 0.0), 1.0)
            red = round(48 + 45 * response)
            green = round(94 + 150 * response)
            blue = round(75 + 62 * response)
            radius = 3.0 + 1.1 * min(max(node.get("eqd", 0.0), 0.0), 1.0)
            parts.append(f'<circle class="cell" cx="{nx:.2f}" cy="{ny:.2f}" r="{radius:.2f}" fill="rgb({red},{green},{blue})"/>')
        for cell, count in enumerate(result["nodes_by_cell"], start=1):
            parts.append(f'<text x="{ox + 258}" y="{plot_y + plot_h - ((cell - 1) / 6) * plot_h + 4:.1f}" font-size="11" class="muted">{count}</text>')
    parts.extend([
        '<text x="18" y="579" font-size="12" class="muted">Cell color: auxin-response gene 1. Labels on the right show nodes per starting cell.</text>',
        '</svg>',
    ])
    path.write_text("\n".join(parts), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8765")
    parser.add_argument("--iterations", type=int, default=5000)
    parser.add_argument("--output", type=Path, default=ROOT / "runs/auxin_stem_growth")
    args = parser.parse_args()
    if args.iterations < 1 or args.iterations > 10000:
        parser.error("--iterations must be between 1 and 10000")
    examples = get(args.base_url, "/api/examples").get("examples", [])
    if not any(example.get("id") == "auxin_stem_growth" for example in examples):
        raise RuntimeError("Auxin stem growth is missing from the Studio example menu")
    start = post(args.base_url, "/api/session", {"example": "auxin_stem_growth"})
    if start.get("cellCount") != 7 or start.get("count") != 98:
        raise RuntimeError("Studio menu did not load the seven-cell stem input")
    source = INPUT.read_text(encoding="latin1")
    conditions = [
        ("auxin_off", 0.5, False),
        ("slow_auxin", 0.05, True),
        ("mobile_auxin", 0.5, True),
    ]
    results = [run_condition(args.base_url, label, source, diffusion, active, args.iterations) for label, diffusion, active in conditions]
    off, slow, mobile = results
    if off["nodes"] != 98 or off["response_max"] != 0.0:
        raise RuntimeError("auxin-off control should remain at 98 nodes with no response")
    if not (slow["apical_response_mean"] > 0 and mobile["apical_response_mean"] > 0):
        raise RuntimeError("auxin source should activate the apical response")
    if mobile["cell6_response_mean"] <= slow["cell6_response_mean"]:
        raise RuntimeError("higher auxin mobility should extend the response into cell 6")
    if not (off["nodes"] < slow["nodes"] <= mobile["nodes"]):
        raise RuntimeError("auxin source and transport did not produce the expected growth-zone node counts")

    args.output.mkdir(parents=True, exist_ok=True)
    rows = [{k: v for k, v in result.items() if k != "node_states"} for result in results]
    with (args.output / "metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        for row in rows:
            row["nodes_by_cell"] = ",".join(map(str, row["nodes_by_cell"]))
            writer.writerow(row)
    (args.output / "results.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    write_svg(results, args.output / "morphology.svg")
    summary = [
        "# Auxin stem growth hypothesis run",
        "",
        f"All conditions ran for {args.iterations:,} iterations from the same seven-cell stem input.",
        "Gene 2 is auxin. Gene 1 is its transcriptional response and carries the cell-growth effect.",
        "",
        "| Condition | Auxin diffusion | Nodes | Apical response | Cell 6 response | Nodes by cell, basal to tip |",
        "|---|---:|---:|---:|---:|---|",
    ]
    for r in rows:
        summary.append(f'| {r["scenario"]} | {r["auxin_diffusivity"]:.2f} | {r["nodes"]} | {r["apical_response_mean"]:.5f} | {r["cell6_response_mean"]:.5f} | {r["nodes_by_cell"]} |')
    summary.extend(["", "The source-off control tests whether the tip signal is needed. The low- and high-diffusion runs test whether auxin mobility widens the response and growth zone.", "", "Files: `metrics.csv`, `results.json`, `morphology.svg`.", ""])
    (args.output / "README.md").write_text("\n".join(summary), encoding="utf-8")
    restored = post(args.base_url, "/api/session", {"example": "auxin_stem_growth"})
    if restored.get("experiment") != "Auxin stem growth":
        raise RuntimeError("Could not restore the example in the Studio")
    print("\n".join(summary))


if __name__ == "__main__":
    main()
