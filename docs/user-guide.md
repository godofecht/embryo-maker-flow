# EmbryoMaker Flow user guide

EmbryoMaker Flow runs a cell simulation in a local server and displays it in your browser. The server listens on your own computer at `127.0.0.1`. The simulation does not run on the project website.

The desktop packages include the compiled simulator. You do not need to install Flow to run them.

## Download and start

Download the archive for your computer from the [latest release downloads](downloads/). The current packages are for Apple silicon Macs and x86-64 Linux.

The download page includes SHA256 checksums for both archives.

Extract the archive into a folder where you can write files. Keep the `reference` and `ui` folders beside the executable.

On Apple silicon Mac, open `Start EmbryoMaker.command`. A Terminal window starts the server and your browser opens to `http://127.0.0.1:8765`. Keep the Terminal window open while you use the Studio. Press Control-C in that window to stop the server.

On Linux, open a terminal in the extracted folder and run:

```sh
./start-linux.sh
```

The launcher opens the Studio in your default browser. Keep the terminal open. Press Control-C to stop the server. If the browser does not open, visit `http://127.0.0.1:8765` yourself.

To use another port, set `PORT` before starting the launcher. For example:

```sh
PORT=9000 ./start-linux.sh
```

Then open `http://127.0.0.1:9000`.

## macOS first launch

The downloadable Mac archive is built for Apple silicon and is not signed or notarized. macOS may prevent the command file from opening the first time. In Finder, Control-click `Start EmbryoMaker.command`, choose Open, then confirm. If macOS still blocks it, open Terminal in the extracted folder and run:

```sh
xattr -dr com.apple.quarantine .
./Start\ EmbryoMaker.command
```

## Choose and run a simulation

Choose a starting state from the `Starting model` menu. The bundle includes the original examples and nine saved Morphospace states. Loading a new example resets the workspace to that example.

The sea urchin morphology hypothesis run compares the epithelial deformation cap, ECM release threshold, and req diffusion rate from one starting state. Its predictions and measured results are in [the hypothesis examples README](../reference/examples/sea_urchin_gastrulation_hypotheses/README.md). Run `python3 tools/run_gastrulation_hypotheses.py` to repeat it.

The `Auxin stem growth` example tests how a tip auxin source and signal mobility affect a seven-cell stem. Set the color field to gene 1 to see the response. The matched runs and morphology figure are in [the example README](../reference/examples/auxin_stem_growth/README.md).

Select `Controls` above the model view to show the experiment and display panels. Use `Run` to advance the simulation continuously, `Pause` to stop it, `Step once` to advance exactly one solver iteration, and `Reset` to return to the selected starting state. The iteration slider selects an iteration. The speed menu changes how quickly batches run.

The original EmbryoMaker menu is available by right-clicking the model view or selecting its menu button. Hover a menu category to open its submenu. The iteration commands run the requested number of solver iterations. The custom command accepts values from 1 to 50,000.

The arrow keys work when a text field is not focused:

| Key | Action |
| --- | --- |
| Right | Run the current iteration batch |
| Up | Multiply the batch by ten and run it |
| Left | Rewind one iteration |
| Down | Switch the active camera or cursor movement mode |

Drag the model to rotate it. Choose Pan, Rotate, or Zoom from the display controls to change the drag action. The camera menu switches between oblique, top, and front views. The home icon resets the camera. Fullscreen expands the view.

## Inspect and edit

The display panel changes the field used for color, adjusts color and arrow ranges, changes node and cell visibility, and clips the view with a section plane. The model inspector shows counts and values for the current state. Right-click menu actions include node selection and editing, cell movement, gene plots, and display settings.

Use `Load input file` to open a local EmbryoMaker `.txt` or `.dat` input. The uploaded file is read for this session. The server stores a temporary copy under `/tmp` and removes it when the session closes.

## Save files

Use the menu's snapshot command to write the current model state under `output/<model>/`. Automatic images are saved under `images/<model>/` when enabled. Movie capture saves a GIF through FFmpeg. If FFmpeg is unavailable, the browser downloads the WebM recording instead.

The server writes into the extracted application folder. Move the bundle to a writable folder such as your home directory if the operating system prevents writes.

## Close the application

Close the browser tab, then press Control-C in the terminal window. Each server process runs one simulation session. Starting a new session or closing the server discards the in-memory state. Save snapshots you want to keep.

## Troubleshooting

- **The browser shows that it cannot connect.** Check that the terminal still shows the server running. Open the URL printed there. Check whether another program is using port 8765, then start with another `PORT` value.
- **The model or menus are missing.** Keep `ui` and `reference` beside the executable. Start the launcher from the extracted bundle.
- **The Linux executable will not start.** The supplied build targets x86-64 Linux on Ubuntu 24.04 or a compatible newer distribution. It does not run on ARM Linux.
- **The Mac command file is blocked.** Follow the macOS first launch steps above. The supplied Mac build requires Apple silicon. Intel Macs need a separate build.
- **GIF export fails.** Install FFmpeg and restart the server. WebM capture works in supported browsers without FFmpeg.

## Build from source

To build from source, install the [Flow 2.0.0 compiler](https://github.com/flooooooooooow/flow/blob/v2.0.0/README.md#installation) and a C compiler, clone the source repository, then run:

```sh
tools/run-ui.sh
```

Open `http://127.0.0.1:8765`. See the repository README for parity and browser checks. The project is licensed under GPL-3.0. The Morphospace examples include their own source and license notices in `reference/examples/morphospace_exploration/`.
