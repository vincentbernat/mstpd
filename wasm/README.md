# MSTPD for WebAssembly

This directory builds the MSTP/RSTP/STP state-machine core (`mstp.c`) as a
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

Import `dist/mstpd.mjs`: alongside Emscripten's default `createMSTPD` factory it
exports the ergonomic API (`loadMSTPD`, `MSTPD`, `Bridge`, `Port`, `Link`).
Look at `demo.mjs` as a minimal example for Node.

```sh
node demo.mjs
```

### Capturing BPDUs

Call `mstp.capture()` to start recording every transmitted BPDU into a ring
buffer (the most recent ~8000 frames are kept). `mstp.pcap()` returns them as a
classic pcap file (a `Uint8Array`), with each BPDU wrapped in the Ethernet/LLC
framing a bridge puts on the wire, timestamped by the simulation clock. The
result opens directly in Wireshark or `tshark`. In the browser,
`mstp.downloadPcap()` saves it as a `.pcap` download.

```js
mstp.capture();
mstp.step(30);
writeFileSync("bpdus.pcap", mstp.pcap());
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

## License

The files are licensed as GPL-2.0-or-later, like MSTPD, except the sprites used
for a demo. For the spritesheets stan.png and blobby.png, you can find the
license in https://craftpix.net/file-licenses/ (section 2). coffee.png is cut
from the "16x16 Specialty Coffee" pack by Yanin,
https://yaninyunus.itch.io/16x16-specialtycoffee
