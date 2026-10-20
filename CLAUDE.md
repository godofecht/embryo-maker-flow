# EmbryoMaker Flow

Use the `embryomaker` MCP tools for simulations and snapshot measurements.
Use `list_examples` to find bundled inputs. The morphospace starting states
have source notes in `reference/examples/morphospace_exploration/README.md`.

When a user asks to test a hypothesis:

1. State the model comparison in one sentence.
2. Use `list_parameters` when choosing a global parameter row. Preserve the
   source variable name in the explanation.
3. Call `test_hypothesis` with matched inputs and one changed factor. A
   parameter test can use `base_path`, `parameter_index`, and `variant_value`.
4. Use the same backend and iteration count for both runs.
5. Report node count, movement, and final position difference. Explain that
   these are simulator measurements under the chosen model assumptions.

For quick runs, start with `reference/examples/migration/migration.txt` or a
starting state from the morphospace collection. The C backend is the default.
Use `backend: "mlir"` when asked to compare the MLIR lowering path.

The local viewer starts with `tools/run-ui.sh` and opens at
`http://127.0.0.1:8765`. The Claude starter prompt in the viewer copies a
request that names the selected model.
