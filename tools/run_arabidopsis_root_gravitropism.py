#!/usr/bin/env python3
"""Build an Arabidopsis primary-root gravitropism comparison for Studio."""
from __future__ import annotations

import csv
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "ui/plant_models/arabidopsis_root_gravitropism.json.gz"
REPORT = ROOT / "runs/arabidopsis_root_gravitropism"
STEP_MIN = 10
END_MIN = 720
ROOT_LENGTH_MM = 4.0
BEND_ZONE_MM = 0.9
MM_TO_VIEW = 0.72
LATENCY_H = 10.5 / 60.0


class ProjectBuilder:
    def __init__(self):
        self.nodes: list[dict] = []
        self.cell = 0

    def segment(self, a, b, *, auxin=0.0, pin2=1.0, radius=0.035, cell_type=2):
        self.cell += 1
        first = len(self.nodes) + 1
        shared = {
            "radius": radius,
            "eqd": radius * 0.7,
            "type": cell_type,
            "cell": self.cell,
            "fixed": False,
            "lineage": self.cell,
            "genes": [auxin, pin2],
        }
        for node_id, point, other in ((first, a, first + 1), (first + 1, b, first)):
            x, y, z = point
            self.nodes.append({
                "id": node_id, "x": x, "y": y, "z": z,
                "x0": x, "y0": y, "z0": z, "other": other, **shared,
            })


def auxin_response_ratio(time_min: int, transport_activity: float) -> float:
    """DR5-like lower:upper response proxy, reaching ~23:1 by four hours."""
    elapsed = max(0.0, time_min - 10.0)
    rise = 1.0 - math.exp(-elapsed / 75.0)
    return 1.0 + 22.0 * rise * transport_activity


def pin2_membrane_change(time_min: int) -> tuple[float, float]:
    """Approximate reported lower/upper membrane PIN2 changes in percent."""
    lower = 12.0 * min(1.0, time_min / 120.0) * math.exp(-max(0, time_min - 120) / 240.0)
    upper = -14.0 * min(1.0, time_min / 240.0) * math.exp(-max(0, time_min - 240) / 240.0)
    return lower, upper


def angular_rate(time_min: int, transport_activity: float, gain_per_hour: float) -> float:
    theta_signal = (auxin_response_ratio(time_min, transport_activity) - 1.0) / 22.0
    return gain_per_hour * theta_signal


def integrate_tip_angle(time_min: int, transport_activity: float, gain_per_hour: float) -> float:
    """Integrate a gravity sine-rule response after the measured latent period."""
    theta = 0.0
    for minute in range(STEP_MIN, time_min + 1, STEP_MIN):
        if minute < LATENCY_H * 60:
            continue
        stimulus = max(0.0, math.cos(theta))
        theta += angular_rate(minute, transport_activity, gain_per_hour) * stimulus * STEP_MIN / 60.0
    return min(math.radians(89.5), theta)


def fit_wild_type_gain() -> float:
    """Fit the illustrative WT curve to ~60 degrees at six hours."""
    low, high = 0.0, 10.0
    for _ in range(80):
        mid = (low + high) / 2.0
        if math.degrees(integrate_tip_angle(360, 1.0, mid)) < 60.0:
            low = mid
        else:
            high = mid
    return (low + high) / 2.0


WT_GAIN_PER_HOUR = fit_wild_type_gain()


def root_points(time_min: int, *, base_x: float, transport_activity: float, gain: float):
    theta_tip = integrate_tip_angle(time_min, transport_activity, gain)
    count = 32
    ds = ROOT_LENGTH_MM / count
    points = []
    headings = []
    for i in range(count + 1):
        arc = i * ds
        u = max(0.0, min(1.0, (arc - (ROOT_LENGTH_MM - BEND_ZONE_MM)) / BEND_ZONE_MM))
        bend_fraction = u * u * (3.0 - 2.0 * u)
        headings.append(theta_tip * bend_fraction)
    x, z = base_x, 0.0
    points.append((x, 0.0, z))
    for i in range(count):
        heading = headings[i + 1]
        x += ds * math.cos(heading) * MM_TO_VIEW
        z -= ds * math.sin(heading) * MM_TO_VIEW
        points.append((x, 0.0, z))
    return points, headings, theta_tip


def add_root(builder: ProjectBuilder, time_min: int, *, label: str, base_x: float,
             transport_activity: float, gain: float):
    points, headings, theta_tip = root_points(
        time_min, base_x=base_x, transport_activity=transport_activity, gain=gain
    )
    ratio = auxin_response_ratio(time_min, transport_activity)
    pin2_lower, pin2_upper = pin2_membrane_change(time_min)
    segments = len(points) - 1
    for i, (a, b) in enumerate(zip(points, points[1:])):
        arc = (i + 0.5) * ROOT_LENGTH_MM / segments
        in_elongation_zone = arc >= ROOT_LENGTH_MM - BEND_ZONE_MM
        normal_angle = headings[i + 1]
        normal = (math.sin(normal_angle), 0.0, math.cos(normal_angle))
        tissue_radius = 0.045 * MM_TO_VIEW
        upper_offset = tuple(v * tissue_radius for v in normal)
        lower_offset = tuple(-v * tissue_radius for v in upper_offset)
        upper_a = tuple(a[j] + upper_offset[j] for j in range(3))
        upper_b = tuple(b[j] + upper_offset[j] for j in range(3))
        lower_a = tuple(a[j] + lower_offset[j] for j in range(3))
        lower_b = tuple(b[j] + lower_offset[j] for j in range(3))
        upper_signal = 1.0 / 23.0
        lower_signal = max(upper_signal, min(1.0, ratio / 23.0)) if in_elongation_zone else upper_signal
        lower_pin2 = (1.0 + pin2_lower / 100.0) * transport_activity
        upper_pin2 = (1.0 + pin2_upper / 100.0) * transport_activity
        builder.segment(upper_a, upper_b, auxin=upper_signal, pin2=upper_pin2, radius=0.025)
        builder.segment(lower_a, lower_b, auxin=lower_signal, pin2=lower_pin2, radius=0.025)
        if i % 4 == 0:
            builder.segment(upper_a, lower_a, auxin=(upper_signal + lower_signal) / 2.0,
                            pin2=transport_activity, radius=0.012)

    # Three short crossbars mark the columella/root-cap tissue at the tip.
    cap = points[-1]
    cap_normal = (math.sin(theta_tip), 0.0, math.cos(theta_tip))
    tangent = (math.cos(theta_tip), 0.0, -math.sin(theta_tip))
    for distance in (0.0, 0.055, 0.11):
        center = tuple(cap[j] - tangent[j] * distance * MM_TO_VIEW for j in range(3))
        half_width = 0.065 * MM_TO_VIEW
        a = tuple(center[j] - cap_normal[j] * half_width for j in range(3))
        b = tuple(center[j] + cap_normal[j] * half_width for j in range(3))
        builder.segment(a, b, auxin=0.2, pin2=transport_activity, radius=0.014, cell_type=1)

    # Estimate the side-to-side elongation difference required to make this
    # bend across the configured elongation-zone length.
    curvature_per_mm = theta_tip / BEND_ZONE_MM
    strain_difference = curvature_per_mm * 0.09  # 90 micrometre root diameter
    lower_upper_elongation = (1.0 - strain_difference / 2.0) / (1.0 + strain_difference / 2.0)
    return {
        "time_min": time_min,
        "hours_after_turn": time_min / 60.0,
        "genotype": label,
        "tip_bend_degrees": math.degrees(theta_tip),
        "auxin_response_lower_upper_ratio": ratio,
        "pin2_lower_change_percent": pin2_lower,
        "pin2_upper_change_percent": pin2_upper,
        "lower_upper_elongation_ratio_inferred": lower_upper_elongation,
        "transport_activity_assumption": transport_activity,
    }


def make_frame(time_min: int):
    builder = ProjectBuilder()
    wt = add_root(builder, time_min, label="Col-0 wild type", base_x=-3.4,
                  transport_activity=1.0, gain=WT_GAIN_PER_HOUR)
    pin2 = add_root(builder, time_min, label="pin2/eir1 transport-deficient proxy", base_x=1.0,
                    transport_activity=0.0, gain=WT_GAIN_PER_HOUR)
    return builder.nodes, [wt, pin2]


def write_morphology_plate():
    times = (0, 30, 120, 240, 360, 720)
    colors = ("#9aa6b2", "#74a9cf", "#4575b4", "#2a9d8f", "#e9a23b", "#d65a31")
    width, height = 760, 430
    scale = 125.0
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fbfaf7"/>',
        '<style>text{font-family:Arial,sans-serif;fill:#263238}.title{font-size:21px;font-weight:700}.label{font-size:15px;font-weight:700}.small{font-size:12px}.root{fill:none;stroke-width:4;stroke-linecap:round;stroke-linejoin:round}</style>',
        '<text x="30" y="34" class="title">Arabidopsis thaliana primary-root gravitropism</text>',
        '<text x="30" y="57" class="small">90-degree reorientation. Curves show the simulated root centerline at each time.</text>',
        '<text x="30" y="94" class="label">Col-0 wild type</text>',
        '<text x="30" y="271" class="label">pin2/eir1 transport-deficient proxy</text>',
        '<line x1="70" y1="235" x2="730" y2="235" stroke="#d5d2ca"/>',
        '<line x1="70" y1="400" x2="730" y2="400" stroke="#d5d2ca"/>',
        '<text x="716" y="92" class="small">gravity</text>',
        '<path d="M730 100 L730 126 M724 120 L730 126 L736 120" stroke="#263238" fill="none" stroke-width="2"/>',
    ]
    for row, (name, activity) in enumerate((("Col-0", 1.0), ("pin2", 0.0))):
        baseline = 112 + row * 170
        for time_min, color in zip(times, colors):
            pts, _, _ = root_points(time_min, base_x=0.0, transport_activity=activity, gain=WT_GAIN_PER_HOUR)
            d = " ".join(("M" if i == 0 else "L") + f"{70 + p[0] * scale:.1f},{baseline - p[2] * scale:.1f}" for i, p in enumerate(pts))
            parts.append(f'<path class="root" d="{d}" stroke="{color}"/>')
            tip = pts[-1]
            parts.append(f'<circle cx="{70 + tip[0] * scale:.1f}" cy="{baseline - tip[2] * scale:.1f}" r="3.4" fill="{color}"/>')
    for i, (time_min, color) in enumerate(zip(times, colors)):
        x = 235 + i * 82
        label = f"{time_min} min" if time_min < 60 else f"{time_min // 60} h"
        parts.append(f'<line x1="{x}" y1="418" x2="{x + 20}" y2="418" stroke="{color}" stroke-width="4"/>')
        parts.append(f'<text x="{x + 25}" y="422" class="small">{label}</text>')
    parts.append('</svg>')
    (REPORT / "morphology.svg").write_text("\n".join(parts), encoding="utf-8")


def write_project():
    frames = []
    metrics = []
    for time_min in range(0, END_MIN + 1, STEP_MIN):
        nodes, rows = make_frame(time_min)
        metrics.extend(rows)
        frames.append({
            "iterations": time_min,
            "simulatedTime": time_min / 60.0,
            "experiment": "arabidopsis_root_gravitropism",
            "count": len(nodes),
            "geneCount": 2,
            "nodes": nodes,
            "cells": [],
            "edges": [],
            "triangulationWarning": 0,
        })
    project = {
        "format": "embryomaker-trajectory",
        "version": 1,
        "name": "Arabidopsis thaliana primary-root gravitropism",
        "experiment": "arabidopsis_root_gravitropism",
        "totalIterations": END_MIN,
        "minIteration": 0,
        "maxIteration": END_MIN,
        "frameCount": len(frames),
        "camera": {"yaw": 0.0, "pitch": 0.0, "zoom": 1.0, "panX": 0.0,
                   "panY": 0.0, "cameraDistance": 8.0},
        "display": {"colorMode": "scalar:gene_1", "paletteMode": "green",
                    "pointScale": 1.0, "radiusMode": "add", "showNodes": True,
                    "showCylinders": True},
        "iterations": [f["iterations"] for f in frames],
        "frames": frames,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("wb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as zipped:
            zipped.write(json.dumps(project, separators=(",", ":")).encode())
    REPORT.mkdir(parents=True, exist_ok=True)
    with (REPORT / "metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        fields = list(metrics[0])
        writer = csv.DictWriter(stream, fieldnames=fields, lineterminator="\n")
        writer.writeheader()
        writer.writerows(metrics)
    write_morphology_plate()

    wild_type = [r for r in metrics if r["genotype"] == "Col-0 wild type"]
    mutant = [r for r in metrics if r["genotype"].startswith("pin2/")]
    wt_6h = next(r for r in wild_type if r["time_min"] == 360)
    wt_4h = next(r for r in wild_type if r["time_min"] == 240)
    pin2_6h = next(r for r in mutant if r["time_min"] == 360)
    if abs(wt_6h["tip_bend_degrees"] - 60.0) > 0.2:
        raise RuntimeError("Wild-type trajectory missed its six-hour literature calibration")
    if wt_4h["auxin_response_lower_upper_ratio"] < 20.0:
        raise RuntimeError("Wild-type auxin-response proxy missed the four-hour calibration")
    if pin2_6h["tip_bend_degrees"] != 0.0 or pin2_6h["auxin_response_lower_upper_ratio"] != 1.0:
        raise RuntimeError("The PIN2-deficient comparison should suppress the imposed asymmetry")
    print(f"Arabidopsis root gravitropism: {len(frames)} frames, {sum(f['count'] for f in frames)} node records, {OUT.stat().st_size} compressed bytes")
    print(f"WT: {wt_6h['tip_bend_degrees']:.1f} deg at 6 h; auxin-response proxy {wt_4h['auxin_response_lower_upper_ratio']:.1f}:1 at 4 h")
    print(f"pin2/eir1 proxy: {pin2_6h['tip_bend_degrees']:.1f} deg at 6 h by the suppressed-gradient model")

    (REPORT / "README.md").write_text(
        "# Arabidopsis thaliana primary-root gravitropism\n\n"
        "Hypothesis: suppressing PIN2-dependent lower-side auxin asymmetry prevents the primary root from bending toward gravity after a 90-degree turn.\n\n"
        "The Studio trajectory compares a Col-0 wild-type primary root with a `pin2/eir1`-like transport-deficient case after a 90-degree turn from vertical to horizontal. Gravity points down. The root cap is drawn at each growing tip. Curvature is confined to a 0.9 mm distal elongation zone. Color encodes the lower-side auxin-response proxy.\n\n"
        "The model uses a 10.5 minute response latency from Mullen et al. (2000), a sine-rule gravity dependence from that study, and a gain fitted to 60 degrees of wild-type curvature at six hours, consistent with the reported control trajectory in Hou et al. (2004). The lower-to-upper DR5 response is calibrated to approximately 23:1 at four hours, as reported by Su et al. (2016). The `pin2/eir1` comparison suppresses the imposed auxin asymmetry, based on experiments where pin2 lines failed to establish the gravity-induced auxin response gradient.\n\n"
        "The six-hour angle, response gain, and cell geometry are model calibrations. The mutant trajectory is a mechanistic comparison, not a digitization of a specific allele time series. The inferred lower-to-upper elongation ratio is calculated from root diameter and bend-zone length. PIN trafficking is represented by the reported relative changes at the two root sides. No cell-resolved transport or mechanical wall model is solved.\n\n"
        "References: [Mullen et al. 2000](https://pmc.ncbi.nlm.nih.gov/articles/PMC59034/), [Hou et al. 2004](https://onlinelibrary.wiley.com/doi/10.1111/j.1365-313X.2004.02114.x), [Su et al. 2016](https://www.nature.com/articles/ncomms9822), [AUX1 acts upstream of PIN2](https://pubmed.ncbi.nlm.nih.gov/30449597/).\n\n"
        "Regenerate with `python3 tools/run_arabidopsis_root_gravitropism.py`. Metrics are in `metrics.csv`; the compressed trajectory is in `ui/plant_models/arabidopsis_root_gravitropism.json.gz`.\n",
        encoding="utf-8",
    )
    return project, metrics


if __name__ == "__main__":
    write_project()
