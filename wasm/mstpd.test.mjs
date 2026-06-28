// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test suite for the mstpd WebAssembly build.  Uses the zero-dependency
// node:test runner.  Run with `make test` or `node --test *.test.mjs` from wasm/.

import test from "node:test";
import assert from "node:assert/strict";
import { loadMstpd } from "./dist/mstpd.mjs";

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

test("breaking the active link reconverges and restoring recovers", async () => {
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

test("auto-edge: a port seeing no BPDU becomes edge unless auto-edge is off", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  // auto-edge defaults on; the second port has it explicitly disabled.
  const edge = a.addPort("edge", { portno: 1, autoEdge: true });
  const noedge = a.addPort("noedge", { portno: 2, autoEdge: false });
  a.enable();
  edge.enable();
  noedge.enable();
  mstp.step(CONVERGE);

  assert.equal(edge.status().oper_edge, true, "auto-edge port turned edge");
  assert.equal(noedge.status().oper_edge, false, "disabled port did not");
  assert.equal(edge.state(), "forwarding");
});

test("admin p2p: forcing point-to-point off is reflected in oper_p2p", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  // A full-duplex link is auto-detected as point-to-point.
  assert.equal(pa.status().oper_p2p, true);

  pa.setP2P(false);
  mstp.step(CONVERGE);
  assert.equal(pa.status().oper_p2p, false, "forced off");
  assert.equal(pb.status().oper_p2p, true, "neighbour still auto/p2p");
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

test("bridge names are JSON-escaped", async () => {
  const mstp = await loadMstpd();
  const tricky = 'a"b\\c\td'; // quote, backslash, tab (<= 15 chars)
  const a = mstp.createBridge(tricky, { priority: 4096 });
  a.enable();
  const t = mstp.topology(); // throws if the JSON is malformed
  assert.equal(t.bridges[0].name, tricky);
});

test("pure STP triangle breaks the loop and never sends RSTP", async () => {
  const mstp = await loadMstpd();
  const stp = { protocol: "stp" };
  const a = mstp.createBridge("a", { priority: 4096, ...stp });
  const b = mstp.createBridge("b", { priority: 8192, ...stp });
  const c = mstp.createBridge("c", { priority: 12288, ...stp });
  const a1 = a.addPort("a-b", { portno: 1 });
  const a2 = a.addPort("a-c", { portno: 2 });
  const b1 = b.addPort("b-a", { portno: 1 });
  const b2 = b.addPort("b-c", { portno: 2 });
  const c1 = c.addPort("c-a", { portno: 1 });
  const c2 = c.addPort("c-b", { portno: 2 });
  mstp.link(a1, b1);
  mstp.link(a2, c1);
  mstp.link(b2, c2);
  for (const br of [a, b, c]) br.enable();
  for (const p of [a1, a2, b1, b2, c1, c2]) p.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();
  assert.equal(byName(t, "a").is_root, true);
  for (const x of t.bridges)
    assert.equal(
      x.designated_root,
      byName(t, "a").bridge_id,
      `${x.name} agrees`,
    );

  const blocked = t.bridges
    .flatMap((x) => x.ports)
    .filter((p) => p.state === "blocking" || p.state === "discarding");
  assert.equal(blocked.length, 1, "exactly one port breaks the loop");

  // STP bridges must never emit RSTP/MSTP BPDUs.
  for (const p of t.bridges.flatMap((x) => x.ports))
    assert.equal(p.send_rstp, false, `${p.name} stays STP`);
});

test("RSTP falls back to STP when the peer only speaks STP", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096, protocol: "rstp" });
  const b = mstp.createBridge("b", { priority: 8192, protocol: "stp" });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  // The tree still forms: a is root, b reaches it through the link.
  assert.equal(byName(mstp.topology(), "a").is_root, true);
  assert.equal(pa.role(), "Designated");
  assert.equal(pb.role(), "Root");
  assert.equal(pa.state(), "forwarding");
  assert.equal(pb.state(), "forwarding");

  // a started as RSTP but, seeing b's STP BPDUs, migrated that port to STP.
  assert.equal(pa.status().send_rstp, false, "RSTP port fell back to STP");
  assert.equal(pb.status().send_rstp, false, "STP port never sent RSTP");
});

test("MSTP interoperates with an RSTP peer without dropping to STP", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", {
    priority: 4096,
    protocol: "mstp",
    configId: { revision: 1, name: "r1" },
  });
  const b = mstp.createBridge("b", { priority: 8192, protocol: "rstp" });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  // The CIST forms across the MSTP/RSTP boundary: a is root, b reaches it.
  assert.equal(byName(mstp.topology(), "a").is_root, true);
  assert.equal(pa.role(), "Designated");
  assert.equal(pb.role(), "Root");
  assert.equal(pa.state(), "forwarding");
  assert.equal(pb.state(), "forwarding");

  // The RSTP neighbour is a region boundary, but neither side drops to legacy
  // STP: both keep sending RSTP/MSTP BPDUs.
  assert.equal(pa.status().send_rstp, true, "MSTP port operates at RSTP level");
  assert.equal(pb.status().send_rstp, true, "RSTP port stays RSTP");
});

test("an RSTP switch in the middle splits two same-config MSTP bridges into separate regions", async () => {
  const mstp = await loadMstpd();
  const region = { protocol: "mstp", configId: { revision: 1, name: "r1" } };
  // a and c share an identical MST configuration, but the RSTP switch m sits
  // between them. m cannot carry MSTI information, so it is a region boundary
  // for both: the MSTP region cannot span it even though the config matches.
  const a = mstp.createBridge("a", { priority: 4096, ...region });
  const m = mstp.createBridge("m", { priority: 8192, protocol: "rstp" });
  const c = mstp.createBridge("c", { priority: 12288, ...region });
  for (const br of [a, c]) {
    br.createMsti(1);
    br.setVid2Fid(10, 10);
    br.setFid2Mstid(10, 1);
  }
  const a1 = a.addPort("a-m", { portno: 1 });
  const m1 = m.addPort("m-a", { portno: 1 });
  const m2 = m.addPort("m-c", { portno: 2 });
  const c1 = c.addPort("c-m", { portno: 1 });
  mstp.link(a1, m1);
  mstp.link(m2, c1);
  for (const br of [a, m, c]) br.enable();
  for (const p of [a1, m1, m2, c1]) p.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();

  // The CIST spans the whole network: a is the single root and all three agree.
  assert.equal(byName(t, "a").is_root, true);
  for (const x of t.bridges)
    assert.equal(
      x.designated_root,
      byName(t, "a").bridge_id,
      `${x.name} agrees on the CIST root`,
    );

  // The RSTP switch in the middle has no MSTIs at all.
  assert.equal(byName(t, "m").mstis.length, 0);

  // a and c configured the same region, but with the RSTP boundary between them
  // the MSTI cannot span it: each MSTP bridge is its own MSTI 1 regional root.
  const ra = byName(t, "a").mstis[0].regional_root;
  const rc = byName(t, "c").mstis[0].regional_root;
  assert.notEqual(ra, rc, "the RSTP switch splits them into two regions");
});

test("STP, RSTP and MSTP in one triangle converge to a single tree", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096, protocol: "stp" });
  const b = mstp.createBridge("b", { priority: 8192, protocol: "rstp" });
  const c = mstp.createBridge("c", {
    priority: 12288,
    protocol: "mstp",
    configId: { revision: 1, name: "r1" },
  });
  const a1 = a.addPort("a-b", { portno: 1 });
  const a2 = a.addPort("a-c", { portno: 2 });
  const b1 = b.addPort("b-a", { portno: 1 });
  const b2 = b.addPort("b-c", { portno: 2 });
  const c1 = c.addPort("c-a", { portno: 1 });
  const c2 = c.addPort("c-b", { portno: 2 });
  mstp.link(a1, b1); // stp  <-> rstp
  mstp.link(a2, c1); // stp  <-> mstp
  mstp.link(b2, c2); // rstp <-> mstp
  for (const br of [a, b, c]) br.enable();
  for (const p of [a1, a2, b1, b2, c1, c2]) p.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();
  // One root (the STP bridge a) and everyone agrees on it.
  assert.equal(byName(t, "a").is_root, true);
  for (const x of t.bridges)
    assert.equal(
      x.designated_root,
      byName(t, "a").bridge_id,
      `${x.name} agrees`,
    );

  // The single loop is broken by exactly one blocked port.
  const blocked = t.bridges
    .flatMap((x) => x.ports)
    .filter((p) => p.state === "blocking" || p.state === "discarding");
  assert.equal(blocked.length, 1, "exactly one port breaks the loop");

  // Ports facing the STP root fell back to STP; the RSTP<->MSTP link did not.
  assert.equal(b1.status().send_rstp, false, "b's port to STP a fell back");
  assert.equal(c1.status().send_rstp, false, "c's port to STP a fell back");
  assert.equal(b2.status().send_rstp, true, "rstp<->mstp link stays RSTP");
  assert.equal(c2.status().send_rstp, true, "rstp<->mstp link stays RSTP");
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
