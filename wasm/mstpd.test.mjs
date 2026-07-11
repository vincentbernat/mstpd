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

test("deleting a topology leaves no in-flight BPDUs to taint the next one", async () => {
  // Bridges and ports may be deleted and rebuilt on the same engine, and a
  // rebuilt topology must converge exactly like a first-ever build: nothing
  // from the deleted topology may carry over.
  const buildRing = (mstp) => {
    const at = (name, priority) => {
      const br = mstp.createBridge(name, { priority });
      br.enable();
      return { br, next: 1 };
    };
    const nodes = {
      A: at("A", 4096),
      B: at("B", 32768),
      C: at("C", 32768),
      D: at("D", 32768),
    };
    const wire = (x, y) => {
      const px = nodes[x].br.addPort(`${x}.${nodes[x].next++}`, {
        portno: nodes[x].next,
      });
      const py = nodes[y].br.addPort(`${y}.${nodes[y].next++}`, {
        portno: nodes[y].next,
      });
      px.enable();
      py.enable();
      mstp.link(px, py);
    };
    for (const [x, y] of [
      ["A", "B"],
      ["A", "C"],
      ["B", "D"],
      ["C", "D"],
      ["B", "C"],
    ])
      wire(x, y);
    return nodes;
  };
  const rootsAfterOneSecond = (mstp) => {
    mstp.step(1);
    return mstp
      .topology()
      .bridges.filter((b) => b.is_root)
      .map((b) => b.name)
      .sort();
  };

  const fresh = await loadMstpd();
  buildRing(fresh);
  const freshRoots = rootsAfterOneSecond(fresh);
  assert.deepEqual(
    freshRoots,
    ["A", "B", "C", "D"],
    "on a clean start no bridge has deferred yet after one second",
  );

  const reused = await loadMstpd();
  let nodes = buildRing(reused);
  reused.step(CONVERGE); // let it fully settle and transmit for a while
  for (const n of Object.values(nodes)) n.br.delete();
  buildRing(reused); // rebuild on the same engine
  assert.deepEqual(
    rootsAfterOneSecond(reused),
    freshRoots,
    "a rebuild converges like a first-ever build, with no residual state",
  );
});

test("two bridges with two parallel links: one link forwards, the other blocks", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const a1 = a.addPort("a1", { portno: 1 });
  const a2 = a.addPort("a2", { portno: 2 });
  const b1 = b.addPort("b1", { portno: 1 });
  const b2 = b.addPort("b2", { portno: 2 });
  mstp.link(a1, b1);
  mstp.link(a2, b2);
  for (const o of [a, b, a1, a2, b1, b2]) o.enable();
  mstp.step(CONVERGE);

  // a (lower priority) is root. Both its ports are designated and forward.
  assert.equal(byName(mstp.topology(), "a").is_root, true);
  assert.equal(a1.role(), "Designated");
  assert.equal(a2.role(), "Designated");
  assert.equal(a1.state(), "forwarding");
  assert.equal(a2.state(), "forwarding");

  // b picks the lower port id as its root port. The redundant one is a blocked
  // alternate, so the parallel link does not form a loop.
  assert.equal(b1.role(), "Root");
  assert.equal(b1.state(), "forwarding");
  assert.equal(b2.role(), "Alternate");
  assert.equal(b2.state(), "blocking");
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

test("onEvent returns the RSTP states", async () => {
  const mstp = await loadMstpd();
  const events = [];
  mstp.onEvent((e) => events.push(e));
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  const names = events.filter((e) => e.bridge == "a").map((e) => e.event);
  assert.ok(names.includes("proposal"), "a proposal was sent");
  assert.ok(names.includes("agreement"), "an agreement was sent");
  assert.ok(names.includes("blocking"), "some port was in blocking state");
  assert.ok(names.includes("learning"), "some port was in learning state");

  // The handshake drives forwarding: a proposal precedes any forwarding.
  assert.ok(
    names.indexOf("forwarding") > names.indexOf("proposal"),
    "forwarding follows the handshake",
  );
  assert.ok(
    names.indexOf("forwarding") > names.indexOf("learning"),
    "forwarding follows learning",
  );
  assert.ok(
    names.indexOf("learning") > names.indexOf("blocking"),
    "learning follows blocking",
  );

  // Both devices forward, and every event is attributed to its bridge (not mixed).
  const forwarded = new Set(
    events.filter((e) => e.event === "forwarding").map((e) => e.bridge),
  );
  assert.deepEqual([...forwarded].sort(), ["a", "b"]);
  assert.ok(events.every((e) => e.bridge === "a" || e.bridge === "b"));
});

test("a topology change is emitted the same second as the handshake, then persists briefly", async () => {
  // BPDU emission is event-driven: when a port reaches forwarding, the
  // TC-flagged BPDU goes out inside the very same deliver loop, not on the next
  // one-second tick. The TC flag then rides the periodic hellos for the tcWhile
  // window (a few seconds) before the port goes quiet again.
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const a1 = a.addPort("a1", { portno: 1 });
  const b1 = b.addPort("b1", { portno: 1 });
  mstp.link(a1, b1);
  for (const o of [a, b, a1, b1]) o.enable();
  mstp.step(CONVERGE); // a-b settles and its tcWhile timers expire

  // Grow the network: a third bridge joins b. Its port reaching forwarding is a
  // fresh topology change we can watch second by second.
  const c = mstp.createBridge("c", { priority: 12288 });
  const b2 = b.addPort("b2", { portno: 2 });
  const c1 = c.addPort("c1", { portno: 1 });
  mstp.link(b2, c1);
  for (const o of [c, b2, c1]) o.enable();

  let forwarded = false;
  mstp.onEvent((e) => {
    if (e.event === "forwarding") forwarded = true;
  });
  const ports = [a1, b1, b2, c1];
  const txTcn = () => ports.reduce((s, p) => s + p.status().tx_tcn, 0);

  const trace = [];
  let prev = txTcn();
  for (let t = 1; t <= 8; t++) {
    forwarded = false;
    mstp.step(1);
    const now = txTcn();
    trace.push({ t, forwarded, tc: now - prev });
    prev = now;
  }

  // The handshake (a port reaching forwarding) and the TC BPDU land in the same
  // second, and nothing announced a change before it.
  const handshake = trace.find((s) => s.forwarded);
  assert.ok(handshake, "the new port reached forwarding");
  assert.ok(handshake.tc > 0, "the TC flag went out in the very same second");
  assert.ok(
    trace.filter((s) => s.t < handshake.t).every((s) => s.tc === 0),
    "no topology change was announced before the handshake",
  );

  // The flag then keeps riding the periodic hellos for a couple of seconds and
  // stops once tcWhile expires and the network is quiet again.
  const after = trace.filter((s) => s.t > handshake.t);
  assert.ok(
    after.some((s) => s.tc > 0),
    "the TC flag persists on the following hellos",
  );
  assert.ok(
    after.some((s) => s.tc === 0),
    "the TC flag eventually stops",
  );
});

test("onEvent(null) detaches the listener", async () => {
  const mstp = await loadMstpd();
  let count = 0;
  mstp.onEvent(() => count++);
  const a = mstp.createBridge("a", { priority: 4096 });
  const p = a.addPort("p", { portno: 1 });
  a.enable();
  p.enable();
  mstp.step(CONVERGE);
  assert.ok(count > 0, "events arrived while attached");

  const seen = count;
  mstp.onEvent(null);
  mstp.step(CONVERGE);
  assert.equal(count, seen, "no events after detaching");
});

test("two ports on the same segment: one is designated, the other backup", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", { priority: 4096 });
  const a1 = a.addPort("a1", { portno: 1 });
  const a2 = a.addPort("a2", { portno: 2 });
  mstp.link(a1, a2); // self-loop: a is the designated bridge on its own segment
  for (const o of [a, a1, a2]) o.enable();
  mstp.step(CONVERGE);

  // Lower port id wins designated; the redundant one backs it up.
  assert.equal(a1.role(), "Designated");
  assert.equal(a1.state(), "forwarding");
  assert.equal(a2.role(), "Backup");
  assert.notEqual(a2.state(), "forwarding");
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

test("bpdu guard: a guarded port receiving a BPDU trips the guard and goes down", async () => {
  const mstp = await loadMstpd();
  mstp.setLogLevel(0); // the guard trip logs an expected error
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1, bpduGuard: true });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();

  assert.equal(pa.status().bpdu_guard_port, true);
  assert.equal(
    pa.status().bpdu_guard_error,
    false,
    "guard has not tripped yet",
  );

  mstp.step(CONVERGE);

  // The neighbour's BPDU lands on the guarded port, which err-disables itself.
  assert.equal(pa.status().bpdu_guard_error, true, "guard tripped on the BPDU");
  assert.equal(pa.status().up, false, "the port was taken down");
  assert.equal(pa.role(), "Disabled");
});

test("root guard: a restricted-role port refuses to become the root port", async () => {
  const mstp = await loadMstpd();
  // b would normally make a (lower priority) the root and pick its port toward
  // a as the root port. Root guard (restricted role) bars that port from ever
  // leading to the root, so b keeps itself as root and the port goes blocking.
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1, restrictedRole: true });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  assert.equal(pb.status().restricted_role, true);
  assert.equal(byName(mstp.topology(), "b").is_root, true, "b keeps the root");
  assert.notEqual(pb.role(), "Root", "the superior neighbour is not made root");
  assert.equal(pb.role(), "Alternate");
  assert.equal(pb.state(), "blocking");
  // a is unaffected: it is designated toward b and forwards.
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "forwarding");
});

test("dispute mechanism: a designated port over a one-way link is held blocking", async () => {
  const mstp = await loadMstpd();
  // Superior bridge a, inferior bridge b, joined by a unidirectional link: b's
  // BPDUs reach a, but a's never reach b. b never hears a superior, so it stays
  // root and forwards (setting the Learning flag). a sees an inferior
  // designated BPDU that still claims to be learning and records a dispute,
  // which keeps its own designated port discarding so the pair cannot form a
  // loop.
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.linkOneWay(pb, pa); // b -> a only
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  // a detects the dispute and refuses to forward despite being designated.
  assert.equal(pa.status().disputed, true, "a records the dispute");
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "blocking", "the disputed port is held discarding");

  // b, hearing nothing back, believes it is the root and forwards unguarded.
  assert.equal(byName(mstp.topology(), "b").is_root, true);
  assert.equal(pb.status().disputed, false);
  assert.equal(pb.state(), "forwarding");
});

test("bridge assurance: a network port blocks when its neighbour goes silent", async () => {
  const mstp = await loadMstpd();
  mstp.setLogLevel(0); // the inconsistency logs an expected error

  // Both ends are network ports, so each keeps sending BPDUs regardless of role
  // and bridge assurance stays satisfied. Network ports are switch-facing, so
  // auto-edge is off.
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1, network: true, autoEdge: false });
  const pb = b.addPort("b1", { portno: 1, network: true, autoEdge: false });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  assert.equal(pa.status().network_port, true);
  assert.equal(
    pa.status().ba_inconsistent,
    false,
    "healthy link is consistent",
  );
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "forwarding");

  // The neighbour stops being heard (one-way link). After three missed hellos
  // bridge assurance flags the port inconsistent and holds it discarding, even
  // though it is still the designated port.
  mstp.linkOneWay(pa, pb); // pa still transmits, but no longer hears pb
  mstp.step(CONVERGE);
  assert.equal(
    pa.status().ba_inconsistent,
    true,
    "missed hellos trip assurance",
  );
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "blocking", "assurance holds the port discarding");

  // Restoring two-way BPDUs clears the inconsistency and the port recovers.
  mstp.link(pa, pb);
  mstp.step(CONVERGE);
  assert.equal(pa.status().ba_inconsistent, false, "a fresh BPDU clears it");
  assert.equal(pa.state(), "forwarding");
});

test("configuration set through the API is reflected back in the JSON", async () => {
  const mstp = await loadMstpd();
  const a = mstp.createBridge("a", {
    priority: 4096,
    protocol: "mstp",
    configId: { revision: 7, name: "region-x" },
  });
  a.setTimes({
    maxAge: 18,
    forwardDelay: 12,
    helloTime: 2,
    maxHops: 30,
    txHoldCount: 5,
  });
  a.createMsti(1);
  const p = a.addPort("p1", {
    portno: 1,
    edge: true,
    autoEdge: false,
    p2p: false,
    cost: 12345,
  });
  p.setPathCost(54321, 1);
  a.enable();
  p.enable();

  const b = a.status();
  assert.equal(b.protocol_version, "mstp");
  assert.equal(b.tx_hold_count, 5);
  assert.equal(b.mst_config_name, "region-x");
  assert.equal(b.mst_config_revision, 7);
  assert.equal(b.max_age, 18);
  assert.equal(b.forward_delay, 12);
  assert.equal(b.max_hops, 30);

  const ps = p.status();
  assert.equal(ps.admin_edge, true);
  assert.equal(ps.auto_edge, false);
  assert.equal(ps.admin_p2p, "no");
  assert.equal(ps.admin_external_path_cost, 12345);
  const msti = ps.mstis.find((m) => m.mstid === 1);
  assert.equal(msti.admin_internal_path_cost, 54321);
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

test("two MSTP regions: the CIST spans both while each keeps its own MSTI tree", async () => {
  const mstp = await loadMstpd();
  const r1 = { protocol: "mstp", configId: { revision: 1, name: "r1" } };
  const r2 = { protocol: "mstp", configId: { revision: 2, name: "r2" } };
  // Region 1 = {a, b}, region 2 = {c, d}. The regions touch through two links
  // (a-c and b-d), so there is an inter-region loop the Common Spanning Tree
  // must break. Internal links a-b and c-d close each region.
  const a = mstp.createBridge("a", { priority: 4096, ...r1 });
  const b = mstp.createBridge("b", { priority: 8192, ...r1 });
  const c = mstp.createBridge("c", { priority: 12288, ...r2 });
  const d = mstp.createBridge("d", { priority: 16384, ...r2 });
  for (const br of [a, b, c, d]) {
    br.createMsti(1);
    br.setVid2Fid(10, 10);
    br.setFid2Mstid(10, 1);
  }
  const ab = a.addPort("a-b", { portno: 1 });
  const ba = b.addPort("b-a", { portno: 1 });
  const cd = c.addPort("c-d", { portno: 1 });
  const dc = d.addPort("d-c", { portno: 1 });
  const ac = a.addPort("a-c", { portno: 2 });
  const ca = c.addPort("c-a", { portno: 2 });
  const bd = b.addPort("b-d", { portno: 2 });
  const db = d.addPort("d-b", { portno: 2 });
  mstp.link(ab, ba); // region 1 internal
  mstp.link(cd, dc); // region 2 internal
  mstp.link(ac, ca); // boundary
  mstp.link(bd, db); // boundary
  const ports = [ab, ba, cd, dc, ac, ca, bd, db];
  for (const br of [a, b, c, d]) br.enable();
  for (const p of ports) p.enable();
  mstp.step(CONVERGE);

  const t = mstp.topology();

  // The CIST is the network-wide tree: a is the one root and all four agree.
  assert.equal(byName(t, "a").is_root, true);
  for (const x of t.bridges)
    assert.equal(
      x.designated_root,
      byName(t, "a").bridge_id,
      `${x.name} agrees on the CIST root`,
    );

  // MSTIs never cross a region boundary: each region elects its own MSTI 1
  // regional root, so the two regions disagree.
  const rrOf = (n) => byName(t, n).mstis[0].regional_root;
  assert.equal(rrOf("a"), rrOf("b"), "region 1 shares one MSTI regional root");
  assert.equal(rrOf("c"), rrOf("d"), "region 2 shares one MSTI regional root");
  assert.notEqual(rrOf("a"), rrOf("c"), "the two regions are distinct");

  // The CST breaks the inter-region loop with exactly one blocked port.
  const blocked = t.bridges
    .flatMap((x) => x.ports)
    .filter((p) => p.state === "blocking" || p.state === "discarding");
  assert.equal(blocked.length, 1, "the CST breaks the inter-region loop");
  assert.equal(
    db.role(),
    "Alternate",
    "the redundant boundary link is blocked",
  );

  // The active boundary port is a region gateway: its CIST role is Root, but
  // for the MSTI it takes the Master role (the path out of the region toward
  // the CIST root). Both regions keep speaking RSTP/MSTP across the boundary.
  assert.equal(ca.role(), "Root", "boundary port is the CIST root port");
  assert.equal(ca.role(1), "Master", "and the MSTI master toward the root");
  assert.equal(
    ca.status().send_rstp,
    true,
    "no fallback to STP at the boundary",
  );
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
