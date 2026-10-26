# EmbryoMaker Flow

EmbryoMaker Flow is a local cell simulation workbench with a browser-based Studio.

## Download and run

Get the macOS or Linux package from the [project page](https://godofecht.github.io/embryo-maker-flow/). Extract it, keep its `reference` and `ui` folders beside the executable, then start it:

- Apple silicon Mac: open `Start EmbryoMaker.command`.
- Linux x86-64: run `./start-linux.sh` in a terminal.

The Studio opens at `http://127.0.0.1:8765`. Keep the terminal window open while using it. Press Control-C to stop the server. See the [user guide](docs/user-guide.md) for setup, controls, saving, and troubleshooting.

The project page contains the downloadable packages and a Studio preview. The simulator runs on your computer.

## Build from source

Install the Flow compiler and a C compiler, then run `tools/run-ui.sh` from the project root. The browser smoke check is `node tools/ui_smoke.cjs`. The solver parity suite is `tools/run_flow_checks.sh`.

`tools/build-pgo.sh` trains a clang profile that `tools/run-ui.sh` reuses. `tools/build-mlir.sh` and `tools/build-gpu.sh` are the MLIR and Metal lowering pipelines, and `tools/backend_parity.sh` compares any build with the C reference bit for bit. PORTING.md records the measurements.

The solver runs its neighbor scan, gene step and pair forces on a worker pool by default (`EMBRYO_THREADS=1` keeps it serial). `EMBRYO_GPU=exact64` moves the pair forces to the GPU in software binary64, bitwise equal to the CPU; `EMBRYO_GPU=preview` uses float32 there and diverges from the exact run. The Studio's Compute select switches these at run time.

## Examples and license

The viewer includes the original EmbryoMaker examples and nine saved states from the Morphospace exploration collection. Their source and license details are in [the examples directory](reference/examples/morphospace_exploration/README.md).

EmbryoMaker Flow is licensed under GPL-3.0. See [LICENSE](LICENSE).
