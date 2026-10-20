# EmbryoMaker Flow

An EmbryoMaker implementation in Flow, with a browser-based simulation viewer.

The project page has a screenshot and setup notes: [EmbryoMaker Flow](https://godofecht.github.io/embryo-maker-flow/).

## Run the simulator

Install the Flow compiler, then start the local server from this directory:

```sh
tools/run-ui.sh
```

Open `http://127.0.0.1:8765`. Choose a starting model from the menu. The Studio controls include run, pause, single-step, reset, and an iteration slider. Each step advances the solver iteration counter by one.

The GitHub Pages site is a project overview. The simulation runs through the local Flow server.

## Examples

The viewer includes the original EmbryoMaker examples and nine saved states from the Morphospace exploration collection. Their source and license details are in [the examples directory](reference/examples/morphospace_exploration/README.md).

## License

GPL-3.0. See [LICENSE](LICENSE) and the bundled reference license.
