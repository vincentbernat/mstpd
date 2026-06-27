// SPDX-License-Identifier: GPL-2.0-or-later
//
// Demo: three MSTP bridges wired into a triangle (a physical loop).  Spanning
// tree should elect br-a as root (lowest priority) and put exactly one port
// into the blocking/discarding state to break the loop.
//
// Run with:  node wasm/demo.mjs

import { loadMstpd } from "./dist/mstpd.mjs";

const mstp = await loadMstpd();
// mstp.setLogLevel(2); // uncomment for INFO-level logging on stderr

const a = mstp.createBridge("br-a", { priority: 4096 });
const b = mstp.createBridge("br-b", { priority: 8192 });
const c = mstp.createBridge("br-c", { priority: 12288 });

const a1 = a.addPort("a-b", { portno: 1 });
const a2 = a.addPort("a-c", { portno: 2 });
const b1 = b.addPort("b-a", { portno: 1 });
const b2 = b.addPort("b-c", { portno: 2 });
const c1 = c.addPort("c-a", { portno: 1 });
const c2 = c.addPort("c-b", { portno: 2 });

mstp.link(a1, b1); // a <-> b
mstp.link(a2, c1); // a <-> c
mstp.link(b2, c2); // b <-> c

for (const br of [a, b, c]) br.enable();
for (const p of [a1, a2, b1, b2, c1, c2]) p.enable();

// Execute 40 seconds.
mstp.step(40);

const topo = mstp.topology();
console.log(`BPDUs delivered: ${topo.frames_delivered}\n`);
for (const br of topo.bridges) {
  console.log(
    `${br.name}  id=${br.bridge_id}  root=${br.designated_root}` +
      `  cumulative cost to root=${br.root_path_cost}  ${br.is_root ? "<= ROOT" : ""}`,
  );
  for (const p of br.ports) {
    console.log(
      `    ${p.name.padEnd(4)} role=${p.role.padEnd(11)} state=${p.state}`,
    );
  }
  console.log("");
}

const blocked = topo.bridges
  .flatMap((br) => br.ports.map((p) => ({ br: br.name, ...p })))
  .filter((p) => p.state === "blocking" || p.state === "discarding");
console.log(
  `Blocked ports: ` +
    (blocked.length
      ? blocked.map((p) => `${p.br}/${p.name}`).join(", ")
      : "(none)"),
);

const root = topo.bridges.find((br) => br.is_root);
console.log(`Elected root bridge: ${root ? root.name : "(none yet)"}`);
