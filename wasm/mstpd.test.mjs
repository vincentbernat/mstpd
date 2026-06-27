// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test suite for the mstpd WebAssembly build.  Uses the zero-dependency
// node:test runner.  Run with `make test` or `node --test *.test.mjs` from wasm/.

import test from "node:test";
import assert from "node:assert/strict";
import { loadMstpd } from "./mstpd.mjs";

// 40 "seconds" is ample for these small point-to-point topologies to converge.
const CONVERGE = 40;

function byName(topo, name) {
  return topo.bridges.find((b) => b.name === name);
}

// Three bridges wired into a triangle (a physical loop). br-a has the lowest
// priority and should become root. Returns handles plus the three links.
function buildTriangle(mstp) {
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const c = mstp.createBridge("c", { priority: 12288 });
  const a1 = a.addPort("a-b", { portno: 1 });
  const a2 = a.addPort("a-c", { portno: 2 });
  const b1 = b.addPort("b-a", { portno: 1 });
  const b2 = b.addPort("b-c", { portno: 2 });
  const c1 = c.addPort("c-a", { portno: 1 });
  const c2 = c.addPort("c-b", { portno: 2 });
  const ab = mstp.link(a1, b1);
  const ac = mstp.link(a2, c1);
  const bc = mstp.link(b2, c2);
  for (const br of [a, b, c]) br.enable();
  for (const p of [a1, a2, b1, b2, c1, c2]) p.enable();
  return { a, b, c, a1, a2, b1, b2, c1, c2, ab, ac, bc };
}

test("two bridges: lower priority becomes root", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();
  assert.equal(byName(t, "a").is_root, true);
  assert.equal(byName(t, "b").is_root, false);
  assert.equal(pa.role(), "Designated");
  assert.equal(pb.role(), "Root");
  assert.equal(pa.state(), "forwarding");
  assert.equal(pb.state(), "forwarding");
  assert.equal(byName(t, "b").root_path_cost, 20000);
});

test("triangle loop: exactly one port blocks and all agree on the root", async () => {
  const mstp = await loadMstpd();
  buildTriangle(mstp);
  mstp.step(CONVERGE);

  const t = mstp.topology();
  const root = t.bridges.find((b) => b.is_root);
  assert.equal(root.name, "a");

  const blocked = t.bridges
    .flatMap((b) => b.ports)
    .filter((p) => p.state === "blocking" || p.state === "discarding");
  assert.equal(blocked.length, 1, "exactly one port should break the loop");

  for (const b of t.bridges) {
    assert.equal(b.designated_root, root.bridge_id, `${b.name} agrees on root`);
  }
});

test("breaking the active link reconverges; restoring recovers", async () => {
  const mstp = await loadMstpd();
  const g = buildTriangle(mstp);
  mstp.step(CONVERGE);

  // c reaches the root through c-a (link a-c); c-b is the blocked alternate.
  assert.equal(g.c1.role(), "Root");
  assert.equal(g.c2.state(), "blocking");

  g.ac.break();
  mstp.step(CONVERGE);
  assert.equal(g.c1.role(), "Disabled"); // cable down
  assert.equal(g.c2.role(), "Root"); // alternate took over
  assert.equal(g.c2.state(), "forwarding");
  assert.equal(byName(mstp.topology(), "c").root_path_cost, 40000); // via b

  g.ac.restore();
  mstp.step(CONVERGE);
  assert.equal(g.c1.role(), "Root");
  assert.equal(g.c2.state(), "blocking");
});

test("port path cost selects the root port", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const a1 = a.addPort("a1", { portno: 1 });
  const a2 = a.addPort("a2", { portno: 2 });
  const b1 = b.addPort("b1", { portno: 1, cost: 200000 }); // expensive
  const b2 = b.addPort("b2", { portno: 2, cost: 20000 }); // cheap
  mstp.link(a1, b1);
  mstp.link(a2, b2);
  for (const o of [a, b, a1, a2, b1, b2]) o.enable();
  mstp.step(CONVERGE);

  assert.equal(b2.role(), "Root", "cheaper port is the root port");
  assert.notEqual(b1.role(), "Root");
  assert.equal(byName(mstp.topology(), "b").root_path_cost, 20000);
});

test("MSTP bridges in the same region share an MSTI regional root", async () => {
  const mstp = await loadMstpd();
  const region = { protocol: "mstp", configId: { revision: 1, name: "r1" } };
  const a = mstp.createBridge("a", { priority: 4096, ...region });
  const b = mstp.createBridge("b", { priority: 8192, ...region });
  for (const br of [a, b]) {
    br.createMsti(1);
    br.setVid2Fid(10, 10);
    br.setFid2Mstid(10, 1);
  }
  a.setPriority(4096, 1);
  b.setPriority(8192, 1);
  const a1 = a.addPort("a1", { portno: 1 });
  const b1 = b.addPort("b1", { portno: 1 });
  mstp.link(a1, b1);
  for (const o of [a, b, a1, b1]) o.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();
  const ra = byName(t, "a").mstis[0].regional_root;
  const rb = byName(t, "b").mstis[0].regional_root;
  assert.equal(ra, rb, "both agree on the MSTI 1 regional root");
  assert.equal(a1.role(1), "Designated");
  assert.equal(b1.role(1), "Root");
});

test("global timers: a valid set applies, an invalid combination is rejected", async () => {
  const mstp = await loadMstpd();
  mstp.setLogLevel(0); // the invalid set below logs an expected error
  const a = mstp.createBridge("a", { priority: 4096 });
  a.enable();

  assert.equal(a.setTimes({ forwardDelay: 10, maxAge: 18 }), 0);
  assert.equal(a.status().forward_delay, 10);
  assert.equal(a.status().max_age, 18);

  // 2*(fd-1) must be >= max age: 2*(4-1)=6 < 40 -> rejected, nothing changes.
  assert.ok(a.setTimes({ forwardDelay: 4, maxAge: 40 }) < 0);
  assert.equal(a.status().forward_delay, 10);
  assert.equal(a.status().max_age, 18);
});

test("an unlinked, enabled port becomes designated/forwarding", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const p = a.addPort("lonely", { portno: 1 });
  a.enable();
  p.enable();
  mstp.step(CONVERGE);

  assert.equal(p.role(), "Designated");
  assert.equal(p.state(), "forwarding");
});

test("BPDUs are exchanged and counters advance", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  assert.ok(mstp.topology().frames_delivered > 0);
  assert.ok(pa.status().tx_bpdu > 0);
  assert.ok(pb.status().rx_bpdu > 0);
});

test("bridge names are JSON-escaped (no invalid JSON)", async () => {
  const mstp = await loadMstpd();
  const tricky = 'a"b\\c\td'; // quote, backslash, tab (<= 15 chars)
  const a = mstp.createBridge(tricky, { priority: 4096 });
  a.enable();
  const t = mstp.topology(); // throws if the JSON is malformed
  assert.equal(t.bridges[0].name, tricky);
});

test("a chain longer than Max Age elects more than one root", async () => {
  const mstp = await loadMstpd();
  const N = 12;
  const br = [];
  for (let i = 0; i < N; i++) {
    const b = mstp.createBridge("b" + i, { priority: 32768 });
    b.setTimes({ maxAge: 6 });
    br.push(b);
  }
  const ports = [];
  for (let i = 0; i < N - 1; i++) {
    const right = br[i].addPort(`p${i}r`, { portno: 2 });
    const left = br[i + 1].addPort(`p${i + 1}l`, { portno: 1 });
    mstp.link(right, left);
    ports.push(right, left);
  }
  for (const b of br) b.enable();
  for (const p of ports) p.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();
  const roots = t.bridges.filter((b) => b.is_root).map((b) => b.name);
  assert.deepEqual(
    roots.sort(),
    ["b0", "b7"],
    "two separate roots are elected",
  );

  // The network is genuinely partitioned: not everyone agrees on one root.
  const domains = new Set(t.bridges.map((b) => b.designated_root));
  assert.equal(domains.size, 2);
});
