#!/usr/bin/env python3
"""Exercise CGAL edge queries and failure states through the C interface."""
import ctypes as c
import sys
from cgal_dynamic_parity import load_library, edges

lib = load_library(sys.argv[1])

def coordinates(points):
    return (c.c_double * (len(points) * 3))(*(x for p in points for x in p))

for points, expected in (
    ([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)], 6),
    ([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)], 5),
    ([(0, 0, 0), (1, 0, 0), (2, 0, 0), (3, 0, 0)], 3),
):
    xyz = coordinates(points)
    state = lib.create(xyz, 4)
    assert state
    try:
        assert lib.validate(state)
        before = edges(lib, state)
        assert len(before) == expected
        assert lib.move(state, xyz, 4) == 1
        assert edges(lib, state) == before
        short = (c.c_int32 * 2)(-123, -123)
        assert lib.edges(state, short, 1) == expected
        assert list(short) == [-123, -123]
        assert lib.move(state, xyz, 3) == 0
        assert lib.validate(state)
        invalid = coordinates([(float('nan'), 0, 0)] + points[1:])
        assert lib.move(state, invalid, 4) == 0
        assert edges(lib, state) == before
        collision = coordinates([points[1]] + points[1:])
        assert lib.move(state, collision, 4) == 0
        assert lib.validate(state) == 0
        assert lib.edges(state, None, 0) == -1
        assert lib.move(state, xyz, 4) == 0
    finally:
        lib.destroy(state)
assert not lib.create(coordinates([(0, 0, 0)] * 4), 4)
assert not lib.create(coordinates([(float('inf'), 0, 0)] * 4), 4)
print('PASS: 3D, planar, collinear, unchanged, capacity, count, nonfinite, collision, invalidation')

# The CLI must reject incomplete runs even if all earlier frames matched.
import itertools
import json
from pathlib import Path
import subprocess
import tempfile

with tempfile.TemporaryDirectory() as directory:
    prefix = Path(directory) / "trace"
    frame = dict(points=[(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)],
                 faces=list(itertools.combinations(range(1, 5), 3)),
                 built=True, status=0, triangulationEnabled=1)
    command = [sys.executable, str(Path(__file__).with_name("cgal_dynamic_parity.py")),
               "--library", sys.argv[1], "--trace-prefix", str(prefix)]
    def run(steps):
        return subprocess.run(command + ["--steps", str(steps)], capture_output=True).returncode
    Path(str(prefix) + "_0.json").write_text(json.dumps(frame))
    assert run(0) == 0
    assert run(1) != 0  # Missing requested frame.
    frame["points"][0] = frame["points"][1]
    Path(str(prefix) + "_1.json").write_text(json.dumps(frame))
    assert run(1) != 0  # Failed build after a matching frame.
    frame["points"][0] = (0, 0, 0)
    frame["built"] = False
    Path(str(prefix) + "_0.json").write_text(json.dumps(frame))
    assert run(0) != 0  # Failed Flow build, even with status zero.
    frame["built"] = True
    frame["faces"] = []
    Path(str(prefix) + "_0.json").write_text(json.dumps(frame))
    assert run(0) != 0  # Mismatching graph.
print("PASS: CLI success, missing frame, failed build, failed Flow build, edge mismatch")
