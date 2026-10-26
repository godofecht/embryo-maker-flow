#!/usr/bin/env python3
"""Run sea urchin simulation and render cross-section MP4 video."""

import os
from pathlib import Path
import subprocess
import time
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FFMpegWriter
from matplotlib.colors import to_rgba

ROOT = Path(__file__).resolve().parents[1]
BINARY = Path.home() / "flow" / "build" / "embryomaker"
INPUT = ROOT / "reference" / "examples" / "sea_urchin_gastrulation" / "sea_urchin.txt"
OUT_DIR = ROOT / "build" / "sea_urchin_video"
FRAMES_DIR = OUT_DIR / "frames"
VIDEO_PATH = OUT_DIR / "sea_urchin_gastrulation.mp4"

SNAPSHOTS = 50
INTERVAL = 6
TOTAL_ITERS = SNAPSHOTS * INTERVAL


def parse_snapshot(path: Path):
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    try:
        node_sec = lines.index("node properties")
    except ValueError:
        node_sec = lines.index("node parameters")

    cursor = node_sec + 1
    while cursor < len(lines) and not lines[cursor].strip():
        cursor += 1
    if cursor < len(lines) and lines[cursor].strip() == "node parameters":
        cursor += 1

    nodes = []
    while cursor < len(lines) and lines[cursor].strip():
        fields = lines[cursor].split()
        x, y, z = float(fields[0]), float(fields[1]), float(fields[2])
        tipus = int(fields[28]) if len(fields) > 28 else 1
        nodes.append((x, y, z, tipus))
        cursor += 1

    gene1 = [0.0] * len(nodes)
    try:
        g_sec = lines.index("G matrix: gene expression")
        cursor = g_sec + 1
        while cursor < len(lines) and lines[cursor].strip() != "node gene values":
            cursor += 1
        cursor += 1
        while cursor < len(lines) and lines[cursor].strip():
            fields = lines[cursor].split()
            node_idx = int(fields[0]) - 1
            if 0 <= node_idx < len(nodes) and len(fields) > 1:
                gene1[node_idx] = float(fields[1])
            cursor += 1
    except ValueError:
        pass

    coords = np.array([(n[0], n[1], n[2]) for n in nodes], dtype=np.float64)
    types = np.array([n[3] for n in nodes], dtype=np.int32)
    g1 = np.array(gene1, dtype=np.float64)
    return coords, types, g1


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)

    dat_files = sorted(FRAMES_DIR.glob("urchin_*.dat"), key=lambda p: int(p.stem.split("_")[1]))
    if len(dat_files) < SNAPSHOTS:
        for old_file in FRAMES_DIR.glob("urchin_*.dat"):
            old_file.unlink()
        print(f"Running simulation: {SNAPSHOTS} snapshots at {INTERVAL} iters/snapshot ({TOTAL_ITERS} total)...")
        prefix = FRAMES_DIR / "urchin"
        cmd = [str(BINARY), str(INPUT), "1", str(INTERVAL), str(SNAPSHOTS), str(prefix)]
        t0 = time.time()
        proc = subprocess.run(cmd, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        t1 = time.time()
        if proc.returncode != 0:
            print("STDERR:", proc.stderr)
            raise SystemExit(f"Simulation failed with exit code {proc.returncode}")
        dat_files = sorted(FRAMES_DIR.glob("urchin_*.dat"), key=lambda p: int(p.stem.split("_")[1]))
        print(f"Simulation completed in {t1 - t0:.2f}s. Generated {len(dat_files)} snapshot files.")
    else:
        print(f"Using {len(dat_files)} existing snapshot files from {FRAMES_DIR}.")

    print(f"Rendering {len(dat_files)} frames to {VIDEO_PATH}...")
    writer = FFMpegWriter(fps=12, metadata=dict(title="Sea Urchin Gastrulation in EmbryoMaker Flow"), bitrate=2400)
    fig = plt.figure(figsize=(8, 8), facecolor="#0e1117")
    ax = fig.add_subplot(111, projection="3d", facecolor="#0e1117")

    t_render_start = time.time()
    with writer.saving(fig, str(VIDEO_PATH), dpi=140):
        for idx, dat_path in enumerate(dat_files):
            ax.clear()
            ax.set_facecolor("#0e1117")
            ax.grid(False)
            ax.axis("off")

            coords, types, g1 = parse_snapshot(dat_path)
            iteration = int(dat_path.stem.split("_")[1])

            # Cross-section cut along Y axis
            mask = coords[:, 1] >= -0.15
            c_slice = coords[mask]
            t_slice = types[mask]
            g_slice = g1[mask]

            rgba_colors = []
            sizes = []

            for t, g in zip(t_slice, g_slice):
                if t == 4:
                    rgba_colors.append(to_rgba("#4a5568", 0.20))
                    sizes.append(10)
                elif t == 3:
                    rgba_colors.append(to_rgba("#d53f8c", 0.95))
                    sizes.append(26)
                elif g > 0.05:
                    rgba_colors.append(to_rgba("#ff5722", 0.95))
                    sizes.append(28)
                elif t == 1:
                    rgba_colors.append(to_rgba("#f6ad55", 0.90))
                    sizes.append(22)
                else:
                    rgba_colors.append(to_rgba("#319795", 0.90))
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
                f"Sea Urchin Gastrulation: Iteration {iteration:03d}\nVegetal Invagination and Archenteron Formation",
                color="#e2e8f0", fontsize=12, pad=-15
            )

            writer.grab_frame()
            if (idx + 1) % 10 == 0 or idx == len(dat_files) - 1:
                print(f"Rendered frame {idx + 1}/{len(dat_files)}")

    plt.close(fig)
    t_render_end = time.time()
    size_mb = VIDEO_PATH.stat().st_size / (1024 * 1024)
    print(f"Finished rendering in {t_render_end - t_render_start:.2f}s.")
    print(f"Video file: {VIDEO_PATH} ({size_mb:.2f} MB)")


if __name__ == "__main__":
    main()
