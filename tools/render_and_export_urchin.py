#!/usr/bin/env python3
"""Render sea urchin gastrulation video (2,000 iterations) and package project."""

from pathlib import Path
import time
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FFMpegWriter
from matplotlib.colors import to_rgba
import json
import gzip

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "build" / "sea_urchin_video"
OUT_DIR.mkdir(parents=True, exist_ok=True)
VIDEO_PATH = OUT_DIR / "sea_urchin_gastrulation.mp4"

# Source files from /tmp
files = sorted(Path("/tmp").glob("urchin_bench_*.dat"), key=lambda p: int(p.stem.split("_")[2]))
print(f"Loaded {len(files)} snapshot files: {files[0].name} to {files[-1].name}")

def parse_snapshot(path: Path):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    node_sec = -1
    for idx, l in enumerate(lines):
        if l.strip() in ("node properties", "node parameters"):
            node_sec = idx
            break
    if node_sec == -1:
        raise ValueError(f"No node properties in {path}")

    cursor = node_sec + 1
    while cursor < len(lines) and not lines[cursor].strip():
        cursor += 1
    if cursor < len(lines) and lines[cursor].strip() == "node parameters":
        cursor += 1

    nodes = []
    while cursor < len(lines) and lines[cursor].strip():
        fields = lines[cursor].split()
        if fields[0].lower() == 'x':
            cursor += 1
            continue
        try:
            x, y, z = float(fields[0]), float(fields[1]), float(fields[2])
        except ValueError:
            cursor += 1
            continue
        tipus = int(fields[28]) if len(fields) > 28 else 1
        nodes.append((x, y, z, tipus))
        cursor += 1

    gene1 = [0.0] * len(nodes)
    g_sec = -1
    for idx, l in enumerate(lines):
        if l.strip() == "G matrix: gene expression":
            g_sec = idx
            break
    if g_sec != -1:
        cursor = g_sec + 1
        while cursor < len(lines) and lines[cursor].strip() != "node gene values":
            cursor += 1
        cursor += 1
        while cursor < len(lines) and lines[cursor].strip():
            fields = lines[cursor].split()
            try:
                node_idx = int(fields[0]) - 1
                if 0 <= node_idx < len(nodes) and len(fields) > 1:
                    gene1[node_idx] = float(fields[1])
            except ValueError:
                pass
            cursor += 1

    coords = np.array([(n[0], n[1], n[2]) for n in nodes], dtype=np.float64)
    types = np.array([n[3] for n in nodes], dtype=np.int32)
    g1 = np.array(gene1, dtype=np.float64)
    return coords, types, g1

print(f"Starting video rendering to {VIDEO_PATH}...")
writer = FFMpegWriter(fps=15, metadata=dict(title="Sea Urchin Gastrulation - 2,000 Iterations"), bitrate=3000)
fig = plt.figure(figsize=(9, 9), facecolor="#0b0f14")
ax = fig.add_subplot(111, projection="3d", facecolor="#0b0f14")

t_render_start = time.time()
with writer.saving(fig, str(VIDEO_PATH), dpi=140):
    for idx, dat_path in enumerate(files):
        ax.clear()
        ax.set_facecolor("#0b0f14")
        ax.grid(False)
        ax.axis("off")

        coords, types, g1 = parse_snapshot(dat_path)
        iteration = int(dat_path.stem.split("_")[2])

        # Cross-section cut along Y axis to see interior invagination
        mask = coords[:, 1] >= -0.15
        c_slice = coords[mask]
        t_slice = types[mask]
        g_slice = g1[mask]

        rgba_colors = []
        sizes = []

        for t, g in zip(t_slice, g_slice):
            if t == 4:
                rgba_colors.append(to_rgba("#4a5568", 0.18))
                sizes.append(10)
            elif t == 3:
                rgba_colors.append(to_rgba("#ec4899", 0.95))
                sizes.append(26)
            elif g > 0.05:
                rgba_colors.append(to_rgba("#f97316", 0.95))
                sizes.append(28)
            elif t == 1:
                rgba_colors.append(to_rgba("#fbbf24", 0.90))
                sizes.append(22)
            else:
                rgba_colors.append(to_rgba("#14b8a6", 0.90))
                sizes.append(22)

        ax.scatter(
            c_slice[:, 0], c_slice[:, 1], c_slice[:, 2],
            c=rgba_colors, s=sizes, depthshade=True
        )

        ax.set_xlim(-6.5, 6.5)
        ax.set_ylim(-6.5, 6.5)
        ax.set_zlim(-6.5, 6.5)
        ax.view_init(elev=18, azim=135)

        ax.set_title(
            f"Sea Urchin Gastrulation: Iteration {iteration:,}\nVegetal Invagination and Archenteron Formation",
            color="#f1f5f9", fontsize=13, pad=-15
        )

        writer.grab_frame()
        if (idx + 1) % 10 == 0 or idx == len(files) - 1:
            elapsed = time.time() - t_render_start
            print(f"Rendered {idx + 1}/{len(files)} frames ({elapsed:.1f}s)")

plt.close(fig)
t_render_end = time.time()
size_mb = VIDEO_PATH.stat().st_size / (1024 * 1024)
print(f"Video exported successfully: {VIDEO_PATH} ({size_mb:.2f} MB, {t_render_end - t_render_start:.1f}s)")
