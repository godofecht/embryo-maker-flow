#!/usr/bin/env python3
"""Small stdio MCP server for EmbryoMaker Flow simulations."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RUN_DIR = ROOT / "runs" / "mcp"
ENTRY = ROOT / "src" / "embryomaker.flow"
MAX_ITERATIONS = 100_000
RUN_TIMEOUT_SECONDS = 600
PARAMETER_NAMES = [
    "getot", "temp", "nparti", "desmax", "mmae", "dmax", "rv", "min_comp",
    "ntipusadh", "nd", "resmax", "ndmax", "rtime", "ttalone", "reqmin",
    "ecmmax", "deltamax", "ncels", "ng", "reserved_20", "prop_noise", "mnn",
    "ramax", "prec", "deltamin", "dif_req", "screen_radius", "df_reqmax",
    "angletor", "ldi", "maxad", "maxbox", "maxcycl", "newfase", "maxelong",
]


class ToolError(Exception):
    pass


def project_file(value: Any) -> Path:
    if not isinstance(value, str) or not value:
        raise ToolError("Provide a project-relative file path.")
    path = (ROOT / value).resolve()
    try:
        path.relative_to(ROOT)
    except ValueError as exc:
        raise ToolError("File paths must stay inside the EmbryoMaker project.") from exc
    if not path.is_file():
        raise ToolError(f"File does not exist: {value}")
    return path


def node_positions(path: Path, marker: str) -> list[tuple[float, float, float]]:
    try:
        lines = path.read_text(errors="replace").splitlines()
    except OSError as exc:
        raise ToolError(f"Could not read snapshot: {exc}") from exc
    try:
        cursor = lines.index(marker) + 1
    except ValueError as exc:
        raise ToolError(f"Snapshot is missing section: {marker}") from exc
    while cursor < len(lines) and not lines[cursor].strip():
        cursor += 1
    if cursor >= len(lines) or lines[cursor].strip() != "node parameters":
        raise ToolError(f"Snapshot section is malformed: {marker}")
    cursor += 1
    rows: list[tuple[float, float, float]] = []
    while cursor < len(lines) and lines[cursor].strip():
        fields = lines[cursor].split()
        if len(fields) < 3:
            raise ToolError(f"Malformed node row in {path}")
        try:
            rows.append((float(fields[0]), float(fields[1]), float(fields[2])))
        except ValueError as exc:
            raise ToolError(f"Malformed node coordinates in {path}") from exc
        cursor += 1
    if not rows:
        raise ToolError(f"No node rows found in {path}")
    return rows


def tool_definitions() -> list[dict[str, Any]]:
    return [
        {
            "name": "list_examples",
            "description": "List bundled EmbryoMaker starting models, including nine Figure 7 and Figure 8 morphospace cases.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
        {
            "name": "run_simulation",
            "description": "Run an EmbryoMaker input for a number of iterations and save its snapshot under runs/mcp/.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "input_path": {"type": "string", "description": "Input file path relative to the project root."},
                    "iterations": {"type": "integer", "minimum": 0, "maximum": MAX_ITERATIONS, "default": 1},
                    "backend": {"type": "string", "enum": ["c", "mlir"], "default": "c"},
                },
                "required": ["input_path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "analyze_snapshot",
            "description": "Measure node displacement from the starting positions saved in a simulation snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {"snapshot_path": {"type": "string", "description": "Snapshot path relative to the project root."}},
                "required": ["snapshot_path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "compare_snapshots",
            "description": "Compare final node positions in two snapshots. Use test_hypothesis for a complete paired run.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "control_path": {"type": "string"},
                    "variant_path": {"type": "string"},
                },
                "anyOf": [
                    {"required": ["control_path", "variant_path"]},
                    {"required": ["base_path", "parameter_index", "variant_value"]},
                ],
                "additionalProperties": False,
            },
        },
        {
            "name": "test_hypothesis",
            "description": "Run a control and a variant for the same number of iterations, measure both, and compare final node positions. Supply control_path plus variant_path, or base_path plus parameter_index and variant_value to create a one-parameter variant. The result describes model behavior and provides no biological evidence.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "hypothesis": {"type": "string", "description": "Plain-language claim being tested."},
                    "control_path": {"type": "string", "description": "Project-relative control input file."},
                    "variant_path": {"type": "string", "description": "Project-relative input file with one changed factor."},
                    "base_path": {"type": "string", "description": "Project-relative input to copy when testing one global parameter."},
                    "parameter_index": {"type": "integer", "minimum": 1, "maximum": 35, "description": "Parameter row to change in the copied input. Use list_parameters first."},
                    "variant_value": {"type": "number", "description": "New numeric value for the selected parameter row."},
                    "iterations": {"type": "integer", "minimum": 0, "maximum": MAX_ITERATIONS, "default": 1},
                    "backend": {"type": "string", "enum": ["c", "mlir"], "default": "c"},
                },
                "required": ["control_path", "variant_path"],
                "additionalProperties": False,
            },
        },
        {
            "name": "list_parameters",
            "description": "List the 35 global parameter row numbers and their source variable names. Use these to describe or create a one-parameter variant.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    ]


def run_simulation(args: dict[str, Any]) -> dict[str, Any]:
    input_path = project_file(args.get("input_path"))
    iterations = args.get("iterations", 1)
    backend = args.get("backend", "c")
    if isinstance(iterations, bool) or not isinstance(iterations, int) or not 0 <= iterations <= MAX_ITERATIONS:
        raise ToolError(f"iterations must be an integer from 0 through {MAX_ITERATIONS}.")
    if backend not in ("c", "mlir"):
        raise ToolError("backend must be c or mlir.")
    flow = shutil.which("flow")
    if flow is None:
        raise ToolError("Could not find the Flow CLI on PATH.")

    build_command = [flow, "build"] if backend == "c" else [flow, "compile", "--backend=mlir", str(ENTRY.relative_to(ROOT))]
    environment = os.environ.copy()
    existing_flags = environment.get("FLOW_CFLAGS", "").strip()
    if "-ffp-contract=off" not in existing_flags.split():
        environment["FLOW_CFLAGS"] = (existing_flags + " -ffp-contract=off").strip()
    build = subprocess.run(
        build_command,
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=RUN_TIMEOUT_SECONDS,
        check=False,
    )
    if build.returncode:
        detail = (build.stderr or build.stdout).strip()[-6000:]
        raise ToolError(f"Build failed with exit code {build.returncode}:\n{detail}")

    binary = Path.home() / "flow" / "build" / "embryomaker"
    if not binary.is_file():
        raise ToolError(f"Build completed without producing the expected executable: {binary}")
    RUN_DIR.mkdir(parents=True, exist_ok=True)
    snapshot = RUN_DIR / f"{input_path.stem}_{backend}_{iterations}_{time.time_ns()}.dat"
    result = subprocess.run(
        [str(binary), str(input_path), str(iterations), str(snapshot)],
        cwd=ROOT,
        env=environment,
        text=True,
        capture_output=True,
        timeout=RUN_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-6000:]
        raise ToolError(f"Simulation failed with exit code {result.returncode}:\n{detail}")
    return {
        "input_path": str(input_path.relative_to(ROOT)),
        "iterations": iterations,
        "backend": backend,
        "snapshot_path": str(snapshot.relative_to(ROOT)),
        "snapshot_bytes": snapshot.stat().st_size,
    }


def analyze_snapshot(args: dict[str, Any]) -> dict[str, Any]:
    snapshot = project_file(args.get("snapshot_path"))
    current = node_positions(snapshot, "node properties")
    initial = node_positions(snapshot, "node properties at time 0 (nodeo)")
    if len(current) != len(initial):
        raise ToolError("Snapshot current and starting node counts differ.")
    distances = [math.dist(start, end) for start, end in zip(initial, current)]
    return {
        "snapshot_path": str(snapshot.relative_to(ROOT)),
        "nodes": len(distances),
        "moved_nodes": sum(distance > 0.0 for distance in distances),
        "mean_displacement": sum(distances) / len(distances),
        "max_displacement": max(distances),
    }


def compare_snapshots(args: dict[str, Any]) -> dict[str, Any]:
    control_path = project_file(args.get("control_path"))
    variant_path = project_file(args.get("variant_path"))
    control = node_positions(control_path, "node properties")
    variant = node_positions(variant_path, "node properties")
    if len(control) != len(variant):
        raise ToolError(f"Node counts differ: {len(control)} and {len(variant)}.")
    differences = [math.dist(a, b) for a, b in zip(control, variant)]
    return {
        "control_path": str(control_path.relative_to(ROOT)),
        "variant_path": str(variant_path.relative_to(ROOT)),
        "nodes": len(differences),
        "changed_nodes": sum(distance > 0.0 for distance in differences),
        "mean_position_difference": sum(differences) / len(differences),
        "max_position_difference": max(differences),
    }


def test_hypothesis(args: dict[str, Any]) -> dict[str, Any]:
    control_path = project_file(args.get("control_path") or args.get("base_path"))
    changed_parameter = None
    if args.get("variant_path"):
        variant_path = project_file(args.get("variant_path"))
    else:
        base_path = project_file(args.get("base_path"))
        index = args.get("parameter_index")
        value = args.get("variant_value")
        if isinstance(index, bool) or not isinstance(index, int) or not 1 <= index <= len(PARAMETER_NAMES):
            raise ToolError("For a generated variant, parameter_index must be from 1 through 35.")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ToolError("variant_value must be a finite number.")
        variant_path, original_value = create_parameter_variant(base_path, index, float(value))
        changed_parameter = {
            "index": index,
            "source_variable": PARAMETER_NAMES[index - 1],
            "original_value": original_value,
            "value": float(value),
        }
    iterations = args.get("iterations", 1)
    backend = args.get("backend", "c")
    if isinstance(iterations, bool) or not isinstance(iterations, int) or not 0 <= iterations <= MAX_ITERATIONS:
        raise ToolError(f"iterations must be an integer from 0 through {MAX_ITERATIONS}.")
    if backend not in ("c", "mlir"):
        raise ToolError("backend must be c or mlir.")
    control_run = run_simulation({"input_path": str(control_path.relative_to(ROOT)), "iterations": iterations, "backend": backend})
    variant_run = run_simulation({"input_path": str(variant_path.relative_to(ROOT)), "iterations": iterations, "backend": backend})
    control_analysis = analyze_snapshot({"snapshot_path": control_run["snapshot_path"]})
    variant_analysis = analyze_snapshot({"snapshot_path": variant_run["snapshot_path"]})
    comparison = compare_snapshots({"control_path": control_run["snapshot_path"], "variant_path": variant_run["snapshot_path"]})
    return {
        "hypothesis": args.get("hypothesis", ""),
        "iterations": iterations,
        "backend": backend,
        "changed_parameter": changed_parameter,
        "control": {**control_run, **control_analysis},
        "variant": {**variant_run, **variant_analysis},
        "difference": comparison,
        "interpretation": "This reports a difference between two simulator runs. Biological interpretation depends on the model assumptions and the chosen parameter change.",
    }


def create_parameter_variant(base_path: Path, index: int, value: float) -> tuple[Path, float]:
    try:
        lines = base_path.read_text().splitlines(keepends=True)
    except OSError as exc:
        raise ToolError(f"Could not read base input: {exc}") from exc
    try:
        section = next(i for i, line in enumerate(lines) if line.strip() == "parameters")
    except StopIteration as exc:
        raise ToolError("Base input has no parameters section.") from exc
    target_line = None
    for line_number in range(section + 1, len(lines)):
        fields = lines[line_number].split()
        if not fields:
            continue
        try:
            row = int(fields[0])
        except ValueError:
            if target_line is not None:
                break
            continue
        if row == index:
            target_line = line_number
            break
    if target_line is None:
        raise ToolError(f"Could not find parameter row {index} in {base_path.name}.")
    line = lines[target_line]
    match = re.match(r"^(\s*\d+\s+)(\S+)(.*)$", line, flags=re.DOTALL)
    if not match:
        raise ToolError(f"Parameter row {index} is malformed.")
    try:
        original_value = float(match.group(2))
    except ValueError as exc:
        raise ToolError(f"Parameter row {index} does not contain a numeric value.") from exc
    lines[target_line] = match.group(1) + format(value, ".17g") + match.group(3)
    variant_dir = RUN_DIR / "variants"
    variant_dir.mkdir(parents=True, exist_ok=True)
    variant_path = variant_dir / f"{base_path.stem}_parameter_{index}_{time.time_ns()}.dat"
    variant_path.write_text("".join(lines))
    return variant_path, original_value


def call_tool(name: str, args: Any) -> Any:
    if not isinstance(args, dict):
        raise ToolError("Tool arguments must be a JSON object.")
    if name == "list_examples":
        base = ROOT / "reference" / "examples"
        return {
            "examples": [
                str(path.relative_to(ROOT))
                for path in sorted(base.rglob("*"))
                if path.is_file()
                and path.suffix.lower() in (".txt", ".dat")
                and path.name.lower() != "readme.txt"
                and "license" not in path.name.lower()
            ],
            "morphospace_source": "Hugo Cano-Fernandez et al., Morphospace_exploration_EMaker, Figure 7 and Figure 8 starting states.",
        }
    if name == "run_simulation":
        return run_simulation(args)
    if name == "analyze_snapshot":
        return analyze_snapshot(args)
    if name == "compare_snapshots":
        return compare_snapshots(args)
    if name == "test_hypothesis":
        return test_hypothesis(args)
    if name == "list_parameters":
        return {"parameters": [{"index": index, "source_variable": name} for index, name in enumerate(PARAMETER_NAMES, start=1)]}
    raise ToolError(f"Unknown tool: {name}")


def reply(request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> None:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(message: dict[str, Any]) -> None:
    method = message.get("method")
    request_id = message.get("id")
    params = message.get("params") or {}
    if method == "notifications/initialized" or method == "notifications/cancelled":
        return
    if method == "initialize":
        reply(request_id, {
            "protocolVersion": params.get("protocolVersion", "2025-03-26"),
            "capabilities": {"tools": {"listChanged": False}, "prompts": {"listChanged": False}},
            "serverInfo": {"name": "embryomaker-flow", "version": "0.1.0"},
        })
    elif method == "ping":
        reply(request_id, {})
    elif method == "tools/list":
        reply(request_id, {"tools": tool_definitions()})
    elif method == "prompts/list":
        reply(request_id, {"prompts": [{
            "name": "test_hypothesis",
            "description": "Set up a controlled EmbryoMaker comparison and report its limits.",
            "arguments": [
                {"name": "hypothesis", "description": "What do you expect to change?", "required": True},
                {"name": "control_path", "description": "Project-relative control input.", "required": True},
                {"name": "variant_path", "description": "Project-relative variant input with one changed factor.", "required": True},
                {"name": "iterations", "description": "Same iteration count for both runs.", "required": False},
            ],
        }]})
    elif method == "prompts/get":
        if params.get("name") != "test_hypothesis":
            reply(request_id, error={"code": -32602, "message": "Unknown prompt."})
            return
        arguments = params.get("arguments") or {}
        prompt = (
            "Test this hypothesis with EmbryoMaker: " + str(arguments.get("hypothesis", "")) + "\n"
            "Control input: " + str(arguments.get("control_path", "")) + "\n"
            "Variant input: " + str(arguments.get("variant_path", "")) + "\n"
            "Use the same iteration count for both. Check that these inputs share a starting state and differ in one factor. "
            "Call the test_hypothesis tool, then explain node displacement and position differences. State what the model output supports and what it cannot establish."
        )
        reply(request_id, {"description": "Run a paired EmbryoMaker hypothesis test.", "messages": [{"role": "user", "content": {"type": "text", "text": prompt}}]})
    elif method == "tools/call":
        try:
            value = call_tool(params.get("name", ""), params.get("arguments", {}))
            reply(request_id, {"content": [{"type": "text", "text": json.dumps(value, indent=2)}], "structuredContent": value})
        except ToolError as exc:
            reply(request_id, {"content": [{"type": "text", "text": str(exc)}], "isError": True})
        except (OSError, subprocess.SubprocessError) as exc:
            reply(request_id, {"content": [{"type": "text", "text": f"Operation failed: {exc}"}], "isError": True})
    else:
        if "id" in message:
            reply(request_id, error={"code": -32601, "message": f"Method not found: {method}"})


def main() -> None:
    for line in sys.stdin:
        request_id: Any = None
        try:
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("JSON-RPC message must be an object")
            handle(message)
        except Exception as exc:
            sys.stderr.write(f"embryomaker-mcp: {exc}\n")
            sys.stderr.flush()
            if request_id is not None:
                reply(request_id, error={"code": -32600, "message": "Invalid request"})
            else:
                reply(None, error={"code": -32700, "message": "Parse error"})


if __name__ == "__main__":
    main()
