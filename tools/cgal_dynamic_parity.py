#!/usr/bin/env python3
"""Compare raw Flow faces and dynamic/fresh CGAL at identical coordinates.

Generate inputs with tools/delaunay_trace.flow. Every failed build, invalid
update, missing frame or edge mismatch makes this check fail.
"""
import argparse
import ctypes as c
import itertools
import json
import math
import time


def load_library(path):
    lib = c.CDLL(path)
    for name, args, result in (
        ("create", [c.POINTER(c.c_double), c.c_int32], c.c_void_p),
        ("move", [c.c_void_p, c.POINTER(c.c_double), c.c_int32], c.c_int),
        ("validate", [c.c_void_p], c.c_int),
        ("edges", [c.c_void_p, c.POINTER(c.c_int32), c.c_int32], c.c_int32),
        ("destroy", [c.c_void_p], None),
    ):
        fn = getattr(lib, "embryo_cgal_delaunay_" + name)
        fn.argtypes, fn.restype = args, result
        setattr(lib, name, fn)
    return lib


def edges(lib, state):
    count = lib.edges(state, None, 0)
    if count < 0:
        raise RuntimeError("edge size query failed")
    output = (c.c_int32 * (2 * count))()
    if lib.edges(state, output, count) != count:
        raise RuntimeError("edge extraction failed")
    return set(zip(output[::2], output[1::2]))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True)
    parser.add_argument("--trace-prefix", required=True)
    parser.add_argument("--steps", type=int, default=40)
    args = parser.parse_args()
    if args.steps < 0:
        parser.error("steps must be nonnegative")
    lib = load_library(args.library)
    state = None
    failures = 0
    move_seconds = rebuild_seconds = 0.0
    try:
        for step in range(args.steps + 1):
            with open(f"{args.trace_prefix}_{step}.json") as source:
                frame = json.load(source)
            points = frame["points"]
            if len(points) < 4 or any(len(p) != 3 or not all(map(math.isfinite, p)) for p in points):
                raise ValueError("invalid trace coordinates")
            coords = (c.c_double * (3 * len(points)))(*itertools.chain.from_iterable(points))
            before = time.perf_counter()
            fresh = lib.create(coords, len(points))
            rebuild_seconds += time.perf_counter() - before
            if not fresh:
                raise RuntimeError("fresh CGAL build failed")
            try:
                if not state:
                    state = lib.create(coords, len(points))
                else:
                    before = time.perf_counter()
                    ok = lib.move(state, coords, len(points))
                    move_seconds += time.perf_counter() - before
                    if not ok:
                        raise RuntimeError(f"CGAL update failed at frame {step}")
                if not state or not lib.validate(state) or not lib.validate(fresh):
                    raise RuntimeError(f"CGAL validity failed at frame {step}")
                dynamic_edges, fresh_edges = edges(lib, state), edges(lib, fresh)
                flow_edges = set()
                for face in frame["faces"]:
                    if len(face) != 3 or len(set(face)) != 3 or any(v < 1 or v > len(points) for v in face):
                        raise ValueError("invalid Flow face")
                    flow_edges.update(tuple(sorted(pair)) for pair in itertools.combinations(face, 2))
                flow_ok = frame["built"] and frame["status"] == 0 and bool(flow_edges) and flow_edges == fresh_edges
                dynamic_ok = dynamic_edges == fresh_edges
                failures += int(not flow_ok or not dynamic_ok)
                print(json.dumps(dict(frame=step, triangulation_enabled=frame["triangulationEnabled"],
                    flow_status=frame["status"], flow_edges=len(flow_edges), cgal_edges=len(fresh_edges),
                    flow_xor=len(flow_edges ^ fresh_edges), dynamic_xor=len(dynamic_edges ^ fresh_edges),
                    flow_matches=flow_ok, dynamic_matches=dynamic_ok)))
            finally:
                lib.destroy(fresh)
    finally:
        if state:
            lib.destroy(state)
    print(json.dumps(dict(frames=args.steps + 1, failed_frames=failures,
                         move_seconds=move_seconds, rebuild_seconds=rebuild_seconds)))
    return int(failures != 0)


if __name__ == "__main__":
    raise SystemExit(main())
