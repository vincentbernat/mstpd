// SPDX-License-Identifier: GPL-2.0-or-later
//
// JavaScript wrapper around the MSTPD WebAssembly core.
//
// This is not a standalone module: the build concatenates it onto the end of
// the Emscripten output via --extern-post-js, so `createMSTPD` (the factory
// Emscripten emits) is already in scope. The resulting single file is
// dist/mstpd.mjs, exporting createMSTPD (default) plus the API below.

// Mirror of port_role_t / BR_STATE_xxx for the scalar getters.
export const Role = [
  "Disabled",
  "Root",
  "Designated",
  "Alternate",
  "Backup",
  "Master",
];
export const State = [
  "disabled",
  "listening",
  "learning",
  "forwarding",
  "blocking",
];

export async function loadMSTPD(moduleOverrides = {}) {
  const Module = await createMSTPD(moduleOverrides);
  return new MSTPD(Module);
}

// Read a C string returned by a *_json() call, then free the heap buffer.
function takeString(m, ptr) {
  if (!ptr) return null;
  const s = m.UTF8ToString(ptr);
  m._free(ptr);
  return s;
}

// Accept either a raw 0..15 multiplier or a full 0..61440 priority value.
function priorityNibble(priority) {
  if (priority === undefined || priority === null) return 8; // default
  return priority > 15 ? Math.floor(priority / 4096) : priority;
}

// The multicast destination a bridge sends STP/RSTP/MSTP BPDUs to.
const BPDU_DST = [0x01, 0x80, 0xc2, 0x00, 0x00, 0x00];

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Wrap a BPDU in the Ethernet 802.3 + LLC header a bridge puts on the wire:
// the multicast destination, the port's source MAC, an 802.3 length field,
// then the LLC header 42 42 03, then the BPDU itself.
function ethFrame(srcHex, bpdu) {
  const src = hexToBytes(srcHex);
  const llc = [0x42, 0x42, 0x03];
  const payloadLen = llc.length + bpdu.length;
  const frame = new Uint8Array(14 + llc.length + bpdu.length);
  frame.set(BPDU_DST, 0);
  frame.set(src, 6);
  frame[12] = (payloadLen >> 8) & 0xff;
  frame[13] = payloadLen & 0xff;
  frame.set(llc, 14);
  frame.set(bpdu, 14 + llc.length);
  return frame;
}

// Serialize captured BPDUs into a classic pcap file (LINKTYPE_ETHERNET) as a
// Uint8Array. Timestamps come from the simulation clock: whole seconds in t,
// with the within-second order kept in subsec (used as microseconds).
function buildPcap(frames) {
  const packets = frames.map((f) => ({
    sec: f.t,
    usec: Math.min(f.subsec, 999999),
    bytes: ethFrame(f.src, hexToBytes(f.data)),
  }));
  let total = 24;
  for (const p of packets) total += 16 + p.bytes.length;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  let o = 0;
  // Global header, little-endian.
  view.setUint32(o, 0xa1b2c3d4, true); // magic
  view.setUint16(o + 4, 2, true); // version major
  view.setUint16(o + 6, 4, true); // version minor
  view.setInt32(o + 8, 0, true); // thiszone
  view.setUint32(o + 12, 0, true); // sigfigs
  view.setUint32(o + 16, 65535, true); // snaplen
  view.setUint32(o + 20, 1, true); // network = LINKTYPE_ETHERNET
  o += 24;
  for (const p of packets) {
    view.setUint32(o, p.sec, true);
    view.setUint32(o + 4, p.usec, true);
    view.setUint32(o + 8, p.bytes.length, true); // captured length
    view.setUint32(o + 12, p.bytes.length, true); // original length
    o += 16;
    buf.set(p.bytes, o);
    o += p.bytes.length;
  }
  return buf;
}

class MSTPD {
  #onEvent = null;
  #traceEnable;
  #traceJSON;
  #captureEnable;
  #captureJSON;

  constructor(Module) {
    this.m = Module;
    const c = (name, ret, args) => Module.cwrap(name, ret, args);
    this.#traceEnable = c("mstpw_trace_enable", null, ["number"]);
    this.#traceJSON = c("mstpw_trace_json", "number", []);
    this.#captureEnable = c("mstpw_capture_enable", null, ["number"]);
    this.#captureJSON = c("mstpw_capture_json", "number", ["number"]);
    this._ = {
      setLogLevel: c("mstpw_set_log_level", null, ["number"]),
      bridgeCreate: c("mstpw_bridge_create", "number", ["string", "string"]),
      bridgeEnable: c("mstpw_bridge_set_enable", "number", [
        "number",
        "number",
      ]),
      bridgeDelete: c("mstpw_bridge_delete", "number", ["number"]),
      portCreate: c("mstpw_port_create", "number", [
        "number",
        "string",
        "string",
        "number",
        "number",
        "number",
      ]),
      portEnable: c("mstpw_port_set_enable", "number", [
        "number",
        "number",
        "number",
        "number",
      ]),
      portDelete: c("mstpw_port_delete", "number", ["number"]),
      link: c("mstpw_link", "number", ["number", "number"]),
      linkOneWay: c("mstpw_link_oneway", "number", ["number", "number"]),
      unlink: c("mstpw_unlink", "number", ["number"]),
      oneSecond: c("mstpw_one_second", null, []),
      deliverBPDUs: c("mstpw_deliver_bpdus", "number", ["number"]),
      queuedJSON: c("mstpw_queued_json", "number", ["number"]),
      step: c("mstpw_step", null, ["number"]),
      setForceProtocolVersion: c("mstpw_set_force_protocol_version", "number", [
        "number",
        "number",
      ]),
      setBridgeTimes: c("mstpw_set_bridge_times", "number", [
        "number",
        "number",
        "number",
        "number",
        "number",
        "number",
      ]),
      setMstConfigId: c("mstpw_set_mst_config_id", "number", [
        "number",
        "number",
        "string",
      ]),
      createMsti: c("mstpw_create_msti", "number", ["number", "number"]),
      deleteMsti: c("mstpw_delete_msti", "number", ["number", "number"]),
      setVid2Fid: c("mstpw_set_vid2fid", "number", [
        "number",
        "number",
        "number",
      ]),
      setFid2Mstid: c("mstpw_set_fid2mstid", "number", [
        "number",
        "number",
        "number",
      ]),
      setBridgePriority: c("mstpw_set_bridge_priority", "number", [
        "number",
        "number",
        "number",
      ]),
      setPortPathCost: c("mstpw_set_port_path_cost", "number", [
        "number",
        "number",
        "number",
      ]),
      setPortAdminEdge: c("mstpw_set_port_admin_edge", "number", [
        "number",
        "number",
      ]),
      setPortAutoEdge: c("mstpw_set_port_auto_edge", "number", [
        "number",
        "number",
      ]),
      setPortAdminP2P: c("mstpw_set_port_admin_p2p", "number", [
        "number",
        "number",
      ]),
      setPortBpduGuard: c("mstpw_set_port_bpdu_guard", "number", [
        "number",
        "number",
      ]),
      setPortRestrictedRole: c("mstpw_set_port_restricted_role", "number", [
        "number",
        "number",
      ]),
      setPortRestrictedTcn: c("mstpw_set_port_restricted_tcn", "number", [
        "number",
        "number",
      ]),
      setPortNetwork: c("mstpw_set_port_network", "number", [
        "number",
        "number",
      ]),
      portRole: c("mstpw_port_role", "number", ["number", "number"]),
      portState: c("mstpw_port_state", "number", ["number", "number"]),
      bridgeJSON: c("mstpw_bridge_json", "number", ["number"]),
      portJSON: c("mstpw_port_json", "number", ["number"]),
      topologyJSON: c("mstpw_topology_json", "number", []),
    };
    this.m.ccall("mstpw_init");
  }

  setLogLevel(level) {
    this._.setLogLevel(level);
  }

  createBridge(name, opts = {}) {
    const h = this._.bridgeCreate(name, opts.mac || "");
    if (h < 0) throw new Error(`createBridge(${name}) failed`);
    const br = new Bridge(this, h, name);
    if (opts.protocol !== undefined) br.setProtocolVersion(opts.protocol);
    if (opts.priority !== undefined) br.setPriority(opts.priority);
    if (opts.configId)
      br.setMstConfigId(opts.configId.revision || 0, opts.configId.name || "");
    return br;
  }

  // Connect two ports. Returns a Link that can be broken/restored to simulate
  // the cable being unplugged/replugged.
  link(a, b) {
    const portA = a instanceof Port ? a : null;
    const portB = b instanceof Port ? b : null;
    const pa = portA ? portA.handle : a;
    const pb = portB ? portB.handle : b;
    if (this._.link(pa, pb) < 0) throw new Error("link failed");
    return new Link(this, pa, pb, portA, portB);
  }

  // A unidirectional link: BPDUs flow from -> to only, modelling a one-way
  // fibre failure. The receiver never hears the transmitter.
  linkOneWay(from, to) {
    const fromH = from instanceof Port ? from.handle : from;
    const toH = to instanceof Port ? to.handle : to;
    if (this._.linkOneWay(fromH, toH) < 0) throw new Error("linkOneWay failed");
  }

  // Register a callback fired for each state-machine event (proposal/agreement
  // BPDUs and port state changes) as step() or deliverBPDUs() runs. Pass null
  // to stop. Events look like { t, port, port_name, bridge, event }.
  onEvent(cb) {
    this.#onEvent = cb || null;
    this.#traceEnable(this.#onEvent ? 1 : 0);
  }

  #drainEvents() {
    if (!this.#onEvent) return;
    const events = JSON.parse(takeString(this.m, this.#traceJSON()));
    for (const e of events) this.#onEvent(e);
  }

  // Start (or stop) recording every transmitted BPDU into a ring buffer that
  // keeps the most recent ~8000 frames. Call pcap() to read them back at any
  // time. Turning capture on clears anything recorded so far.
  capture(on = true) {
    this.#captureEnable(on ? 1 : 0);
  }

  // Return the captured BPDUs as a classic pcap file (a Uint8Array). The ring
  // is left intact, so this can be called repeatedly as the capture grows. Pass
  // a Port (or its handle) to keep only that BPDUs sent or received on this
  // port.
  pcap(port) {
    const handle = port instanceof Port ? port.handle : (port ?? -1);
    const frames = JSON.parse(takeString(this.m, this.#captureJSON(handle)));
    return buildPcap(frames);
  }

  // Browser helper: save the capture as a .pcap download. Pass a Port (or its
  // handle) to restrict it to that port's link, as pcap() does.
  downloadPcap(port, filename = "bpdus.pcap") {
    const blob = new Blob([this.pcap(port)], {
      type: "application/vnd.tcpdump.pcap",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Advance one second's timers, transmitting BPDUs but not delivering them.
  oneSecond() {
    this._.oneSecond();
    this.#drainEvents();
  }

  // Deliver the frames queued right now. Returns the count delivered so the
  // caller can loop until it hits 0. Events fired while these are delivered
  // when calling this function a second time. Pass all=true to instead drain
  // the whole cascade at once.
  deliverBPDUs(all = false) {
    const n = this._.deliverBPDUs(all ? 1 : 0);
    this.#drainEvents();
    return n;
  }

  // The BPDUs on the wire: what the next deliverBPDUs() will hand over. Each is
  // {seq, src, dst, proposal, agreement, tc}, with src and dst port handles.
  // seq only ever grows, so pass the highest one already seen to get just the
  // frames sent since.
  queuedBPDUs(since = 0) {
    return JSON.parse(takeString(this.m, this._.queuedJSON(since)));
  }

  step(seconds = 1) {
    this._.step(seconds);
    this.#drainEvents();
  }

  topology() {
    return JSON.parse(takeString(this.m, this._.topologyJSON()));
  }
}

class Bridge {
  constructor(mstp, handle, name) {
    this.mstp = mstp;
    this.handle = handle;
    this.name = name;
  }

  enable(up = true) {
    this.mstp._.bridgeEnable(this.handle, up ? 1 : 0);
    return this;
  }
  delete() {
    return this.mstp._.bridgeDelete(this.handle);
  }

  addPort(name, opts = {}) {
    const portno = opts.portno;
    if (!portno) throw new Error("addPort requires opts.portno");
    const h = this.mstp._.portCreate(
      this.handle,
      name,
      opts.mac || "",
      portno,
      opts.speed || 1000,
      opts.duplex === undefined ? 1 : opts.duplex ? 1 : 0,
    );
    if (h < 0) throw new Error(`addPort(${name}) failed`);
    const port = new Port(this.mstp, this, h, name);
    port.speed = opts.speed || 1000;
    port.duplex = opts.duplex === undefined ? 1 : opts.duplex ? 1 : 0;
    if (opts.cost !== undefined) port.setPathCost(opts.cost);
    if (opts.edge) port.setAdminEdge(true);
    if (opts.autoEdge !== undefined) port.setAutoEdge(opts.autoEdge);
    if (opts.p2p !== undefined) port.setP2P(opts.p2p);
    if (opts.bpduGuard !== undefined) port.setBpduGuard(opts.bpduGuard);
    if (opts.restrictedRole !== undefined)
      port.setRestrictedRole(opts.restrictedRole);
    if (opts.restrictedTcn !== undefined)
      port.setRestrictedTcn(opts.restrictedTcn);
    if (opts.network !== undefined) port.setNetwork(opts.network);
    return port;
  }

  // priority: 0..15 multiplier or 0..61440 value; mstid 0 == CIST.
  setPriority(priority, mstid = 0) {
    return this.mstp._.setBridgePriority(
      this.handle,
      mstid,
      priorityNibble(priority),
    );
  }

  // version: 'stp' | 'rstp' | 'mstp' (or the numeric 0 | 2 | 3).
  setProtocolVersion(version) {
    const map = { stp: 0, rstp: 2, mstp: 3 };
    const v =
      typeof version === "string" ? map[version.toLowerCase()] : version;
    return this.mstp._.setForceProtocolVersion(this.handle, v);
  }

  // Set CIST timers; omitted/zero fields are left unchanged. Returns <0 if the
  // combination is invalid (the standard's interdependencies are checked).
  setTimes({
    maxAge = 0,
    forwardDelay = 0,
    helloTime = 0,
    maxHops = 0,
    txHoldCount = 0,
  } = {}) {
    return this.mstp._.setBridgeTimes(
      this.handle,
      maxAge,
      forwardDelay,
      helloTime,
      maxHops,
      txHoldCount,
    );
  }

  setMstConfigId(revision, name) {
    return this.mstp._.setMstConfigId(this.handle, revision, name);
  }
  createMsti(mstid) {
    return this.mstp._.createMsti(this.handle, mstid);
  }
  deleteMsti(mstid) {
    return this.mstp._.deleteMsti(this.handle, mstid);
  }
  setVid2Fid(vid, fid) {
    return this.mstp._.setVid2Fid(this.handle, vid, fid);
  }
  setFid2Mstid(fid, mstid) {
    return this.mstp._.setFid2Mstid(this.handle, fid, mstid);
  }

  status() {
    return JSON.parse(
      takeString(this.mstp.m, this.mstp._.bridgeJSON(this.handle)),
    );
  }
}

class Port {
  constructor(mstp, bridge, handle, name) {
    this.mstp = mstp;
    this.bridge = bridge;
    this.handle = handle;
    this.name = name;
    this.speed = 1000;
    this.duplex = 1;
  }

  // Remembers speed/duplex so a later enable(true) restores the same link.
  enable(up = true, speed, duplex) {
    if (speed !== undefined) this.speed = speed;
    if (duplex !== undefined) this.duplex = duplex ? 1 : 0;
    this.mstp._.portEnable(this.handle, up ? 1 : 0, this.speed, this.duplex);
    return this;
  }
  delete() {
    return this.mstp._.portDelete(this.handle);
  }
  link(other) {
    return this.mstp.link(this, other);
  }
  unlink() {
    return this.mstp._.unlink(this.handle);
  }

  setPathCost(cost, mstid = 0) {
    return this.mstp._.setPortPathCost(this.handle, mstid, cost);
  }
  setAdminEdge(edge = true) {
    return this.mstp._.setPortAdminEdge(this.handle, edge ? 1 : 0);
  }
  setAutoEdge(auto = true) {
    return this.mstp._.setPortAutoEdge(this.handle, auto ? 1 : 0);
  }
  setBpduGuard(guard = true) {
    return this.mstp._.setPortBpduGuard(this.handle, guard ? 1 : 0);
  }
  setRestrictedRole(restricted = true) {
    return this.mstp._.setPortRestrictedRole(this.handle, restricted ? 1 : 0);
  }
  setRestrictedTcn(restricted = true) {
    return this.mstp._.setPortRestrictedTcn(this.handle, restricted ? 1 : 0);
  }
  setNetwork(network = true) {
    return this.mstp._.setPortNetwork(this.handle, network ? 1 : 0);
  }
  // mode: "auto" | true | false (or numeric 0 | 1 | 2 = auto | force-on | force-off).
  setP2P(mode = "auto") {
    const map = { auto: 0, true: 1, false: 2 };
    let v;
    if (typeof mode === "number") v = mode;
    else if (typeof mode === "boolean") v = mode ? 1 : 2;
    else v = map[mode];
    return this.mstp._.setPortAdminP2P(this.handle, v);
  }

  role(mstid = 0) {
    return Role[this.mstp._.portRole(this.handle, mstid)] ?? "Unknown";
  }
  state(mstid = 0) {
    return State[this.mstp._.portState(this.handle, mstid)] ?? "unknown";
  }

  status() {
    return JSON.parse(
      takeString(this.mstp.m, this.mstp._.portJSON(this.handle)),
    );
  }
}

// A virtual cable between two ports. Breaking it drops carrier on both ends
// (the ports go down) while keeping the wiring, so it can be restored later.
class Link {
  constructor(mstp, ha, hb, portA = null, portB = null) {
    this.mstp = mstp;
    this.ha = ha;
    this.hb = hb;
    this.portA = portA;
    this.portB = portB;
    this.broken = false;
  }

  _setUp(up) {
    for (const [h, p] of [
      [this.ha, this.portA],
      [this.hb, this.portB],
    ]) {
      if (p) p.enable(up);
      else this.mstp._.portEnable(h, up ? 1 : 0, 1000, 1);
    }
    this.broken = !up;
    return this;
  }

  break() {
    return this._setUp(false);
  }
  restore() {
    return this._setUp(true);
  }
  toggle() {
    return this._setUp(this.broken);
  }
}

export { MSTPD, Bridge, Port, Link };

// Convenience for non-module browser code.
if (typeof window !== "undefined") {
  window.mstpd = {
    loadMSTPD,
    MSTPD,
    Bridge,
    Port,
    Link,
    Role,
    State,
    createMSTPD,
  };
}
