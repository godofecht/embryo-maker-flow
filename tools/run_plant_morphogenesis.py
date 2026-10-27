#!/usr/bin/env python3
"""Generate small, explicit plant growth trajectories for the Studio viewer."""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "ui/plant_models"
DEFAULT_REPORT = ROOT / "runs/plant_morphogenesis"
STEPS = 60


def vec_add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def vec_scale(a, k):
    return tuple(x * k for x in a)


class FrameBuilder:
    def __init__(self):
        self.nodes = []
        self.cell_id = 0

    def segment(self, a, b, radius=0.09, auxin=0.0, response=0.0):
        self.cell_id += 1
        first = len(self.nodes) + 1
        common = {
            "radius": radius,
            "eqd": radius * 0.7,
            "type": 2,
            "cell": self.cell_id,
            "fixed": False,
            "lineage": self.cell_id,
            "genes": [response, auxin],
        }
        for node_id, position, other in ((first, a, first + 1), (first + 1, b, first)):
            x, y, z = position
            self.nodes.append({
                "id": node_id, "x": x, "y": y, "z": z,
                "x0": x, "y0": y, "z0": z,
                "other": other,
                **common,
            })

    def lance_leaf(self, base, azimuth, length=0.40, auxin=0.0):
        direction = (math.cos(azimuth), math.sin(azimuth), 0.32)
        direction_length = math.sqrt(sum(v * v for v in direction))
        direction = vec_scale(direction, 1 / direction_length)
        side = (-math.sin(azimuth), math.cos(azimuth), 0.0)
        midrib = [vec_add(base, vec_scale(direction, length * t)) for t in (0.0, 0.34, 0.68, 1.0)]
        for a, b in zip(midrib, midrib[1:]):
            self.segment(a, b, radius=0.025, auxin=auxin)
        for i, width in ((1, 0.10), (2, 0.065)):
            center = midrib[i]
            for sign in (-1, 1):
                tip = vec_add(center, vec_add(vec_scale(direction, length * 0.16), vec_scale(side, sign * width)))
                self.segment(center, tip, radius=0.014, auxin=auxin)


def add_axis(builder, points, radius, auxin_values=None, response_values=None):
    auxin_values = auxin_values or [0.0] * (len(points) - 1)
    response_values = response_values or [0.0] * (len(points) - 1)
    for i, (a, b) in enumerate(zip(points, points[1:])):
        builder.segment(a, b, radius, auxin_values[i], response_values[i])


def shoot_points(step, cut=False):
    tip_steps = min(step, 18) if cut else step
    count = 5 + tip_steps // 3
    return [(0.0, 0.0, 0.14 * i) for i in range(count + 1)]


def shoot_scene(step):
    builder = FrameBuilder()
    metrics = {"iteration": step, "intact_branch_length": 0.0, "cut_branch_length": 0.0, "cut_shoot_height": 0.0}
    for offset, cut in ((-1.25, False), (1.25, True)):
        points = shoot_points(step, cut)
        points = [(x + offset, y, z) for x, y, z in points]
        source = 1.0 if not cut or step < 18 else 0.0
        inhibitor = 1.0 if not cut or step < 18 else math.exp(-(step - 18) / 8.0)
        auxin = [source * math.exp(-i / 9.0) for i in range(len(points) - 1)]
        response = [max(0.0, 1.0 - inhibitor) if cut else 0.0 for _ in auxin]
        add_axis(builder, points, 0.095, auxin, response)
        if len(points) > 2:
            for leaf_index in range(1, len(points) - 1, 2):
                base = points[leaf_index]
                phase = leaf_index * 2.399963229728653
                builder.lance_leaf(base, phase, auxin=auxin[min(leaf_index, len(auxin) - 1)])

        branch_sum = 0.0
        if cut:
            bud_positions = list(range(1, len(points) - 1, 2))
            for bud_index, anchor_index in enumerate(bud_positions):
                length = min(0.82, max(0.0, step - 18) * 0.021 * max(0.0, 1.0 - inhibitor))
                if length < 0.035:
                    continue
                branch_sum += length
                base = points[anchor_index]
                sign = -1 if bud_index % 2 == 0 else 1
                heading = sign * math.radians(48)
                branch = [base]
                for segment_index in range(1, math.ceil(length / 0.13) + 1):
                    distance = min(length, segment_index * 0.13)
                    branch.append((base[0] + math.sin(heading) * distance, 0.0, base[2] + math.cos(heading) * distance))
                add_axis(builder, branch, 0.065, [1.0 - inhibitor] * (len(branch) - 1), [1.0 - inhibitor] * (len(branch) - 1))
                builder.lance_leaf(branch[-1], heading + sign * 1.2, length=0.24, auxin=1.0 - inhibitor)
            metrics["cut_branch_length"] = branch_sum
            metrics["cut_shoot_height"] = points[-1][2]
        else:
            metrics["intact_branch_length"] = 0.0
    return builder.nodes, metrics


def phototropic_scene(step):
    builder = FrameBuilder()
    points = [(0.0, 0.0, 0.0)]
    heading = 0.0
    segment_count = 5 + step // 2
    signal = 0.0
    for i in range(segment_count):
        light_error = math.pi / 2 - heading
        signal = max(0.0, math.sin(light_error))
        heading += 0.035 * signal
        previous = points[-1]
        points.append((previous[0] + 0.14 * math.sin(heading), 0.0, previous[2] + 0.14 * math.cos(heading)))
    auxin = [max(0.0, min(1.0, 0.25 + 0.65 * signal * math.exp(-(len(points) - i - 2) / 7))) for i in range(len(points) - 1)]
    response = [abs(auxin[i] - 0.25) for i in range(len(auxin))]
    add_axis(builder, points, 0.09, auxin, response)
    for leaf_index in range(2, len(points), 3):
        builder.lance_leaf(points[leaf_index], leaf_index * 2.399963229728653, auxin=auxin[min(leaf_index - 1, len(auxin) - 1)])
    return builder.nodes, {
        "iteration": step,
        "stem_length": 0.14 * segment_count,
        "tip_x": points[-1][0],
        "tip_z": points[-1][2],
        "tip_heading_degrees": math.degrees(heading),
    }


def root_scene(step):
    builder = FrameBuilder()
    segment_count = 5 + step // 2
    angle = math.radians(42) * math.exp(-step / 20)
    points = [(0.0, 0.0, 0.0)]
    headings = []
    for i in range(segment_count):
        # Growth adds new tissue at the tip. Older segments retain their
        # previous orientation while the tip approaches the gravity vector.
        local_angle = angle * math.exp(-(segment_count - i - 1) / 5)
        headings.append(local_angle)
        previous = points[-1]
        points.append((previous[0] + 0.14 * math.sin(local_angle), 0.0, previous[2] - 0.14 * math.cos(local_angle)))
    asymmetry = min(1.0, step / 20) * 0.35
    auxin = [0.45 + asymmetry * math.exp(-(len(points) - i - 2) / 5) for i in range(len(points) - 1)]
    response = [asymmetry * math.exp(-(len(points) - i - 2) / 5) for i in range(len(points) - 1)]
    add_axis(builder, points, 0.08, auxin, response)

    lateral_length = max(0.0, step - 22) * 0.012
    lateral_tip_count = 0
    for index, sign in ((max(1, segment_count // 3), -1), (max(2, (segment_count * 2) // 3), 1)):
        length = min(0.42, lateral_length)
        if length < 0.035 or index >= len(points) - 1:
            continue
        lateral_tip_count += 1
        base = points[index]
        branch_angle = sign * math.radians(55)
        count = max(1, math.ceil(length / 0.12))
        branch = [base]
        for j in range(1, count + 1):
            distance = min(length, j * 0.12)
            branch.append((base[0] + sign * math.sin(math.radians(55)) * distance, 0.0, base[2] - math.cos(math.radians(55)) * distance))
        add_axis(builder, branch, 0.045, [0.7] * (len(branch) - 1), [0.2] * (len(branch) - 1))
    return builder.nodes, {
        "iteration": step,
        "root_length": 0.14 * segment_count,
        "tip_x": points[-1][0],
        "tip_z": points[-1][2],
        "tip_angle_from_gravity_degrees": math.degrees(abs(headings[-1])) if headings else 42.0,
        "lateral_root_count": lateral_tip_count,
    }


def project(model_id, name, frame_fn, steps=STEPS):
    frames = []
    metrics = []
    for step in range(steps + 1):
        nodes, row = frame_fn(step)
        metrics.append(row)
        frames.append({
            "iterations": step,
            "simulatedTime": float(step),
            "experiment": model_id,
            "count": len(nodes),
            "geneCount": 2,
            "nodes": nodes,
            "cells": [],
            "edges": [],
            "triangulationWarning": 0,
        })
    return {
        "format": "embryomaker-trajectory",
        "version": 1,
        "name": name,
        "experiment": model_id,
        "totalIterations": steps,
        "minIteration": 0,
        "maxIteration": steps,
        "frameCount": len(frames),
        "camera": {"yaw": 0.0, "pitch": 0.0, "zoom": 1.0, "panX": 0.0, "panY": 0.0, "cameraDistance": 7.0},
        "display": {"colorMode": "scalar:gene_1", "paletteMode": "green", "pointScale": 1.0, "radiusMode": "add", "showNodes": True, "showCylinders": True},
        "iterations": list(range(steps + 1)),
        "frames": frames,
    }, metrics


def save_project(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, separators=(",", ":")).encode()
    with path.open("wb") as stream:
        with gzip.GzipFile(fileobj=stream, mode="wb", mtime=0) as compressed:
            compressed.write(payload)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    parser.add_argument("--steps", type=int, default=STEPS)
    args = parser.parse_args()
    if not 30 <= args.steps <= 200:
        parser.error("--steps must be between 30 and 200")

    models = [
        ("shoot_branching", "Shoot branching after apex removal", shoot_scene),
        ("shoot_phototropism", "Shoot growth toward light", phototropic_scene),
        ("root_gravitropism", "Root growth toward gravity", root_scene),
    ]
    args.output.mkdir(parents=True, exist_ok=True)
    args.report.mkdir(parents=True, exist_ok=True)
    all_rows = []
    for model_id, title, frame_fn in models:
        data, rows = project(model_id, title, frame_fn, args.steps)
        path = args.output / f"{model_id}.json.gz"
        save_project(path, data)
        all_rows.extend({"model": model_id, **row} for row in rows)
        print(f"{model_id}: {len(data['frames'])} frames, {sum(len(f['nodes']) for f in data['frames'])} node records, {path.stat().st_size} compressed bytes")

    fieldnames = sorted({key for row in all_rows for key in row})
    with (args.report / "metrics.csv").open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        writer.writerows(all_rows)

    shoot = [row for row in all_rows if row["model"] == "shoot_branching"]
    photo = [row for row in all_rows if row["model"] == "shoot_phototropism"]
    root = [row for row in all_rows if row["model"] == "root_gravitropism"]
    if max(row["intact_branch_length"] for row in shoot) != 0:
        raise RuntimeError("Intact shoot control grew lateral branches")
    if shoot[-1]["cut_branch_length"] <= 0:
        raise RuntimeError("Removing the apex failed to release dormant buds")
    if photo[-1]["tip_x"] <= photo[0]["tip_x"]:
        raise RuntimeError("Light response did not bend the shoot toward the light")
    if root[-1]["tip_angle_from_gravity_degrees"] >= root[0]["tip_angle_from_gravity_degrees"]:
        raise RuntimeError("Root response did not align growth with gravity")
    (args.report / "README.md").write_text(
        "# Simple plant growth mechanisms\n\n"
        "This deterministic toy model makes three rules visible in the Studio timeline. "
        "The paired shoot comparison keeps lateral buds dormant while a shoot tip supplies an auxin transport proxy. "
        "Removing that tip lets the proxy decay and releases bud growth. A second model bends new shoot segments toward a light vector. "
        "A third model changes root tip direction toward gravity and delays lateral root emergence.\n\n"
        "The branching rule is a reduced auxin transport switch inspired by [Control of bud activation by an auxin transport switch](https://pubmed.ncbi.nlm.nih.gov/19805140/). "
        "The root rule is a reduced differential growth response inspired by [An Integrative Model of Plant Gravitropism Linking Statoliths Position and Auxin Transport](https://pmc.ncbi.nlm.nih.gov/articles/PMC8039511/). "
        "This model does not represent PIN transport, statoliths, tissue layers, or measured parameter values. It is a qualitative mechanism demonstration.\n\n"
        "Reproduce with `python3 tools/run_plant_morphogenesis.py`. The script writes compressed Studio trajectories under `ui/plant_models/` and metrics under `runs/plant_morphogenesis/metrics.csv`.\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
