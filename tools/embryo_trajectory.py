#!/usr/bin/env python3
"""Unified EmbryoMaker trajectory container and converter.

Converts between raw .dat snapshots, web-ready .embtraj files, and NumPy .npz archives.
"""

from __future__ import annotations

import argparse
import gzip
import json
from pathlib import Path
import sys
from typing import Any, Dict, List, Optional, Tuple
import numpy as np


def parse_snapshot_full(path: Path) -> Dict[str, Any]:
    """Parse complete physics and genetic state from an EmbryoMaker .dat snapshot."""
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    # Read parameters
    iteration = 0
    simulated_time = 0.0
    node_count = 0
    gene_count = 1
    cell_count = 0

    try:
        p_idx = lines.index("parameters")
        cursor = p_idx + 1
        while cursor < len(lines) and not lines[cursor].strip():
            cursor += 1
        while cursor < len(lines) and lines[cursor].strip():
            parts = lines[cursor].split()
            if len(parts) >= 2:
                param_id = int(parts[0])
                val = float(parts[1])
                if param_id == 1:
                    iteration = int(round(val))
                elif param_id == 10:
                    node_count = int(round(val))
                elif param_id == 13:
                    simulated_time = val
                elif param_id == 18:
                    cell_count = int(round(val))
                elif param_id == 19:
                    gene_count = int(round(val))
            cursor += 1
    except ValueError:
        pass

    # Read gene expressions
    genes_by_node: Dict[int, List[float]] = {}
    try:
        g_idx = lines.index("node gene values")
        cursor = g_idx + 1
        while cursor < len(lines) and lines[cursor].strip():
            parts = lines[cursor].split()
            if parts:
                node_id = int(parts[0])
                vals = [float(x) for x in parts[1:]]
                genes_by_node[node_id] = vals
            cursor += 1
    except ValueError:
        pass

    # Read node parameters (35 fields per node)
    try:
        np_idx = lines.index("node parameters")
    except ValueError:
        try:
            np_idx = lines.index("node properties")
            while np_idx < len(lines) and lines[np_idx].strip() != "node parameters":
                np_idx += 1
        except ValueError:
            np_idx = -1

    nodes: List[Dict[str, Any]] = []
    if np_idx != -1:
        cursor = np_idx + 1
        while cursor < len(lines) and not lines[cursor].strip():
            cursor += 1
        idx = 1
        while cursor < len(lines) and lines[cursor].strip():
            f = lines[cursor].split()
            if len(f) >= 29:
                x = float(f[0])
                y = float(f[1])
                z = float(f[2])
                energy = float(f[3]) if len(f) > 3 else 0.0
                eqd = float(f[4]) if len(f) > 4 else 0.1
                radius = float(f[5]) if len(f) > 5 else 0.2
                you = float(f[6]) if len(f) > 6 else 10.0
                adh = float(f[7]) if len(f) > 7 else 0.0
                rep = float(f[8]) if len(f) > 8 else 10.0
                rec = float(f[9]) if len(f) > 9 else 5.0
                erp = float(f[10]) if len(f) > 10 else 10.0
                est = float(f[11]) if len(f) > 11 else 10.0
                eqs = float(f[12]) if len(f) > 12 else 0.15
                hoo = float(f[13]) if len(f) > 13 else 10.0
                mov = float(f[14]) if len(f) > 14 else 0.01
                dmo = float(f[15]) if len(f) > 15 else 0.001
                x0 = float(f[16]) if len(f) > 16 else x
                y0 = float(f[17]) if len(f) > 17 else y
                z0 = float(f[18]) if len(f) > 18 else z
                ecm = float(f[19]) if len(f) > 19 else 0.0
                cod = float(f[20]) if len(f) > 20 else 0.0
                grd = float(f[21]) if len(f) > 21 else eqd
                pld = float(f[22]) if len(f) > 22 else 0.0
                vod = float(f[23]) if len(f) > 23 else 0.0
                dif = float(f[24]) if len(f) > 24 else 0.0
                kfi = float(f[25]) if len(f) > 25 else 10.0
                pla = float(f[26]) if len(f) > 26 else 0.0
                kvol = float(f[27]) if len(f) > 27 else 5.0
                node_type = int(f[28])
                cell = int(f[29]) if len(f) > 29 else 1
                other = int(f[30]) if len(f) > 30 else 0
                marge = int(f[31]) if len(f) > 31 else 0
                talone = int(f[32]) if len(f) > 32 else 0
                fixed = int(f[33]) if len(f) > 33 else 0
                ndiv = int(f[34]) if len(f) > 34 else 0

                g_vals = genes_by_node.get(idx, [0.0] * max(1, gene_count))
                nodes.append({
                    "id": idx,
                    "x": x, "y": y, "z": z,
                    "energy": energy, "eqd": eqd, "radius": radius,
                    "you": you, "adh": adh, "rep": rep, "rec": rec,
                    "erp": erp, "est": est, "eqs": eqs, "hoo": hoo,
                    "mov": mov, "dmo": dmo,
                    "x0": x0, "y0": y0, "z0": z0,
                    "ecm": ecm, "cod": cod, "grd": grd, "pld": pld, "vod": vod,
                    "dif": dif, "kfi": kfi, "pla": pla, "kvol": kvol,
                    "phase": 0.0, "elongationFactor": 1.0,
                    "moveX": 0.0, "moveY": 0.0, "moveZ": 0.0,
                    "repX": 0.0, "repY": 0.0, "repZ": 0.0,
                    "lateralX": 0.0, "lateralY": 0.0, "lateralZ": 0.0,
                    "axialX": 0.0, "axialY": 0.0, "axialZ": 0.0,
                    "fixed": bool(fixed),
                    "type": node_type,
                    "cell": cell,
                    "other": other,
                    "marge": marge,
                    "talone": talone,
                    "ndiv": ndiv,
                    "lineage": cell,
                    "box": 1,
                    "genes": g_vals
                })
                idx += 1
            cursor += 1

    # Extract distinct cells
    cells_dict: Dict[int, Dict[str, Any]] = {}
    for n in nodes:
        cid = n["cell"]
        if cid not in cells_dict:
            cells_dict[cid] = {
                "id": cid,
                "x": n["x"], "y": n["y"], "z": n["z"],
                "phase": 0.0, "polx": 0.0, "poly": 0.0, "polz": 0.0,
                "type": n["type"]
            }

    # Epithelial edges between paired apical/basal nodes
    edges: List[Dict[str, Any]] = []
    for n in nodes:
        if n["other"] > n["id"]:
            edges.append({"a": n["id"], "b": n["other"], "inter": False})

    return {
        "experiment": "Sea Urchin Gastrulation",
        "iterations": iteration,
        "simulatedTime": simulated_time,
        "count": len(nodes),
        "geneCount": max(1, gene_count),
        "nodes": nodes,
        "cells": list(cells_dict.values()),
        "edges": edges,
        "boxGrid": {"spacing": 0, "count": 0}
    }


def build_trajectory(dat_files: List[Path], experiment_name: str = "Sea Urchin Gastrulation") -> Dict[str, Any]:
    """Assemble a sorted list of .dat snapshots into a trajectory structure."""
    frames = []
    iterations = []
    print(f"Parsing {len(dat_files)} snapshot frames...")
    for i, p in enumerate(dat_files):
        frame = parse_snapshot_full(p)
        frame["experiment"] = experiment_name
        frames.append(frame)
        iterations.append(frame["iterations"])
        if (i + 1) % 10 == 0 or i == len(dat_files) - 1:
            print(f"  Parsed {i + 1}/{len(dat_files)} frames (iteration {frame['iterations']})")

    min_iter = min(iterations) if iterations else 0
    max_iter = max(iterations) if iterations else 0

    return {
        "format": "embryomaker-trajectory",
        "version": 1,
        "experiment": experiment_name,
        "totalIterations": max_iter,
        "minIteration": min_iter,
        "maxIteration": max_iter,
        "frameCount": len(frames),
        "iterations": iterations,
        "frames": frames
    }


def save_embtraj(trajectory: Dict[str, Any], output_path: Path, compress: bool = False) -> None:
    """Save trajectory as an .embtraj file (optionally gzipped)."""
    text = json.dumps(trajectory, separators=(",", ":"))
    if compress or output_path.suffix == ".gz":
        with gzip.open(output_path, "wt", encoding="utf-8") as f:
            f.write(text)
    else:
        output_path.write_text(text, encoding="utf-8")
    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"Saved .embtraj trajectory: {output_path} ({size_mb:.2f} MB)")


def save_npz(trajectory: Dict[str, Any], output_path: Path) -> None:
    """Save trajectory as compressed NumPy array archive."""
    frames = trajectory["frames"]
    all_coords = []
    all_types = []
    all_cells = []
    all_radii = []
    all_genes = []
    all_iters = []
    all_times = []

    for f in frames:
        nodes = f["nodes"]
        coords = np.array([[n["x"], n["y"], n["z"]] for n in nodes], dtype=np.float64)
        types = np.array([n["type"] for n in nodes], dtype=np.int32)
        cells = np.array([n["cell"] for n in nodes], dtype=np.int32)
        radii = np.array([n["radius"] for n in nodes], dtype=np.float64)
        genes = np.array([n["genes"][0] if n["genes"] else 0.0 for n in nodes], dtype=np.float64)

        all_coords.append(coords)
        all_types.append(types)
        all_cells.append(cells)
        all_radii.append(radii)
        all_genes.append(genes)
        all_iters.append(f["iterations"])
        all_times.append(f["simulatedTime"])

    max_nodes = max(len(c) for c in all_coords)
    n_frames = len(frames)

    padded_coords = np.full((n_frames, max_nodes, 3), np.nan, dtype=np.float64)
    padded_types = np.full((n_frames, max_nodes), -1, dtype=np.int32)
    padded_cells = np.full((n_frames, max_nodes), -1, dtype=np.int32)
    padded_radii = np.full((n_frames, max_nodes), np.nan, dtype=np.float64)
    padded_genes = np.full((n_frames, max_nodes), np.nan, dtype=np.float64)
    node_counts = np.array([len(c) for c in all_coords], dtype=np.int32)

    for i in range(n_frames):
        k = len(all_coords[i])
        padded_coords[i, :k] = all_coords[i]
        padded_types[i, :k] = all_types[i]
        padded_cells[i, :k] = all_cells[i]
        padded_radii[i, :k] = all_radii[i]
        padded_genes[i, :k] = all_genes[i]

    np.savez_compressed(
        output_path,
        iterations=np.array(all_iters, dtype=np.int32),
        simulated_times=np.array(all_times, dtype=np.float64),
        node_counts=node_counts,
        coords=padded_coords,
        types=padded_types,
        cells=padded_cells,
        radii=padded_radii,
        gene1=padded_genes
    )
    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"Saved NumPy .npz trajectory: {output_path} ({size_mb:.2f} MB)")


def main():
    parser = argparse.ArgumentParser(description="Package EmbryoMaker simulation snapshots into trajectory files.")
    parser.add_argument("--frames-dir", type=Path, default=Path("build/sea_urchin_video/frames"), help="Directory of .dat files")
    parser.add_argument("--pattern", type=str, default="urchin_*.dat", help="Glob pattern for snapshots")
    parser.add_argument("--embtraj-out", type=Path, default=Path("build/sea_urchin_video/sea_urchin_trajectory.embtraj"), help="Output path for .embtraj file")
    parser.add_argument("--npz-out", type=Path, default=Path("build/sea_urchin_video/sea_urchin_trajectory.npz"), help="Output path for .npz file")
    parser.add_argument("--experiment", type=str, default="Sea Urchin Gastrulation", help="Experiment name")
    args = parser.parse_args()

    files = sorted(args.frames_dir.glob(args.pattern), key=lambda p: int(p.stem.split("_")[-1]) if p.stem.split("_")[-1].isdigit() else 0)
    if not files:
        print(f"No snapshot files found in {args.frames_dir} matching {args.pattern}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(files)} snapshot files in {args.frames_dir}.")
    traj = build_trajectory(files, experiment_name=args.experiment)

    if args.embtraj_out:
        args.embtraj_out.parent.mkdir(parents=True, exist_ok=True)
        save_embtraj(traj, args.embtraj_out)

    if args.npz_out:
        args.npz_out.parent.mkdir(parents=True, exist_ok=True)
        save_npz(traj, args.npz_out)

    print("Trajectory packaging completed successfully.")


if __name__ == "__main__":
    main()
