# EmbryoMaker Studio

EmbryoMaker Studio is a local browser interface for the Flow simulator. The HTTP server and simulation run in Flow. The page opens on an 800 by 800 black model view. Right-click the view to open the EmbryoMaker menu. The model picker includes the original examples, nine Figure 7 and Figure 4 states from the Morphospace exploration collection, and a precomputed Arabidopsis thaliana primary-root gravitropism comparison. It shows Col-0 and a PIN2 transport-deficient proxy after a 90-degree reorientation. See [MCP.md](../MCP.md) for model controls and paired hypothesis tests.

Status messages fade after 1.8 seconds. Right-click the view to open the EmbryoMaker menu. Hover a category to open its submenu, then click an item. The menu loads `.txt` and `.dat` examples, runs iteration batches, selects and edits nodes, moves nodes and cells, plots gene expression over time, and saves `.dat` snapshots. The `Controls` button opens the Studio panels with the model picker, playback buttons, iteration slider, display settings, and model inspector. Gene history starts with the model and can be paused from the menu. Plots support up to ten nodes and ten genes. Periodic snapshots go to `output/<model>/`. Automatic PNG frames go to `images/<model>/`. Movie capture records the rendered model view and converts it to an animated GIF with FFmpeg. If FFmpeg is unavailable, the browser downloads the WebM recording. Color, arrow, and transparent sphere ranges have independent controls. Arrow and sphere scales can be set from the same menus.

## Start

From the project root, start the Flow server:

```sh
tools/run-ui.sh
```

The launcher compiles `ui/server.flow` and runs the binary at `~/flow/build/server`. Open `http://127.0.0.1:8765`. The server binds to `127.0.0.1`. Set `PORT` to use another port.

The server holds one active simulation session at a time. Run, Step once, the OG iteration menu, and the arrow keys all count solver iterations. A one-iteration command advances `getot` by one. Saved Morphospace snapshots keep their starting iteration, so Figure 4D, 4E, and 4F begin at iteration 582. Reset or choosing another input loads a fresh model. Closing the browser tab ends the session.

## UI smoke check

With the server running and Playwright available to Node, run:

```sh
node tools/ui_smoke.cjs
```

The check sends raw HTTP requests to verify case-insensitive `Content-Length` parsing and rejection of duplicate lengths and transfer encoding. It loads every bundled example and a custom `.txt` input. It rejects a malformed upload, advances the restored simulation, then reloads the same valid file. It verifies the 800 by 800 view, OG menu order, hover navigation, and display defaults. It exercises camera and cursor controls, keyboard iteration commands, color and vector scaling, transparent sphere geometry, node selection, gene plotting, node and cell movement, snapshot rewind, and apical contraction Delaunay recovery. It fails on console errors, uncaught page errors, unhandled promise rejections, or failed requests. Set `EMBRYOMAKER_URL` to check another server and `CHROME_BIN` to select a Chrome executable.

The OG arrow keys work while focus is outside text and numeric inputs. Down switches between rotate and zoom, or between cursor x-y and z movement. Right runs the current keyboard iteration batch. Up multiplies that batch by ten and runs it. Left rewinds one iteration.

## Flow parity checks

Run the complete Flow parity suite from the project root:

```sh
tools/run_flow_checks.sh
```

The runner changes to `tests/` before starting each check because the example
paths are relative to that directory.

## Workspace and accessibility

Studio opens with experiment controls, a model viewport, and an inspector.
Use Focus view to hide the panels. Desktop panels scroll independently;
narrow screens place the model above the controls. The timeline separates
the current iteration from the editable target. Pause remains available
while a simulation request is in flight and takes effect between batches.

Cache and video dialogs support keyboard focus, Tab containment, Escape,
and focus restoration. Controls have visible focus indicators. Reduced-motion
preferences disable decorative animation.

Run `node tools/ui_design_smoke.cjs` against the local server for responsive
layout, transport, dialog, and scrolling checks. Set `EMBRYOMAKER_URL` for a
nondefault port. `UI_SMOKE_SINGLE_PROCESS=1` is a diagnostic workaround for
macOS environments that cannot register Chromium child-process services.
The broader regression suite is `node tools/ui_smoke.cjs`.

The packaged trajectory is `ui/sea_urchin_project.json.gz`. The JSON endpoint
serves that same file with HTTP gzip encoding. The expanded JSON is generated
locally and excluded from Git. The preview video lives in `ui/assets/`.

