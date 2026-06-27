# mstpd for WebAssembly

This directory builds the mstpd MSTP/RSTP/STP state-machine core (`mstp.c`) as a
WebAssembly module so that spanning-tree **bridges** ("instances") can be
created, wired together and observed entirely from JavaScript.

`wasm_api.c` provides:

* an in-memory registry of bridges and ports,
* a virtual "cable" between two ports: a BPDU transmitted on one port is queued
  and delivered to the port it is linked to,
* explicit, deterministic time (you call `step(seconds)`),
* the `MSTP_OUT_*` outputs the core requires,
* a small C ABI plus JSON state export.

## Building

[Emscripten](https://emscripten.org/) is required.

```sh
make
```

The build produces a single self-contained ES module, `dist/mstpd.mjs`: the wasm
is embedded as base64 (`-sSINGLE_FILE=1`) and the hand-written wrapper
(`wrapper.js`) is concatenated on via `--extern-post-js`. There is no separate
`.wasm` file to ship or locate.

## Testing

```sh
make test          # builds if needed, then runs *.test.mjs
```

## Using it

Import `dist/mstpd.mjs`: alongside Emscripten's default `createMstpd` factory it
exports the ergonomic API (`loadMstpd`, `Mstpd`, `Bridge`, `Port`, `Link`).
Look at `demo.mjs` as a minimal example for Node.

```sh
node demo.mjs
```

### In the browser

`wasm/demo.html` is an interactive version: step time and watch the ports
converge, or break/restore any of the three links to watch the tree heal
around a failure. Browsers refuse to load ES modules over `file://`, so serve
the directory over HTTP rather than opening the file directly:

```sh
python3 -m http.server 8000
open http://localhost:8000/demo.html
```
