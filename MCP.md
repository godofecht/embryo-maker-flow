# EmbryoMaker with Claude

EmbryoMaker Studio gives you a local model viewer. The EmbryoMaker MCP server
lets Claude run the Flow simulator, measure snapshots, and compare paired
experiments.

## Start

From this project directory, start Claude Code:

```sh
claude
```

The project MCP configuration is in `.mcp.json`. Approve the `embryomaker`
server when Claude Code asks to connect. Its command uses Python 3 and this
repository's `tools/embryomaker_mcp.py`.

## Try it

Ask Claude:

> List the EmbryoMaker examples. Run the migration example for 10 iterations
> with MLIR, then measure the node displacements.

For a controlled comparison, provide two inputs that share the same starting
state and differ in one factor:

> Test whether increasing cell movement changes tissue displacement. Use
> `control.txt` and `variant.txt` for 100 iterations with the C backend.
> Explain the measured difference and the limits of this model result.

For a quick one-parameter check, ask Claude:

> On Morphospace Figure 7A, compare the starting value of `prop_noise` with
> `0.2` for one iteration. Report the baseline value and node position change.

The MCP run measured a baseline of `0.1`. At one iteration, 113 of 1,144
final node positions differed. Their mean position difference was
`4.94e-8`. This small result checks the run and comparison path. It does not
support a biological conclusion.

Claude can call `test_hypothesis` to run both inputs, measure each snapshot,
and compare final node positions in one step. For a quick parameter test,
Claude can call `list_parameters`, then call `test_hypothesis` with a base
input, parameter row, and new value. The tool writes a variant under
`runs/mcp/variants/` and keeps the original input intact. The prompt
`test_hypothesis` guides Claude through a paired comparison. Use
`list_examples` to see the bundled inputs, including the Figure 7 and Figure 8
starting states.

The comparison reports simulation output. It does not establish biological
validity. Treat stochastic runs as paired only when their initial state and
random seed match.

## Tools

- `list_examples` lists local inputs and the imported morphospace cases.
- `run_simulation` runs one input with the C or MLIR backend.
- `analyze_snapshot` measures node movement from its saved initial state.
- `compare_snapshots` measures differences between two final node positions.
- `test_hypothesis` runs and compares a control and variant pair.
- `list_parameters` lists the global parameter row numbers and source names.

Run artifacts are saved under `runs/mcp/`. Paths passed to tools must be
inside this repository. Runs accept 0 through 100,000 iterations and have a
10 minute timeout.

## Morphospace examples

Nine starting states from Hugo Cano-Fernandez and collaborators' repository
are bundled in `reference/examples/morphospace_exploration/`. They are the six
Figure 7 states and the three Figure 8 states named Figure 4D, Figure 4E, and
Figure 4F in the source repository. The source URL, paper citation, and
license provenance are recorded beside the files.

Start the Studio viewer separately with `tools/run-ui.sh`, then open
`http://127.0.0.1:8765`. Choose a case in the Starting model picker. The page
also has a Claude starter prompt that uses the selected case.
