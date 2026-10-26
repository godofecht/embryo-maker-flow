#!/usr/bin/env python3
"""Run paired morphology hypotheses on the bundled sea urchin model."""

from __future__ import annotations

import csv
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "runs" / "gastrulation_hypotheses"
BASE = ROOT / "reference" / "examples" / "sea_urchin_gastrulation" / "sea_urchin.txt"
EXAMPLE_DIR = ROOT / "reference" / "examples" / "sea_urchin_gastrulation_hypotheses"
ITERATIONS = int(os.environ.get("HYPOTHESIS_ITERATIONS", "500"))
sys.path.insert(0, str(ROOT / "tools"))
import embryomaker_mcp as mcp  # noqa: E402


CONDITIONS = [
    ("control", None, None, "Bundled sea urchin gastrulation input", "baseline"),
    ("low_epithelial_deformation", 28, 0.15,
     "Lower the maximum req value allowed by epithelial deformation from 0.5 to 0.15. Predict a shallower vegetal invagination.", "decrease"),
    ("high_ecm_threshold", 16, 0.30,
     "Raise the ECM release threshold from 0.1 to 0.3. Predict delayed or weaker vegetal invagination.", "decrease"),
    ("slow_req_diffusion", 26, 0.25,
     "Lower req diffusion from 1.0 to 0.25. Predict a sharper, deeper vegetal invagination as the signal spreads more slowly.", "increase"),
]


def source_gene_expression(path: Path) -> list[list[float]]:
    lines = path.read_bytes().replace(b"\0", b"").decode("utf-8", "replace").splitlines()
    start = next(i for i, line in enumerate(lines) if line.strip() == "G matrix: gene expression")
    rows: list[list[float]] = []
    for line in lines[start + 1:]:
        fields = line.split()
        if len(fields) != 6 or not fields[0].isdigit():
            continue
        try:
            rows.append([float(value) for value in fields[1:]])
        except ValueError:
            continue
    if not rows:
        raise RuntimeError("Could not read the starting gene expression matrix")
    return rows


def parameter_variant(index: int, value: float, name: str) -> Path:
    lines = BASE.read_text(errors="replace").splitlines(keepends=True)
    section = next(i for i, line in enumerate(lines) if line.strip() == "parameters")
    for i in range(section + 1, len(lines)):
        fields = lines[i].split()
        if not fields:
            continue
        if fields[0].isdigit() and int(fields[0]) == index:
            match = re.match(r"^(\s*\d+\s+)\S+(.*)$", lines[i], flags=re.DOTALL)
            if not match:
                raise RuntimeError(f"Malformed global parameter row {index}")
            lines[i] = match.group(1) + format(value, ".17g") + match.group(2)
            path = EXAMPLE_DIR / f"{name}.txt"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("".join(lines))
            return path
    raise RuntimeError(f"Global parameter row {index} was not found")


def run_model(binary: Path, input_path: Path, name: str) -> Path:
    snapshot = OUT / "snapshots" / f"{name}_{ITERATIONS}.dat"
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env["EMBRYO_THREADS"] = "1"
    result = subprocess.run(
        [str(binary), str(input_path), str(ITERATIONS), str(snapshot)],
        cwd=ROOT, env=env, text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise RuntimeError((result.stderr or result.stdout)[-6000:])
    return snapshot


def morphology(snapshot: Path, initial_cap: list[bool]) -> dict[str, float | int]:
    start = mcp.node_positions(snapshot, "node properties at time 0 (nodeo)")
    final = mcp.node_positions(snapshot, "node properties")
    if len(start) != len(final) or len(start) < len(initial_cap):
        raise RuntimeError("Snapshot node sections are inconsistent with the starting input")
    original = start[:len(initial_cap)]
    center = [sum(row[k] for row in original) / len(original) for k in range(3)]
    radius = sum(math.dist(center, row) for row in original) / len(original)
    cap = [i for i, active in enumerate(initial_cap) if active]
    equator = [i for i, row in enumerate(original) if abs(row[2] - center[2]) <= 0.25 * radius]
    if not cap or not equator:
        raise RuntimeError("Starting input has no vegetal marker nodes or equatorial nodes")
    dz_cap = sum(final[i][2] - start[i][2] for i in cap) / len(cap)
    dz_equator = sum(final[i][2] - start[i][2] for i in equator) / len(equator)
    score = -(dz_cap - dz_equator) / radius
    return {
        "nodes": len(start),
        "vegetal_marker_nodes": len(cap),
        "equatorial_nodes": len(equator),
        "mean_vegetal_dz": dz_cap,
        "mean_equatorial_dz": dz_equator,
        "invagination_score": score,
        "mean_displacement": sum(math.dist(a, b) for a, b in zip(start, final)) / len(start),
        "max_displacement": max(math.dist(a, b) for a, b in zip(start, final)),
        "mean_radius_start": radius,
    }


def write_svg(results: list[dict], starts: list[tuple[float, float, float]], cap_mask: list[bool]) -> None:
    width, height, panel_w = 1200, 330, 300
    scale, cx, cy = 58.0, 150.0, 175.0
    colors = ["#1976d2", "#c0392b", "#e67e22", "#7d3c98"]
    chunks = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
              '<rect width="100%" height="100%" fill="#fff"/>',
              '<style>text{font-family:system-ui,sans-serif;fill:#222}.title{font-size:14px;font-weight:600}.small{font-size:11px}.axis{stroke:#bbb;stroke-width:1}</style>']
    for panel, result in enumerate(results):
        xoff = panel * panel_w
        name = result["name"]
        positions = mcp.node_positions(Path(result["snapshot"]), "node properties")
        chunks.append(f'<text class="title" x="{xoff+14}" y="22">{name.replace("_", " ")}</text>')
        chunks.append(f'<text class="small" x="{xoff+14}" y="40">invagination score {result["metrics"]["invagination_score"]:.4f}</text>')
        chunks.append(f'<line class="axis" x1="{xoff+cx-scale*2}" y1="{cy}" x2="{xoff+cx+scale*2}" y2="{cy}"/>')
        chunks.append(f'<line class="axis" x1="{xoff+cx}" y1="{cy-scale*2}" x2="{xoff+cx}" y2="{cy+scale*2}"/>')
        for i, (x, _, z) in enumerate(starts):
            xx, yy = xoff + cx + scale*x, cy - scale*z
            chunks.append(f'<circle cx="{xx:.2f}" cy="{yy:.2f}" r="1.15" fill="#bbb" opacity="0.34"/>')
        for i, (x, _, z) in enumerate(positions):
            xx, yy = xoff + cx + scale*x, cy - scale*z
            color = colors[panel] if i < len(cap_mask) and cap_mask[i] else "#263238"
            chunks.append(f'<circle cx="{xx:.2f}" cy="{yy:.2f}" r="1.15" fill="{color}" opacity="0.72"/>')
    chunks.append('<text class="small" x="14" y="318">gray: starting x-z projection. dark: final shell. color: starting vegetal gene 1-positive nodes.</text>')
    chunks.append('</svg>')
    (OUT / "morphology.svg").write_text("\n".join(chunks))


def main() -> None:
    if ITERATIONS < 1:
        raise SystemExit("HYPOTHESIS_ITERATIONS must be positive")
    OUT.mkdir(parents=True, exist_ok=True)
    build = subprocess.run(["flow", "build"], cwd=ROOT, text=True, capture_output=True, check=False)
    if build.returncode:
        raise RuntimeError((build.stderr or build.stdout)[-6000:])
    binary = Path.home() / "flow" / "build" / "embryomaker"
    if not binary.is_file():
        raise RuntimeError(f"Flow build did not produce {binary}")
    expression = source_gene_expression(BASE)
    cap_mask = [row[0] > 0.5 for row in expression]
    results = []
    reuse_existing = os.environ.get("HYPOTHESIS_REUSE_EXISTING") == "1"
    for name, index, value, hypothesis, direction in CONDITIONS:
        if index is None:
            input_path = BASE
            change = None
        else:
            input_path = parameter_variant(int(index), float(value), name)
            change = {"kind": "parameter", "row": int(index), "value": float(value)}
        reusable = OUT / "snapshots" / f"{name}_{ITERATIONS}.dat"
        snapshot = reusable if reuse_existing and reusable.is_file() else run_model(binary, input_path, name)
        metrics = morphology(snapshot, cap_mask)
        results.append({"name": name, "hypothesis": hypothesis, "prediction_direction": direction,
                        "input": str(input_path.relative_to(ROOT)),
                        "snapshot": str(snapshot.relative_to(ROOT)), "metrics": metrics,
                        "changed_factor": change})
        print(json.dumps(results[-1], sort_keys=True), flush=True)
    starts = mcp.node_positions(Path(results[0]["snapshot"]), "node properties at time 0 (nodeo)")
    write_svg(results, starts, cap_mask)
    for item in results:
        if item["name"] == "control":
            item["difference_from_control"] = 0.0
            item["prediction_result"] = "baseline"
        else:
            difference = item["metrics"]["invagination_score"] - results[0]["metrics"]["invagination_score"]
            item["difference_from_control"] = difference
            expected = item["prediction_direction"]
            observed = "increase" if difference > 1e-12 else ("decrease" if difference < -1e-12 else "no detectable change")
            item["observed_direction"] = observed
            item["prediction_result"] = "supported" if observed == expected else ("opposite" if observed != "no detectable change" else observed)
    fields = ["condition", "hypothesis", "changed_factor", "changed_value", "prediction_result", "difference_from_control", *results[0]["metrics"].keys(), "snapshot"]
    with (OUT / "metrics.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for item in results:
            writer.writerow({"condition": item["name"], "hypothesis": item["hypothesis"],
                             "changed_factor": json.dumps(item["changed_factor"], sort_keys=True) if item["changed_factor"] else "",
                             "changed_value": (item["changed_factor"] or {}).get("value", ""),
                             "prediction_result": item["prediction_result"],
                             "difference_from_control": item["difference_from_control"],
                             **item["metrics"], "snapshot": item["snapshot"]})
    (OUT / "results.json").write_text(json.dumps({
        "model": str(BASE.relative_to(ROOT)), "iterations": ITERATIONS, "backend": "C", "threads": 1,
        "seed": "Each condition starts from the identical bundled input and its stored seed.",
        "morphology_metric": "Invagination score = minus (mean vegetal-marker dz minus mean equatorial dz), divided by initial mean radius. Larger positive values indicate relative inward movement of the starting gene 1-positive vegetal cap along +z.",
        "results": results,
    }, indent=2) + "\n")
    write_readme(results)


def write_readme(results: list[dict]) -> None:
    lines = ["# Sea urchin gastrulation hypothesis runs", "",
             f"Each condition advances the same bundled input for {ITERATIONS} Flow iterations with the same stored random seed and one solver thread.", "",
             "The expected morphology is inward movement of the vegetal pole, represented by nodes with gene 1 active in the starting input. The invagination score is the cap's mean z displacement relative to nodes near the equator, divided by the starting mean radius. A larger positive score means greater relative inward movement along +z.", "",
             "Each result describes one seed and one run of this simulator. The measurements describe model behavior under these inputs.", "",
             "## Predictions and measurements", "",
             "| Condition | Single change | Score | Change from control | Prediction result |", "|---|---|---:|---:|---|"]
    for item in results:
        change = item["changed_factor"]
        change_text = "none" if change is None else f"parameter row {change['row']} = {change['value']}"
        delta = item.get("difference_from_control", 0.0)
        outcome = item.get("prediction_result", "baseline")
        lines.append(f"| {item['name']} | {change_text} | {item['metrics']['invagination_score']:.5f} | {delta:+.5f} | {outcome} |")
    lines.extend(["", "## Files", "", "- `morphology.svg`: x-z projections. Gray dots show the starting shell. Colored dots mark starting gene 1-positive nodes at the final step.", "- `metrics.csv`: compact condition metrics.", "- `results.json`: complete run metadata and metrics.", "- `reference/examples/sea_urchin_gastrulation_hypotheses/`: variant inputs listed in the Studio model picker.", "- `snapshots/`: final states for inspection in Studio.", "", "## Reproduce", "", "```sh", "python3 tools/run_gastrulation_hypotheses.py", "```", "", "Set `HYPOTHESIS_ITERATIONS=1000` to advance each condition for 1,000 iterations.", ""])
    (OUT / "README.md").write_text("\n".join(lines))


if __name__ == "__main__":
    main()
