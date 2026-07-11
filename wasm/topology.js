// SPDX-License-Identifier: GPL-2.0-or-later
//
// Turn a <pre> block describing a topology into an interactive spanning-tree
// simulation, powered by the mstpd WebAssembly core. Write your topologies
// inside <pre class="mstp-topology"> blocks, and they are replaced in place by
// a live, clickable diagram.
//
//   <link rel="stylesheet" href="topology.css" />
//   <script type="module" src="dist/mstpd.mjs"></script>
//   <script type="module" src="topology.js"></script>
//
// Grammar (one statement per line; # or // starts a comment):
//
//   NAME @X,Y [prio=N] [proto=stp|rstp|mstp] [icon=C]  # a bridge at grid cell X,Y
//   A -- B [cost=N] [down] [A:flag ...]                # a link between two bridges
//   A -> B [cost=N] [A:flag ...]                       # a one-way link (A transmits, B receives)
//   # global options
//   :protocol rstp|stp|mstp
//   :forward-delay N
//   :hello N
//   :max-age N
//   :max-hops N
//   :tx-hold N
//
// Endpoint flags: edge, network, bpdu-guard, root-guard, no-p2p
//
// The mstpd core is loaded via its own <script> tag (above), which publishes
// window.mstpd; this module picks loadMstpd off it rather than importing. We
// could instead import it:
//
// import { loadMstpd } from "./dist/mstpd.mjs";

const loadMstpd = window.mstpd.loadMstpd;
const SVGNS = "http://www.w3.org/2000/svg";
const UNIT = 110; // grid cell -> px
const R = 24; // node radius in px
const PAD = R + 24; // viewBox margin around the nodes
const PARALLEL_GAP = 16; // px between parallel links joining the same pair
const SLOW_FACTOR = 3; // how much the snail stretches each simulated second

// Port/link state -> colour
const STATE_COLOR = {
  forwarding: "#2a7",
  learning: "#d90",
  listening: "#d90",
  blocking: "#e55",
  discarding: "#e55",
  disabled: "#999",
};
const colorFor = (s) => STATE_COLOR[s] || "#888";

// BPDU type -> colour, for the pills that animate along the links while
// running. A transmitted BPDU is sorted into exactly one of the base buckets.
// tc is not a base type but the ring drawn around any pill whose frame also
// carries a topology change (the TC flag, or a legacy TCN BPDU).
const BPDU_COLOR = {
  hello: "#3b82f6", // a plain periodic BPDU
  proposal: "#f59e0b", // RST BPDU carrying the proposal flag
  agreement: "#22c55e", // RST BPDU carrying the agreement flag
  tc: "#ef4444", // ring: the frame also carries a topology change
};

// -- grammar --------------------------------------------------------

function parseOpts(s) {
  const o = {};
  for (const tok of (s || "").trim().split(/\s+/)) {
    if (!tok) continue;
    const eq = tok.indexOf("=");
    if (eq >= 0) o[tok.slice(0, eq).toLowerCase()] = tok.slice(eq + 1);
    else o[tok.toLowerCase()] = true;
  }
  return o;
}

// Endpoint flag -> the addPort() options it sets. A network port is switch
// facing, so auto-edge has no business turning it into an edge.
const PORT_FLAGS = {
  edge: { edge: true },
  network: { network: true, autoEdge: false },
  "bpdu-guard": { bpduGuard: true },
  "root-guard": { restrictedRole: true },
  "no-p2p": { p2p: false },
};

function parseTopology(text) {
  const nodes = [];
  const links = [];
  const errors = [];
  const directives = { protocol: "rstp" };
  const seen = new Set();

  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw
      .replace(/#.*$/, "")
      .replace(/\/\/.*$/, "")
      .trim();
    if (!line) return;
    const ln = i + 1;

    // Global options
    if (line[0] === ":") {
      const [key, ...rest] = line.slice(1).split(/\s+/);
      const val = rest.join(" ");
      switch (key.toLowerCase()) {
        case "protocol":
          directives.protocol = val.toLowerCase();
          break;
        case "hello":
          directives.helloTime = +val;
          break;
        case "forward-delay":
          directives.forwardDelay = +val;
          break;
        case "max-age":
          directives.maxAge = +val;
          break;
        case "max-hops":
          directives.maxHops = +val;
          break;
        case "tx-hold":
          directives.txHoldCount = +val;
          break;
        default:
          errors.push(`line ${ln}: unknown directive :${key}`);
      }
      return;
    }

    // Links
    let m;
    if ((m = line.match(/^(\S+)\s*(--|->)\s*(\S+)\s*(.*)$/))) {
      const [a, op, b] = [m[1], m[2], m[3]];
      const link = {
        a,
        b,
        oneway: op === "->",
        cost: undefined,
        down: false,
        aOpts: {},
        bOpts: {},
        line: ln,
      };
      for (const tok of m[4].trim().split(/\s+/)) {
        if (!tok) continue;
        const eq = tok.indexOf("=");
        const key = (eq >= 0 ? tok.slice(0, eq) : tok).toLowerCase();
        const val = eq >= 0 ? tok.slice(eq + 1) : true;
        const colon = key.indexOf(":");
        if (colon >= 0) {
          const who = key.slice(0, colon);
          const flag = key.slice(colon + 1);
          const target =
            who === a.toLowerCase()
              ? link.aOpts
              : who === b.toLowerCase()
                ? link.bOpts
                : null;
          if (!target) errors.push(`line ${ln}: ${who} is not an endpoint`);
          else if (!PORT_FLAGS[flag])
            errors.push(`line ${ln}: unknown port flag ${flag}`);
          else Object.assign(target, PORT_FLAGS[flag]);
        } else if (key === "cost") {
          link.cost = +val;
        } else if (key === "down") {
          link.down = true;
        } else {
          errors.push(`line ${ln}: unknown link option ${key}`);
        }
      }
      links.push(link);
      return;
    }

    // Nodes
    if ((m = line.match(/^(\S+)\s+@\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*(.*)$/))) {
      const name = m[1];
      if (seen.has(name)) {
        errors.push(`line ${ln}: duplicate node ${name}`);
        return;
      }
      seen.add(name);
      const opts = parseOpts(m[4]);
      nodes.push({
        name,
        x: +m[2],
        y: +m[3],
        prio: opts.prio != null ? +opts.prio : undefined,
        proto:
          typeof opts.proto === "string" ? opts.proto.toLowerCase() : undefined,
        icon: typeof opts.icon === "string" ? opts.icon : undefined,
        line: ln,
      });
      return;
    }

    errors.push(`line ${ln}: cannot parse "${line}"`);
  });

  for (const l of links) {
    if (!seen.has(l.a)) errors.push(`line ${l.line}: unknown node ${l.a}`);
    if (!seen.has(l.b)) errors.push(`line ${l.line}: unknown node ${l.b}`);
  }

  return {
    directives,
    nodes,
    links: links.filter((l) => seen.has(l.a) && seen.has(l.b)),
    errors,
  };
}

// -- DOM helpers ----------------------------------------------------

function svgEl(name, attrs = {}, parent) {
  const e = document.createElementNS(SVGNS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function h(tag, opts = {}, ...kids) {
  const e = document.createElement(tag);
  if (opts.class) e.className = opts.class;
  if (opts.text != null) e.textContent = opts.text;
  if (opts.html != null) e.innerHTML = opts.html;
  if (opts.title) e.title = opts.title;
  if (opts.onclick) e.onclick = opts.onclick;
  for (const k of kids) if (k) e.appendChild(k);
  return e;
}

const timersOf = (d) => ({
  helloTime: d.helloTime,
  forwardDelay: d.forwardDelay,
  maxAge: d.maxAge,
  maxHops: d.maxHops,
  txHoldCount: d.txHoldCount,
});

// Widgets render inside a shadow root to ensure host page's CSS does not impact
// it.
let widgetSheet;
function widgetStyleSheet() {
  if (widgetSheet) return widgetSheet;
  widgetSheet = new CSSStyleSheet();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      continue; // cross-origin sheet we're not allowed to read
    }
    if (rules.some((r) => r.cssText.includes(".mstp-topo"))) {
      widgetSheet.replaceSync(rules.map((r) => r.cssText).join("\n"));
      break;
    }
  }
  return widgetSheet;
}

// -- single widget --------------------------------------------------

async function mount(el) {
  if (el.dataset.mstpMounted) return;
  el.dataset.mstpMounted = "1";

  // A <div> wrapper holds its definition in a nested <pre><code> block.
  const code = el.querySelector(":scope > pre > code");
  const source = (code || el).textContent;
  const model = parseTopology(source);

  const root = h("div", { class: "mstp-topo" });
  const bar = h("div", { class: "mstp-bar" });
  const runBtn = h("button", {
    class: "mstp-btn mstp-toggle",
    html: "<span>Start</span><span>Stop</span>",
  });
  const resetBtn = h("button", { class: "mstp-btn", text: "Reset" });
  const editBtn = h("button", { class: "mstp-btn", text: "Edit" });
  const saveBtn = h("button", { class: "mstp-btn mstp-accent", text: "Save" });
  const discardBtn = h("button", { class: "mstp-btn", text: "Discard" });
  runBtn.disabled = resetBtn.disabled = true;
  saveBtn.hidden = discardBtn.hidden = true;
  const clockTime = h("span", { class: "mstp-clock-t", text: "t=0s" });
  const clockBpdu = h("span", { class: "mstp-clock-b", text: "0 BPDUs" });
  const clock = h("span", { class: "mstp-clock" }, clockTime, clockBpdu);
  const slowBox = document.createElement("input");
  slowBox.type = "checkbox";
  const slow = h(
    "label",
    {
      class: "mstp-slow",
      title: "Slow motion — stretch each second so BPDUs are easier to follow",
    },
    slowBox,
    h("span", { text: "🐌" }),
  );
  bar.append(runBtn, resetBtn, editBtn, saveBtn, discardBtn, clock, slow);

  const stage = h("div", { class: "mstp-stage" });
  const svg = svgEl("svg", { preserveAspectRatio: "xMidYMid meet" });
  const canvas = h("div", { class: "mstp-canvas" }, svg);
  const panel = h("div", { class: "mstp-panel" });
  const panelBody = h("div", { class: "mstp-panel-body" });
  panel.appendChild(panelBody);
  stage.append(canvas, panel);

  const legend = h("div", { class: "mstp-legend" });

  // The editor replaces the stage and legend while editing the definition.
  const textarea = h("textarea", { class: "mstp-edit-area" });
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "Topology definition");
  const editor = h("div", { class: "mstp-editor" }, textarea);
  editor.hidden = true;

  const errBox = h("div", { class: "mstp-errors" });
  errBox.hidden = true;

  root.append(bar, stage, legend, editor, errBox);

  const host = h("div", { class: "mstp-host" });
  const shadow = host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [widgetStyleSheet()];
  shadow.append(root);
  el.replaceWith(host);

  const w = {
    model,
    source,
    svg,
    panel: panelBody,
    stage,
    legend,
    editor,
    textarea,
    errBox,
    runBtn,
    resetBtn,
    editBtn,
    saveBtn,
    discardBtn,
    clockTime,
    clockBpdu,
    slow,
    speed: 1, // real seconds per simulated second (snail bumps it to SLOW_FACTOR)
    mstp: null,
    nodes: [],
    links: [],
    selected: null,
    editing: false,
    time: 0,
    frameBase: 0,
    raf: null, // animation-loop handle
    clock: 0, // clock in ms (see animate)
    last: 0, // timestamp of the previous frame
    nextAt: 0, // clock time of the next step
    lastClick: { link: null, t: 0 }, // manual double-click detection
    eventBuf: [], // proposal/agreement events from the last step
    flights: [], // pills flying along the links
  };

  applyViewBox(w);
  buildLegend(w);
  showErrors(w);

  svg.addEventListener("pointerdown", (ev) => {
    if (w.mstp && ev.target === svg) select(w, null);
  });
  runBtn.onclick = () => setRunning(w, !w.raf);
  resetBtn.onclick = () => {
    setRunning(w, false);
    build(w);
    select(w, null);
  };
  editBtn.onclick = () => enterEdit(w);
  saveBtn.onclick = () => saveEdit(w);
  discardBtn.onclick = () => exitEdit(w);
  slowBox.onchange = () => {
    w.speed = slowBox.checked ? SLOW_FACTOR : 1;
  };

  try {
    w.mstp = await loadMstpd({
      print: () => {},
      printErr: () => {},
    });
    w.mstp.onEvent((e) => w.eventBuf.push(e));
    build(w);
    select(w, null);
    w.runBtn.disabled = w.resetBtn.disabled = false;
  } catch (e) {
    panelBody.textContent = "Failed to load simulation: " + e;
    console.error(e);
    build(w);
  }
  return w;
}

// -- layout ---------------------------------------------------------

// Fit the viewBox to the static node coordinates and lock the SVG aspect ratio.
function applyViewBox(w) {
  const xs = w.model.nodes.map((n) => n.x * UNIT);
  const ys = w.model.nodes.map((n) => n.y * UNIT);
  const minX = Math.min(0, ...xs) - PAD;
  const minY = Math.min(0, ...ys) - PAD;
  const vbW = Math.max(...xs, 0) - Math.min(...xs, 0) + 2 * PAD || 2 * PAD;
  const vbH = Math.max(...ys, 0) - Math.min(...ys, 0) + 2 * PAD || 2 * PAD;
  w.svg.setAttribute("viewBox", `${minX} ${minY} ${vbW} ${vbH}`);
  w.svg.style.aspectRatio = `${vbW} / ${vbH}`;
}

function buildLegend(w) {
  w.legend.replaceChildren();
  const protos = new Set(
    w.model.nodes.map((n) => n.proto || w.model.directives.protocol),
  );
  if (!protos.size) protos.add(w.model.directives.protocol);
  const hasStp = protos.has("stp");
  const hasRapid = protos.has("rstp") || protos.has("mstp");

  const entries = [["forwarding", colorFor("forwarding")]];
  if (hasStp) entries.push(["learning", colorFor("learning")]);
  entries.push([
    hasStp && hasRapid
      ? "blocking/discarding"
      : hasStp
        ? "blocking"
        : "discarding",
    colorFor("blocking"),
  ]);
  entries.push(["disabled", colorFor("disabled")]);

  for (const [label, color] of entries) {
    const sw = h("i");
    sw.style.background = color;
    w.legend.appendChild(h("span", {}, sw, document.createTextNode(label)));
  }
}

function showErrors(w) {
  w.errBox.replaceChildren();
  if (!w.model.errors.length) {
    w.errBox.hidden = true;
    return;
  }
  w.errBox.hidden = false;
  w.errBox.append(
    h("strong", { text: "Topology errors:" }),
    ...w.model.errors.map((e) => h("div", { text: e })),
  );
}

// -- editing --------------------------------------------------------

function enterEdit(w) {
  setRunning(w, false);
  w.textarea.value = w.source;
  w.editing = true;
  w.stage.hidden = w.legend.hidden = true;
  w.editor.hidden = false;
  w.runBtn.hidden = w.resetBtn.hidden = w.editBtn.hidden = w.slow.hidden = true;
  w.saveBtn.hidden = w.discardBtn.hidden = false;
  w.textarea.focus();
}

function leaveEdit(w) {
  w.editing = false;
  w.editor.hidden = true;
  w.stage.hidden = w.legend.hidden = false;
  w.runBtn.hidden =
    w.resetBtn.hidden =
    w.editBtn.hidden =
    w.slow.hidden =
      false;
  w.saveBtn.hidden = w.discardBtn.hidden = true;
}

// Discard: drop the edits and return to the running diagram unchanged.
function exitEdit(w) {
  leaveEdit(w);
}

// Save: adopt the edited definition, re-lay the diagram, and rebuild the core.
function saveEdit(w) {
  w.source = w.textarea.value;
  w.model = parseTopology(w.source);
  applyViewBox(w);
  buildLegend(w);
  showErrors(w);
  leaveEdit(w);
  build(w);
  if (w.mstp) select(w, null);
}

function build(w) {
  const { mstp, model } = w;
  for (const n of w.nodes) n.bridge?.delete();
  w.nodes = [];
  w.links = [];
  w.time = 0;
  w.selected = null;
  w.flights = [];
  w.svg.querySelector(".mstp-pills")?.remove();

  const byName = new Map();
  const timers = timersOf(model.directives);
  for (const md of model.nodes) {
    const protocol = md.proto || model.directives.protocol;
    let bridge = null;
    if (mstp) {
      bridge = mstp.createBridge(md.name, {
        priority: md.prio,
        protocol,
        configId: protocol === "mstp" ? { revision: 1, name: "r1" } : undefined,
      });
      bridge.setTimes(timers);
      bridge.enable();
    }
    const node = {
      name: md.name,
      x: md.x * UNIT,
      y: md.y * UNIT,
      prio: md.prio,
      protocol,
      icon: md.icon,
      bridge,
      ports: [],
      nextPort: 1,
    };
    w.nodes.push(node);
    byName.set(md.name, node);
  }

  for (const ld of model.links) {
    const a = byName.get(ld.a);
    const b = byName.get(ld.b);
    let pa = null;
    let pb = null;
    let link;
    if (mstp) {
      pa = a.bridge.addPort(`${a.name}.${a.nextPort}`, {
        portno: a.nextPort++,
        cost: ld.cost,
        ...ld.aOpts,
      });
      pb = b.bridge.addPort(`${b.name}.${b.nextPort}`, {
        portno: b.nextPort++,
        cost: ld.cost,
        ...ld.bOpts,
      });
      pa.enable();
      pb.enable();
      if (ld.oneway) {
        // A one-way fault cannot be toggled.
        mstp.linkOneWay(pa, pb);
        link = { broken: false, toggle() {}, break() {}, restore() {} };
      } else {
        link = mstp.link(pa, pb);
        if (ld.down) link.break();
      }
      a.ports.push(pa);
      b.ports.push(pb);
    } else {
      link = { broken: ld.down, toggle() {}, break() {}, restore() {} };
    }
    w.links.push({
      a,
      b,
      aPort: pa,
      bPort: pb,
      link,
      cost: ld.cost,
      oneway: ld.oneway,
    });
  }

  w.frameBase = mstp?.topology().frames_delivered;
  render(w);
  if (mstp) renderPanel(w);
}

// -- running --------------------------------------------------------

// Only one topology on the page runs at a time.
let activeWidget = null;

// Advance one simulated second (which may contain several waves of BPDUs).
function stepTick(w) {
  if (!w.mstp) return;
  w.time += 1;

  const waves = [];
  let prev = capturePortTx(w);
  const takeWave = (gen) => {
    const events = w.eventBuf;
    w.eventBuf = [];
    const cur = capturePortTx(w);
    const tx = new Map();
    for (const [handle, ps] of cur) {
      const b = prev.get(handle) || { tx: 0, tcn: 0 };
      const n = ps.tx - b.tx;
      if (n > 0) tx.set(handle, { n, tc: Math.max(0, ps.tcn - b.tcn) });
    }
    prev = cur;
    if (tx.size) waves.push({ gen, events, tx });
  };

  w.eventBuf = [];
  w.mstp.oneSecond();
  takeWave(0);
  // Each wave delivers a generation and may trigger more packets.
  for (let gen = 1; gen < 50 && w.mstp.deliverBPDUs() > 0; gen++) takeWave(gen);

  renderClock(w);

  const finish = launchBpduFlights(w, waves);
  if (!w.flights.length) redrawState(w);
  w.nextAt = Math.max(w.clock + 1000, finish + 150);
}

// Redraw the diagram with the new port states.
function redrawState(w) {
  render(w);
  renderPanel(w);
}

// The animation loop. One requestAnimationFrame runs the whole time we play.
// Each frame it moves the clock on, does any due redraw or step, and draws the
// pills. It reads the speed each frame, so the snail also affects pills already
// flying.
function animate(w, now) {
  const dt = now - w.last;
  w.last = now;
  // Slower (by speed) while pills fly, real time when idle.
  w.clock += dt / (w.flights.length ? w.speed : 1);

  const flying = w.flights.length > 0;
  w.flights = w.flights.filter((f) => w.clock < f.start + f.dur);
  if (flying && !w.flights.length) redrawState(w); // last pill landed

  if (w.clock >= w.nextAt) stepTick(w); // start the next second

  drawPills(w);
  w.raf = requestAnimationFrame((t) => animate(w, t));
}

function setRunning(w, on) {
  if (on && !w.raf) {
    if (activeWidget && activeWidget !== w) setRunning(activeWidget, false);
    activeWidget = w;
    w.last = performance.now();
    w.nextAt = w.clock + 200;
    w.raf = requestAnimationFrame((t) => animate(w, t));
    w.runBtn.classList.add("mstp-active");
  } else if (!on && w.raf) {
    cancelAnimationFrame(w.raf);
    w.raf = null;
    if (activeWidget === w) activeWidget = null;
    w.runBtn.classList.remove("mstp-active");

    // Pausing mid-flight: drop the pills and show the settled diagram.
    w.flights = [];
    w.svg.querySelector(".mstp-pills")?.remove();
    render(w);
    renderPanel(w);
  }
}

// -- BPDU animation -------------------------------------------------
//
// Snapshot every port's transmit counters, keyed by port handle.
function capturePortTx(w) {
  const m = new Map();
  const { ports } = snapshot(w);
  for (const [handle, ps] of ports)
    m.set(handle, { tx: ps.tx_bpdu || 0, tcn: ps.tx_tcn || 0 });
  return m;
}

// The core only tells us the totals (n sent, of which nTc carried a topology
// change) plus how many proposals/agreements it emitted, so we bucket rather
// than track each frame exactly. A topology change is not a BPDU of its own:
// the TC flag is enabled on whatever frame the port is already sending, so it
// is an overlay on the base type.
function classifyBpdus(n, nProp, nAgree, nTc) {
  const pills = [];
  for (let i = 0; i < nProp && pills.length < n; i++)
    pills.push({ type: "proposal" });
  for (let i = 0; i < nAgree && pills.length < n; i++)
    pills.push({ type: "agreement" });
  while (pills.length < n) pills.push({ type: "hello" });
  for (let i = 0; i < nTc && i < pills.length; i++)
    pills[pills.length - 1 - i].tc = true;
  return pills;
}

// Count the proposals/agreements each port emitted in one wave, keyed by handle.
function tallyEvents(events) {
  const m = new Map();
  for (const e of events) {
    if (e.event !== "proposal" && e.event !== "agreement") continue;
    const g = m.get(e.port) || { prop: 0, agree: 0 };
    if (e.event === "proposal") g.prop++;
    else g.agree++;
    m.set(e.port, g);
  }
  return m;
}

const NO_EV = { prop: 0, agree: 0 };

// Turn each wave's BPDUs into pills. Times are in clock ms. Returns the clock
// time the last pill lands.
function launchBpduFlights(w, waves) {
  if (!w.mstp || !waves.length) return w.clock;
  const now = w.clock;

  // Resolve every pill first, so the per-wave spacing can match the slowest
  // flight and no reply starts before its cause.
  const pending = [];
  let hop = 0;
  let prevByPort = null; // the previous generation's tally (to spot replies)
  for (const wave of waves) {
    const evByPort = tallyEvents(wave.events);
    for (const e of w.links) {
      if (!e.geom) continue;
      const { x1, y1, x2, y2 } = e.geom;
      // Each endpoint that transmitted this wave sends its pills to its peer.
      for (const [port, peer, sx, sy, tx, ty] of [
        [e.aPort, e.bPort, x1, y1, x2, y2],
        [e.bPort, e.aPort, x2, y2, x1, y1],
      ]) {
        if (!port) continue;
        const t = wave.tx.get(port.handle);
        if (!t) continue;
        const ev = evByPort.get(port.handle) || NO_EV;
        // A real handshake agreement answers a proposal the peer sent one
        // generation earlier (it took a delivery hop to arrive). Count only
        // those as agreements, the rest are plain hellos.
        const peerPrevProp =
          (peer && prevByPort && prevByPort.get(peer.handle)?.prop) || 0;
        const nAgree = Math.min(ev.agree, peerPrevProp);
        const pills = classifyBpdus(t.n, ev.prop, nAgree, t.tc);
        const len = Math.hypot(tx - sx, ty - sy) || 1;
        const dur = Math.max(300, Math.min(900, len / 0.4));
        hop = Math.max(hop, dur);
        pending.push({ gen: wave.gen, sx, sy, tx, ty, dur, pills });
      }
    }
    prevByPort = evByPort;
  }

  let finish = w.clock;
  for (const p of pending) {
    const base = now + p.gen * hop;
    const gap = Math.min(90, hop / (p.pills.length + 1));
    p.pills.forEach((pill, i) => {
      const start = base + i * gap;
      finish = Math.max(finish, start + p.dur);
      w.flights.push({
        sx: p.sx,
        sy: p.sy,
        tx: p.tx,
        ty: p.ty,
        color: BPDU_COLOR[pill.type],
        tc: !!pill.tc,
        start,
        dur: p.dur,
      });
    });
  }
  return finish;
}

// Draw each flying pill at its spot for the current clock. The pill layer goes
// back on top each frame so render()'s redraw does not wipe it.
function drawPills(w) {
  let layer = w.svg.querySelector(".mstp-pills");
  if (!w.flights.length) {
    layer?.remove();
    return;
  }
  if (!layer)
    layer = svgEl("g", { class: "mstp-pills", "pointer-events": "none" });
  else layer.replaceChildren();
  w.svg.appendChild(layer);

  for (const f of w.flights) {
    if (w.clock < f.start) continue; // not launched yet
    const p = (w.clock - f.start) / f.dur;
    const x = f.sx + (f.tx - f.sx) * p;
    const y = f.sy + (f.ty - f.sy) * p;
    const fade = Math.min(1, p / 0.15, (1 - p) / 0.15);

    svgEl(
      "circle",
      {
        cx: x,
        cy: y,
        r: f.tc ? 5 : 4.5,
        fill: f.color,
        stroke: f.tc ? BPDU_COLOR.tc : "#fff8",
        "stroke-width": f.tc ? 2.25 : 0.75,
        opacity: fade,
      },
      layer,
    );
  }
}

// -- state ----------------------------------------------------------

function snapshot(w) {
  if (!w.mstp) return { topo: null, bridges: new Map(), ports: new Map() };
  const topo = w.mstp.topology();
  const bridges = new Map();
  const ports = new Map();
  for (const b of topo.bridges) {
    bridges.set(b.handle, b);
    for (const p of b.ports) ports.set(p.handle, p);
  }
  return { topo, bridges, ports };
}

// A down port keeps BR_STATE_BLOCKING but reports role "Disabled". Show it as
// disabled.
const effState = (ps) =>
  !ps || ps.role === "Disabled" ? "disabled" : ps.state;

// The core reports RSTP/MSTP's discarding state as the kernel's "blocking"
// (mstpd maps it onto BR_STATE_BLOCKING). Show the RSTP name when appropriate.
function stateLabel(w, state) {
  const p = w.model.directives.protocol;
  if (state === "blocking" && (p === "rstp" || p === "mstp"))
    return "discarding";
  return state;
}

// -- rendering ------------------------------------------------------

function renderClock(w, snap = snapshot(w)) {
  const bpdus = snap.topo ? snap.topo.frames_delivered - w.frameBase : 0;
  w.clockTime.textContent = `t=${w.time}s`;
  w.clockBpdu.textContent = `${bpdus} BPDUs`;
}

function render(w) {
  const snap = snapshot(w);
  const live = !!w.mstp;
  renderClock(w, snap);
  w.svg.replaceChildren();

  const defs = svgEl("defs", {}, w.svg);
  const gray = svgEl("filter", { id: "mstp-gray" }, defs);
  svgEl("feColorMatrix", { type: "saturate", values: "0" }, gray);

  const gEdges = svgEl("g", {}, w.svg);
  const gNodes = svgEl("g", {}, w.svg);

  // Parallel links between the same pair of bridges share a straight line, so
  // fan them out perpendicular to it to keep each visible and separately
  // clickable.
  const pairKey = (e) =>
    e.a.name < e.b.name
      ? `${e.a.name}\0${e.b.name}`
      : `${e.b.name}\0${e.a.name}`;
  const groups = new Map();
  for (const e of w.links) {
    const k = pairKey(e);
    (groups.get(k) || groups.set(k, []).get(k)).push(e);
  }

  for (const e of w.links) {
    const pa = snap.ports.get(e.aPort?.handle);
    const pb = snap.ports.get(e.bPort?.handle);
    const sa = effState(pa);
    const sb = effState(pb);
    const active = live && sa === "forwarding" && sb === "forwarding";
    const down = live ? sa === "disabled" || sb === "disabled" : e.link.broken;

    const dx = e.b.x - e.a.x;
    const dy = e.b.y - e.a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;

    // Perpendicular offset for this link within its parallel group. The sign
    // keys off node names so A--B and B--A land on the same side.
    const group = groups.get(pairKey(e));
    const spread = (group.indexOf(e) - (group.length - 1) / 2) * PARALLEL_GAP;
    const orient = e.a.name < e.b.name ? 1 : -1;
    const ox = -uy * spread * orient;
    const oy = ux * spread * orient;

    // A parallel link is offset perpendicular by `spread`, so it meets the
    // circle nearer its edge: back off along the link to land on the border.
    const along = Math.sqrt(Math.max(R * R - spread * spread, 0));
    const x1 = e.a.x + ux * along + ox;
    const y1 = e.a.y + uy * along + oy;
    const x2 = e.b.x - ux * along + ox;
    const y2 = e.b.y - uy * along + oy;

    e.geom = { x1, y1, x2, y2 };

    if (live) {
      // Larger hit target
      const hit = svgEl(
        "line",
        {
          x1,
          y1,
          x2,
          y2,
          stroke: "transparent",
          "stroke-width": 18,
          "pointer-events": "stroke",
        },
        gEdges,
      );
      hit.style.cursor = "pointer";
      hit.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        // Single click highlights. Double click cuts/restores.
        if (w.lastClick.link === e && ev.timeStamp - w.lastClick.t < 400) {
          w.lastClick = { link: null, t: 0 };
          e.link.toggle();
          select(w, { type: "link", ref: e });
          return;
        }
        w.lastClick = { link: e, t: ev.timeStamp };
        select(w, { type: "link", ref: e });
      });
    }

    svgEl(
      "line",
      {
        x1,
        y1,
        x2,
        y2,
        stroke: !live ? "#888" : down ? "#999" : active ? "#2a7" : "#e55",
        "stroke-width": w.selected?.ref === e ? 5 : active ? 3 : 2,
        "stroke-dasharray": !live || active || down ? "" : "7 5",
        opacity: down ? 0.5 : 1,
        "pointer-events": "none",
      },
      gEdges,
    );

    if (down) {
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const s = 7;
      const cross = {
        stroke: "#e55",
        "stroke-width": 3,
        "stroke-linecap": "round",
        "pointer-events": "none",
      };
      svgEl(
        "line",
        { x1: mx - s, y1: my - s, x2: mx + s, y2: my + s, ...cross },
        gEdges,
      );
      svgEl(
        "line",
        { x1: mx - s, y1: my + s, x2: mx + s, y2: my - s, ...cross },
        gEdges,
      );
    }

    if (e.oneway) {
      // A diode at the midpoint.
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      const s = 8; // half length along the link
      const wsym = 7; // half width of the base and the bar
      const px = -uy;
      const py = ux;
      const color = !live ? "#888" : down ? "#999" : active ? "#2a7" : "#e55";
      const ax = mx - ux * s; // base (transmitting side)
      const ay = my - uy * s;
      const cx = mx + ux * s; // tip (receiving side)
      const cy = my + uy * s;
      svgEl(
        "polygon",
        {
          points: [
            [ax + px * wsym, ay + py * wsym],
            [ax - px * wsym, ay - py * wsym],
            [cx, cy],
          ]
            .map((p) => p.join(","))
            .join(" "),
          fill: color,
          "pointer-events": "none",
        },
        gEdges,
      );
      svgEl(
        "line",
        {
          x1: cx + px * wsym,
          y1: cy + py * wsym,
          x2: cx - px * wsym,
          y2: cy - py * wsym,
          stroke: color,
          "stroke-width": 3,
          "stroke-linecap": "round",
          "pointer-events": "none",
        },
        gEdges,
      );
    }

    drawEndpoint(gEdges, e.a, e.b, pa, ox, oy);
    drawEndpoint(gEdges, e.b, e.a, pb, ox, oy);
  }

  for (const n of w.nodes) {
    const b = snap.bridges.get(n.bridge?.handle);
    const isRoot = b && b.is_root;
    const g = svgEl("g", {}, gNodes);
    if (live) g.style.cursor = "pointer";
    svgEl(
      "circle",
      {
        cx: n.x,
        cy: n.y,
        r: R,
        fill: isRoot ? "#2a73" : "#8882",
        stroke: w.selected?.ref === n ? "#06f" : isRoot ? "#2a7" : "#888",
        "stroke-width": w.selected?.ref === n ? 4 : 2,
      },
      g,
    );
    drawNodeGlyph(g, n);
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y - 1,
        "text-anchor": "middle",
        "font-weight": 600,
        "font-size": 13,
      },
      g,
    ).textContent = n.name;
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y + 12,
        "text-anchor": "middle",
        "font-size": 9,
        opacity: 0.7,
      },
      g,
    ).textContent = isRoot ? "ROOT" : b ? `${b.root_path_cost}` : "";
    if (live)
      g.addEventListener("pointerdown", (ev) => {
        ev.stopPropagation();
        select(w, { type: "node", ref: n });
      });
  }
}

// A faint background glyph sitting behind the node's labels. Either the user's
// icon character (desaturated and faded so the labels stay legible) or, by
// default, the switch symbol.
function drawNodeGlyph(parent, n) {
  if (n.icon) {
    svgEl(
      "text",
      {
        x: n.x,
        y: n.y,
        "text-anchor": "middle",
        "dominant-baseline": "central",
        "font-size": 30,
        opacity: 0.3,
        filter: "url(#mstp-gray)",
        "pointer-events": "none",
      },
      parent,
    ).textContent = n.icon;
    return;
  }
  const g = svgEl(
    "g",
    {
      stroke: "#888",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      fill: "none",
      opacity: 0.3,
      "pointer-events": "none",
    },
    parent,
  );
  const edge = 13; // half the total glyph width
  const head = 4; // arrowhead size
  // Two interleaved pairs of arrows. Each arrow spans half the width: tails
  // meet at the centre and the tips point outward, the rightward pair on the
  // right half and the leftward pair on the left half.
  [-9, -3, 3, 9].forEach((dy, i) => {
    const right = i % 2 === 0;
    const y = n.y + dy;
    const tail = n.x;
    const tip = n.x + (right ? edge : -edge);
    const dir = right ? -1 : 1;
    svgEl("line", { x1: tail, y1: y, x2: tip, y2: y }, g);
    svgEl(
      "polyline",
      {
        points: `${tip + dir * head},${y - head} ${tip},${y} ${tip + dir * head},${y + head}`,
      },
      g,
    );
  });
}

function drawEndpoint(parent, from, to, ps, ox = 0, oy = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = from.x + ux * (R + 9) + ox;
  const py = from.y + uy * (R + 9) + oy;
  const state = effState(ps);
  svgEl(
    "circle",
    { cx: px, cy: py, r: 6, fill: colorFor(state), "pointer-events": "none" },
    parent,
  );
  const role = ps ? ps.role : "";
  if (role)
    svgEl(
      "text",
      {
        x: px,
        y: py + 3,
        "text-anchor": "middle",
        "font-size": 8,
        fill: "#fff",
        "font-weight": 700,
        "pointer-events": "none",
      },
      parent,
    ).textContent = role[0];
}

// -- details panel --------------------------------------------------

function select(w, sel) {
  w.selected = sel;
  render(w);
  renderPanel(w);
}

function renderPanel(w) {
  const panel = w.panel;
  panel.replaceChildren();
  const snap = snapshot(w);

  if (!w.selected) {
    panel.appendChild(h("h3", { text: "Global timers" }));
    const b0 = snap.topo.bridges[0];
    const rows = [["protocol", w.model.directives.protocol.toUpperCase()]];
    if (b0)
      rows.push(
        ["hello time", `${b0.hello_time} s`],
        ["forward delay", `${b0.forward_delay} s`],
        ["max age", `${b0.max_age} s`],
        ["max hops", b0.max_hops],
        ["tx hold count", b0.tx_hold_count],
      );
    panel.appendChild(kvTable(rows));
    panel.appendChild(
      h("p", {
        class: "mstp-hint",
        text: "Click a bridge or link for details. Double-click a link to cut or restore it.",
      }),
    );
    return;
  }

  if (w.selected.type === "link") {
    const e = w.selected.ref;
    const pa = snap.ports.get(e.aPort.handle);
    const pb = snap.ports.get(e.bPort.handle);
    const broken = e.link.broken;
    const head = h("h3", {
      text: `Link ${e.a.name} ${e.oneway ? "→" : "–"} ${e.b.name} `,
    });
    if (e.oneway) head.appendChild(badge("ONE-WAY", "#d90"));
    else if (broken) head.appendChild(badge("CUT", "#e55"));
    panel.appendChild(head);
    if (!e.oneway)
      panel.appendChild(
        h("button", {
          class: "mstp-btn mstp-toggle" + (broken ? " mstp-active" : ""),
          html: "<span>Cut link</span><span>Restore link</span>",
          onclick: () => {
            e.link.toggle();
            select(w, { type: "link", ref: e });
          },
        }),
      );
    const rows = [
      [`${e.a.name} port`, roleState(w, pa), colorFor(effState(pa))],
      [`${e.b.name} port`, roleState(w, pb), colorFor(effState(pb))],
      [
        "cost",
        e.cost != null ? e.cost : `auto (${pa ? pa.external_path_cost : "?"})`,
      ],
    ];
    const na = portFlags(pa);
    const nb = portFlags(pb);
    if (na) rows.push([`${e.a.name} flags`, na]);
    if (nb) rows.push([`${e.b.name} flags`, nb]);
    panel.appendChild(kvTable(rows));
    panel.appendChild(
      h("p", {
        class: "mstp-hint",
        text: e.oneway
          ? "A one-way link: BPDUs travel one direction only."
          : "Double-click a link to cut it.",
      }),
    );
    return;
  }

  // node
  const n = w.selected.ref;
  const b = snap.bridges.get(n.bridge.handle);
  const head = h("h3", { text: n.name + " " });
  if (b && b.is_root) head.appendChild(badge("ROOT", "#2a7"));
  panel.appendChild(head);
  if (b)
    panel.appendChild(
      kvTable([
        ["priority", n.prio ?? 32768],
        ["bridge id", b.bridge_id],
        ["root", b.designated_root],
        ["cost to root", b.root_path_cost],
        ["protocol", b.protocol_version.toUpperCase()],
      ]),
    );

  const tbl = h("table", { class: "mstp-ports" });
  tbl.innerHTML = "<thead><tr><th>port</th><th>role / state</th></tr></thead>";
  const body = h("tbody");
  for (const port of n.ports) {
    const ps = snap.ports.get(port.handle);
    const tr = h("tr");
    tr.appendChild(h("td", { text: peerLabel(w, port, n) }));
    const td = h("td", { text: roleState(w, ps) });
    td.style.color = colorFor(effState(ps));
    tr.appendChild(td);
    body.appendChild(tr);
  }
  tbl.appendChild(body);
  panel.appendChild(tbl);
}

function roleState(w, ps) {
  return ps ? `${ps.role} / ${stateLabel(w, ps.state)}` : "-";
}

function portFlags(ps) {
  if (!ps) return "";
  const notes = [];
  if (ps.restricted_role) notes.push("root-guard");
  if (ps.bpdu_guard_port)
    notes.push(ps.bpdu_guard_error ? "bpdu-guard tripped" : "bpdu-guard");
  if (ps.network_port) notes.push("network");
  if (ps.oper_edge) notes.push("edge");
  if (ps.disputed) notes.push("disputed");
  if (ps.ba_inconsistent) notes.push("BA inconsistent");
  return notes.join(", ");
}

function peerLabel(w, port, node) {
  const e = w.links.find((e) => e.aPort === port || e.bPort === port);
  if (!e) return port.name;
  return `→ ${e.a === node ? e.b.name : e.a.name}`;
}

// Each row is [key, value] or [key, value, color] to tint the value cell.
function kvTable(rows) {
  const tbl = h("table", { class: "mstp-kv" });
  const body = h("tbody");
  for (const [k, v, color] of rows) {
    const td = h("td", { text: String(v) });
    if (color) td.style.color = color;
    body.appendChild(h("tr", {}, h("th", { text: k }), td));
  }
  tbl.appendChild(body);
  return tbl;
}

function badge(text, color) {
  const b = h("span", { class: "mstp-badge", text });
  b.style.background = color;
  return b;
}

// -- bootstrap ------------------------------------------------------

const SELECTOR = "pre.mstp-topology, div.mstp-topology:has(> pre > code)";

function mountAll(scope = document) {
  for (const el of scope.querySelectorAll(SELECTOR)) mount(el);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => mountAll());
else mountAll();
