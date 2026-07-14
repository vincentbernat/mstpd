// SPDX-License-Identifier: GPL-2.0-or-later
//
// Test suite for the mstpd WebAssembly build.  Uses the zero-dependency
// node:test runner.  Run with `make test` or `node --test *.test.mjs` from wasm/.

import test from "node:test";
import assert from "node:assert/strict";
import { loadMSTPD } from "./dist/mstpd.mjs";

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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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

  const fresh = await loadMSTPD();
  buildRing(fresh);
  const freshRoots = rootsAfterOneSecond(fresh);
  assert.deepEqual(
    freshRoots,
    ["A", "B", "C", "D"],
    "on a clean start no bridge has deferred yet after one second",
  );

  const reused = await loadMSTPD();
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

test("delivering a second's BPDUs one generation at a time matches step()", async () => {
  // oneSecond() followed by a loop of deliverBPDUs() walks a second's delivery
  // cascade one BFS generation at a time. It must land in exactly the same
  // place as step(1), and the generations must be causal: a proposal is
  // delivered before the forwarding it leads to.
  const roles = (m) =>
    m
      .topology()
      .bridges.flatMap((b) =>
        b.ports.map((p) => `${p.name}:${p.role}/${p.state}`),
      )
      .join(" ");

  // Same topology on two engines: one stepped whole seconds, one wave by wave.
  const whole = await loadMSTPD();
  buildTriangle(whole);
  whole.step(CONVERGE);

  const waved = await loadMSTPD();
  buildTriangle(waved);
  let sawCascade = false;
  for (let s = 0; s < CONVERGE; s++) {
    waved.oneSecond();
    let gens = 0;
    while (waved.deliverBPDUs() > 0) gens++;
    if (gens > 1) sawCascade = true; // a handshake took several generations
  }
  assert.equal(
    roles(waved),
    roles(whole),
    "wave-driven convergence matches step()",
  );
  assert.ok(
    sawCascade,
    "at least one second needed multiple delivery generations",
  );

  // A fresh point-to-point handshake, watched generation by generation: record
  // the first generation each event appears in (encoded as second*1000 + wave).
  const eng = await loadMSTPD();
  const a = eng.createBridge("a", { priority: 4096 });
  const b = eng.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  eng.link(pa, pb);

  const genOf = {};
  let events = [];
  // A port sends its first BPDU as soon as it comes up, so watch from before it
  // is enabled.
  eng.onEvent((e) => events.push(e));
  for (const o of [a, b, pa, pb]) o.enable();

  for (let s = 0; s < CONVERGE; s++) {
    let gen = 0;
    const record = () => {
      for (const e of events)
        if (!(e.event in genOf)) genOf[e.event] = s * 1000 + gen;
      events = [];
    };
    events = [];
    eng.oneSecond();
    record();
    while (eng.deliverBPDUs() > 0) {
      gen++;
      record();
    }
  }
  assert.ok("proposal" in genOf, "a proposal was seen");
  assert.ok("forwarding" in genOf, "a forwarding transition was seen");
  assert.ok(
    genOf.proposal < genOf.forwarding,
    "the proposal is delivered before the forwarding it triggers",
  );
});

test("two bridges with two parallel links: one link forwards, the other blocks", async () => {
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
  const a = mstp.createBridge("a", { priority: 4096 });
  const p = a.addPort("lonely", { portno: 1 });
  a.enable();
  p.enable();
  mstp.step(CONVERGE);

  assert.equal(p.role(), "Designated");
  assert.equal(p.state(), "forwarding");
});

test("a port only gets a carrier once both ends of its cable are up", async () => {
  const mstp = await loadMSTPD();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  const link = mstp.link(pa, pb);
  a.enable();
  b.enable();

  pa.enable();
  assert.equal(pa.status().up, false, "the other end of the cable is down");
  assert.equal(pb.status().up, false, "and it has not been enabled yet");

  pb.enable();
  assert.equal(pa.status().up, true, "both ends are enabled, so both are up");
  assert.equal(pb.status().up, true);

  // Coming up together is what keeps the BPDU a port sends as it comes up: were
  // its peer still down, the frame would have nowhere to go.
  assert.equal(
    mstp.deliverBPDUs(),
    2,
    "each end's first BPDU reached the other",
  );

  // Cutting the cable takes both ends with it, and so does replugging it.
  link.break();
  assert.equal(pa.status().up, false);
  assert.equal(pb.status().up, false);
  link.restore();
  assert.equal(pa.status().up, true);
  assert.equal(pb.status().up, true);
  assert.equal(mstp.deliverBPDUs(), 2, "and again once the cable is back");

  // Nothing to wait for when there is no cable at all.
  const lonely = a.addPort("a2", { portno: 2 });
  lonely.enable();
  assert.equal(lonely.status().up, true, "an unlinked port needs no peer");
});

test("queuedBPDUs describes the BPDUs waiting on the wire", async () => {
  const mstp = await loadMSTPD();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  const link = mstp.link(pa, pb);

  assert.deepEqual(mstp.queuedBPDUs(), [], "nothing on the wire yet");

  // Both ends come up together, and each proposes: neither has heard of the
  // other, so each believes it is the root.
  for (const o of [a, b, pa, pb]) o.enable();
  const first = mstp.queuedBPDUs();
  assert.equal(first.length, 2, "one BPDU each way");
  assert.deepEqual(
    first.map((f) => [f.src, f.dst]).sort(),
    [
      [pa.handle, pb.handle],
      [pb.handle, pa.handle],
    ].sort(),
    "each frame goes from its port to the far end of the cable",
  );
  assert.ok(
    first.every((f) => f.proposal && !f.tc),
    "both propose, and nothing has changed yet to report",
  );

  // seq only grows, so it tells the frames already seen from the newer ones.
  const seqs = first.map((f) => f.seq).sort((x, y) => x - y);
  assert.deepEqual(
    mstp.queuedBPDUs(seqs[1]),
    [],
    "nothing has been sent since the newest one",
  );
  assert.deepEqual(
    mstp.queuedBPDUs(seqs[0]).map((f) => f.seq),
    [seqs[1]],
    "only what came after the oldest one",
  );

  // Delivering leaves the queue holding what the delivery triggered, not what
  // it delivered: b has heard a is the better root, and agrees.
  assert.equal(mstp.deliverBPDUs(), 2);
  const reply = mstp.queuedBPDUs();
  assert.equal(reply.length, 1);
  assert.equal(reply[0].src, pb.handle, "b answers a");
  assert.ok(reply[0].agreement, "b agrees, so a need not wait to forward");
  assert.ok(!reply[0].proposal, "b no longer claims the root");
  assert.ok(reply[0].tc, "b's port moved, which is a topology change");
  assert.ok(
    reply[0].seq > seqs[1],
    "an answer is newer than what it answers to",
  );

  // Cutting the cable throws away what was still on it.
  link.break();
  assert.deepEqual(mstp.queuedBPDUs(), [], "the wire is empty once cut");
});

test("onEvent returns the RSTP states", async () => {
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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

test("no-p2p link stays learning a whole second at a time", async () => {
  // On a point-to-point link the proposal/agreement handshake moves a port
  // straight into forwarding, so a per-second snapshot never sees it learning.
  // Forcing p2p off disables the handshake, so the port must go through
  // discarding -> learning -> forwarding on the forward-delay timer, and the
  // learning state stays visible from one second to the next.
  const statesSecondBySecond = async (p2p) => {
    const mstp = await loadMSTPD();
    const a = mstp.createBridge("a", { priority: 4096 });
    const b = mstp.createBridge("b", { priority: 8192 });
    for (const br of [a, b]) br.setTimes({ forwardDelay: 4, maxAge: 6 });
    const pa = a.addPort("a1", { portno: 1, p2p });
    const pb = b.addPort("b1", { portno: 1, p2p });
    mstp.link(pa, pb);
    for (const o of [a, b, pa, pb]) o.enable();

    const seen = new Set();
    for (let s = 0; s < CONVERGE; s++) {
      mstp.step(1);
      seen.add(pa.state());
      seen.add(pb.state());
    }
    assert.equal(
      pa.state(),
      "forwarding",
      "designated port settles forwarding",
    );
    assert.equal(pb.state(), "forwarding", "root port settles forwarding");
    return seen;
  };

  const slow = await statesSecondBySecond(false);
  assert.ok(slow.has("learning"), "a no-p2p port dwells in learning");

  const fast = await statesSecondBySecond(true);
  assert.ok(!fast.has("learning"), "a p2p handshake skips visible learning");
});

test("bpdu guard: a guarded port receiving a BPDU goes down", async () => {
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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

test("dispute mechanism: a port coming up on a one-way link is held blocking", async () => {
  const mstp = await loadMSTPD();
  // Superior bridge a, inferior bridge b, joined by a unidirectional link from
  // the start: b's BPDUs reach a, but a's never reach b. b hears nothing at
  // all, so it turns its port into an edge and forwards. a sees an inferior
  // designated BPDU and records a dispute, which keeps its own designated port
  // discarding so the pair cannot form a loop.
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.linkOneWay(pb, pa); // b -> a only
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);

  // The disputed flag stays set here: a's port is already discarding, so the
  // transition that would clear it never runs again.
  assert.equal(pa.status().disputed, true, "a records the dispute");
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "blocking", "the disputed port is held discarding");

  // b gets no BPDU at all, so it stays root and forwards.
  assert.equal(byName(mstp.topology(), "b").is_root, true);
  assert.equal(pb.status().oper_edge, true, "no BPDU ever reached b");
  assert.equal(pb.status().disputed, false);
  assert.equal(pb.state(), "forwarding");
});

test("dispute mechanism: a one-way fault after convergence stops the loop", async () => {
  const mstp = await loadMSTPD();
  // The link works first and the pair converges. Only then does a stop
  // transmitting. b has been getting BPDUs, so it is not an edge port.
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();
  mstp.step(CONVERGE);
  assert.equal(pa.role(), "Designated");
  assert.equal(pa.state(), "forwarding");
  assert.equal(pb.role(), "Root");

  mstp.linkOneWay(pb, pa); // a still receives, but cannot transmit

  // After three hellos, b times out what it knows about a. It becomes root and
  // the designated bridge on the link, and keeps forwarding.
  mstp.step(10);
  assert.equal(byName(mstp.topology(), "b").is_root, true);
  assert.equal(pb.status().oper_edge, false, "b heard a until the fault");
  assert.equal(pb.role(), "Designated");
  assert.equal(pb.state(), "forwarding");
  assert.equal(pa.state(), "blocking", "a stopped forwarding");

  // Check the port state twice per second: after the timers run, and after b's
  // BPDU is delivered.
  const afterTimers = new Set();
  const afterBpdu = new Set();
  const rxBefore = pa.status().rx_bpdu;
  for (let s = 0; s < CONVERGE; s++) {
    mstp.oneSecond();
    afterTimers.add(pa.state());
    while (mstp.deliverBPDUs() > 0);
    afterBpdu.add(pa.state());
  }

  // a stays designated on a link where nobody gets its BPDUs. The forward delay
  // moves its port to learning, then each BPDU from b disputes it and puts it
  // back to discarding. It never reaches forwarding, so there is no loop.
  assert.equal(pa.role(), "Designated");
  assert.ok(pa.status().rx_bpdu > rxBefore, "a still receives from b");
  assert.ok(afterTimers.has("learning"), "the forward delay moves it up");
  assert.deepEqual(
    [...afterBpdu],
    ["blocking"],
    "each BPDU from b puts it back to discarding",
  );
  assert.ok(!afterTimers.has("forwarding"), "it never forwards again");

  // The flag cannot be checked here: the port is learning or forwarding when the
  // BPDU arrives, so the move to discarding clears it right away.
  assert.equal(pa.status().disputed, false);
});

test("bridge assurance: a network port blocks when its neighbour goes silent", async () => {
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
  const tricky = 'a"b\\c\td'; // quote, backslash, tab (<= 15 chars)
  const a = mstp.createBridge(tricky, { priority: 4096 });
  a.enable();
  const t = mstp.topology(); // throws if the JSON is malformed
  assert.equal(t.bridges[0].name, tricky);
});

test("pure STP triangle breaks the loop and never sends RSTP", async () => {
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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
  const mstp = await loadMSTPD();
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

test("capture: transmitted BPDUs come back as a valid pcap", async () => {
  const mstp = await loadMSTPD();
  const a = mstp.createBridge("a", { priority: 4096 });
  const b = mstp.createBridge("b", { priority: 8192 });
  const pa = a.addPort("a1", { portno: 1 });
  const pb = b.addPort("b1", { portno: 1 });
  mstp.link(pa, pb);
  for (const o of [a, b, pa, pb]) o.enable();

  mstp.capture();
  mstp.step(CONVERGE);
  const pcap = mstp.pcap();

  // Global header: magic and LINKTYPE_ETHERNET, little-endian.
  const view = new DataView(pcap.buffer);
  assert.equal(view.getUint32(0, true), 0xa1b2c3d4, "pcap magic");
  assert.equal(view.getUint32(20, true), 1, "LINKTYPE_ETHERNET");

  // Walk the records and sanity-check the first frame's framing.
  let o = 24;
  let count = 0;
  let firstFrame = null;
  while (o < pcap.length) {
    const inclLen = view.getUint32(o + 8, true);
    const frame = pcap.subarray(o + 16, o + 16 + inclLen);
    if (!firstFrame) firstFrame = frame;
    count++;
    o += 16 + inclLen;
  }
  assert.equal(o, pcap.length, "records tile the file exactly");
  assert.ok(count > 0, "at least one BPDU was captured");

  const dst = Array.from(firstFrame.subarray(0, 6));
  assert.deepEqual(
    dst,
    [0x01, 0x80, 0xc2, 0x00, 0x00, 0x00],
    "STP multicast dst",
  );
  const llc = Array.from(firstFrame.subarray(14, 17));
  assert.deepEqual(llc, [0x42, 0x42, 0x03], "LLC header");
  const payloadLen = (firstFrame[12] << 8) | firstFrame[13];
  assert.equal(payloadLen, firstFrame.length - 14, "802.3 length field");

  // Reading is non-destructive: the ring is intact, so a second call matches.
  assert.equal(mstp.pcap().length, pcap.length, "pcap() is repeatable");
});

test("capture: off by default and cleared on re-enable", async () => {
  const mstp = await loadMSTPD();
  const a = mstp.createBridge("a", { priority: 4096 });
  const pa = a.addPort("a1", { portno: 1 });
  a.enable();
  pa.enable();

  // No capture() call: pcap holds only the 24-byte global header.
  mstp.step(5);
  assert.equal(mstp.pcap().length, 24, "nothing captured when off");

  mstp.capture();
  mstp.step(5);
  const withFrames = mstp.pcap().length;
  assert.ok(withFrames > 24, "frames recorded once on");

  // Re-enabling starts fresh.
  mstp.capture();
  assert.equal(mstp.pcap().length, 24, "re-enable clears the buffer");
});

test("capture: the ring keeps the most recent BPDUs, bounded", async () => {
  const mstp = await loadMSTPD();
  buildTriangle(mstp);
  mstp.capture();

  // Run far longer than the ring can hold so it must wrap around.
  mstp.step(20000);

  const pcap = mstp.pcap();
  const view = new DataView(pcap.buffer);
  let o = 24;
  let count = 0;
  let minT = Infinity;
  let maxT = 0;
  while (o < pcap.length) {
    const sec = view.getUint32(o, true);
    const inclLen = view.getUint32(o + 8, true);
    minT = Math.min(minT, sec);
    maxT = Math.max(maxT, sec);
    o += 16 + inclLen;
    count++;
  }

  // Bounded: it never keeps more than the ring's capacity.
  assert.ok(count > 1000, "a long run fills the ring");
  assert.ok(count <= 8192, "capped at the ring capacity");
  // The newest frame is from the end of the run and the oldest was dropped.
  assert.ok(maxT >= 19990, "most recent frames are kept");
  assert.ok(minT > 100, "oldest frames were overwritten");
});

test("capture: pcap(port) downloads only that link", async () => {
  const mstp = await loadMSTPD();
  const g = buildTriangle(mstp);
  mstp.capture();
  mstp.step(CONVERGE);

  // Collect the distinct source MACs present in a pcap.
  const srcSet = (pcap) => {
    const view = new DataView(pcap.buffer);
    const set = new Set();
    let o = 24;
    while (o < pcap.length) {
      const inclLen = view.getUint32(o + 8, true);
      const src = Array.from(pcap.subarray(o + 16 + 6, o + 16 + 12))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(":");
      set.add(src);
      o += 16 + inclLen;
    }
    return set;
  };

  // The unfiltered capture holds every port's BPDUs: all six MACs.
  const all = srcSet(mstp.pcap());
  assert.equal(all.size, 6, "capture is global across all ports");

  // a1 is on the a-b link: only a1's and b1's MACs, both directions.
  const onAB = srcSet(mstp.pcap(g.a1));
  assert.equal(onAB.size, 2, "one link carries exactly two MACs");
  for (const s of onAB) assert.ok(all.has(s), "link MACs are a subset");

  // a2 is on the a-c link: a disjoint pair of MACs.
  const onAC = srcSet(mstp.pcap(g.a2));
  assert.equal(onAC.size, 2);
  for (const s of onAC) assert.ok(!onAB.has(s), "the two links do not overlap");

  // A raw handle filters the same as a Port object.
  assert.deepEqual(srcSet(mstp.pcap(g.a1.handle)), onAB);

  // An unknown port yields an empty (header-only) capture.
  assert.equal(mstp.pcap(9999).length, 24, "unknown port matches nothing");
});
