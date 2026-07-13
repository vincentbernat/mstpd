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
const FLIGHT_MS = 800; // how long a BPDU takes to cross a link
const MAX_WAVES = 50; // give up on a cascade that never settles
const QUIET_TIME = 4; // seconds without a port change before we call it converged

// Port/link state -> colour
const STATE_COLOR = {
  forwarding: "#2a7",
  learning: "#d90",
  listening: "#d90",
  blocking: "#e55",
  discarding: "#e55",
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

// Hello time is left out: the core only accepts 2 seconds.
const timersOf = (d) => ({
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
  const clockConv = h("span", { class: "mstp-clock-c" });
  const clock = h(
    "span",
    { class: "mstp-clock" },
    clockTime,
    clockBpdu,
    clockConv,
  );
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
  const legend = h("div", { class: "mstp-legend" });
  stage.append(canvas, panel, legend);

  // The editor replaces the stage and legend while editing the definition.
  const textarea = h("textarea", { class: "mstp-edit-area" });
  textarea.spellcheck = false;
  textarea.setAttribute("aria-label", "Topology definition");
  const editor = h("div", { class: "mstp-editor" }, textarea);
  editor.hidden = true;

  const errBox = h("div", { class: "mstp-errors" });
  errBox.hidden = true;

  root.append(bar, stage, editor, errBox);

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
    clockConv,
    slow,
    speed: 1, // real seconds per simulated second (snail bumps it to SLOW_FACTOR)
    mstp: null,
    nodes: [],
    links: [],
    selected: null,
    editing: false,
    timerError: false, // the core refused the timers
    time: 0,
    // Convergence: the ports are settled once none of them changes role or
    // state any more. sig is the fingerprint we compare from second to second,
    // actionAt the time of the last cut or restore, changeAt the time of the
    // last change, and settledAt the changeAt of the last quiet second (null
    // while the ports are still moving).
    sig: "",
    actionAt: 0,
    changeAt: 0,
    settledAt: null,
    bpdus: 0, // BPDUs put on the wire since the build
    raf: null, // animation-loop handle
    clock: 0, // clock in ms (see animate)
    last: 0, // timestamp of the previous frame
    nextAt: 0, // clock time of the next step
    lastClick: { link: null, t: 0 }, // manual double-click detection
    eventBuf: [], // proposal/agreement events from the core
    flights: [], // pills flying along the links
    wave: null, // the BPDUs on the wire, and when the last of them lands
    previousEvents: null, // the previous wave's events, to match agreements to proposals
    txBase: new Map(), // transmit counters as of the last wave
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

// The protocols in play: what each bridge asks for, or the global default.
function protocolsUsed(w) {
  const protos = new Set(
    w.model.nodes.map((n) => n.proto || w.model.directives.protocol),
  );
  if (!protos.size) protos.add(w.model.directives.protocol);
  return protos;
}

function buildLegend(w) {
  w.legend.replaceChildren();
  const protos = protocolsUsed(w);
  const hasStp = protos.has("stp");
  const hasRapid = protos.has("rstp") || protos.has("mstp");
  // Rapid transitions skip learning, so it only shows in STP or on a link
  // forced off p2p, where the rapid handshake cannot happen.
  const hasSlowLink = w.model.links.some(
    (l) => l.aOpts.p2p === false || l.bOpts.p2p === false,
  );

  const entries = [["forwarding", colorFor("forwarding")]];
  if (hasStp || hasSlowLink) entries.push(["learning", colorFor("learning")]);
  entries.push([
    hasStp && hasRapid
      ? "blocking/discarding"
      : hasStp
        ? "blocking"
        : "discarding",
    colorFor("blocking"),
  ]);

  // Port states
  const stateSet = h("div", { class: "mstp-legend-set" });
  for (const [label, color] of entries) {
    const sw = h("i");
    sw.style.background = color;
    stateSet.appendChild(h("span", {}, sw, document.createTextNode(label)));
  }
  w.legend.append(stateSet, h("span", { class: "mstp-sep" }));

  // BPDU types
  const pillSet = h("div", { class: "mstp-legend-set" });
  const pills = [["hello", BPDU_COLOR.hello]];
  if (hasRapid) {
    pills.push(["proposal", BPDU_COLOR.proposal]);
    pills.push(["agreement", BPDU_COLOR.agreement]);
  }
  for (const [label, color] of pills) {
    const dot = h("i", { class: "mstp-dot" });
    dot.style.background = color;
    pillSet.appendChild(h("span", {}, dot, document.createTextNode(label)));
  }
  const ring = h("i", { class: "mstp-dot" });
  ring.style.background = "transparent";
  ring.style.border = `2px solid ${BPDU_COLOR.tc}`;
  pillSet.appendChild(
    h("span", {}, ring, document.createTextNode("topology change")),
  );
  w.legend.appendChild(pillSet);
}

// Error message if there is an issue with timers
const TIMER_ERROR =
  "timers rejected, using the defaults: max age must be between 6 and 40, " +
  "forward delay between 4 and 30, max hops between 6 and 100, " +
  "tx hold count between 1 and 10, and 2 * (forward delay - 1) >= max age";

function showErrors(w) {
  const errors = [...w.model.errors];
  if (w.timerError) errors.push(TIMER_ERROR);
  w.errBox.replaceChildren();
  if (!errors.length) {
    w.errBox.hidden = true;
    return;
  }
  w.errBox.hidden = false;
  w.errBox.append(
    h("strong", { text: "Topology errors:" }),
    ...errors.map((e) => h("div", { text: e })),
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
  w.timerError = false;
  w.time = 0;
  w.bpdus = 0;
  w.selected = null;
  w.flights = [];
  w.wave = null;
  w.previousEvents = null;
  w.eventBuf = [];
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
      if (bridge.setTimes(timers) < 0) w.timerError = true;
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

  // Record every BPDU from now on so the panel can offer a pcap download. A
  // rebuild starts a fresh capture.
  if (mstp) mstp.capture();
  w.txBase = capturePortTx(snapshot(w));
  markAction(w);
  showErrors(w);
  render(w);
  if (mstp) renderPanel(w);
}

// -- convergence ----------------------------------------------------
//
// The topology has converged once every port has stopped changing role and
// state. BPDUs keep flowing after that (hellos, and the topology change flag
// for a few more seconds), so the ports are what we watch.
function portSig(w) {
  const parts = [];
  for (const [handle, ps] of snapshot(w).ports)
    parts.push(`${handle}:${ps.role}:${ps.state}`);
  return parts.join(" ");
}

// Start measuring again: on a rebuild, and on every link cut or restore. The
// ports the link touches change right away, so that is not a change to count.
function markAction(w) {
  w.sig = portSig(w);
  w.actionAt = w.changeAt = w.time;
  w.settledAt = null;
  renderClock(w);
}

// After a second has been simulated: note whether anything moved. Once the
// ports have been quiet for QUIET_TIME, record the convergebce time.
function trackConvergence(w) {
  const sig = portSig(w);
  if (sig !== w.sig) {
    w.sig = sig;
    w.changeAt = w.time;
    w.settledAt = null;
  } else if (w.settledAt === null && w.time - w.changeAt >= QUIET_TIME) {
    w.settledAt = w.changeAt;
  }
}

// -- running --------------------------------------------------------

// Only one topology on the page runs at a time.
let activeWidget = null;

// Start a simulated second: run the timers, then put whatever the bridges
// transmit on the wire.
function stepTick(w) {
  if (!w.mstp) return;
  w.time += 1;
  w.previousEvents = null;
  w.nextAt = w.clock + 1000;

  w.mstp.oneSecond();
  emitWave(w, 0);
  if (!w.wave) endTick(w); // a quiet second: no BPDU to wait for
  redrawState(w);
}

// The wave has landed: hand the frames to the bridges and send whatever they
// answer with on its way.
function deliverWave(w) {
  const gen = w.wave.gen + 1;
  w.previousEvents = w.wave.events;
  w.wave = null;
  w.mstp.deliverBPDUs();
  emitWave(w, gen);
  if (gen >= MAX_WAVES) w.wave = null;
  if (!w.wave) endTick(w);
  redrawState(w);
}

// Nothing is left on the wire: note whether the ports moved, and leave a short
// pause before the next second starts.
function endTick(w) {
  trackConvergence(w);
  renderClock(w);
  w.nextAt = Math.max(w.nextAt, w.clock + 150);
}

// Redraw the diagram with the state currently on show.
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

  w.flights = w.flights.filter((f) => w.clock < f.start + FLIGHT_MS);

  if (w.wave) {
    if (w.clock >= w.wave.landAt) deliverWave(w);
  } else if (w.clock >= w.nextAt) stepTick(w); // start the next second

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

    // Pausing with BPDUs still on the wire: deliver them, and everything they
    // trigger, so the diagram settles where the second was heading.
    if (w.wave) {
      w.mstp.deliverBPDUs(true);
      w.wave = null;
      w.previousEvents = null;
      w.eventBuf = [];
      w.txBase = capturePortTx(snapshot(w)); // all delivered, nothing to show
      endTick(w);
    }
    w.flights = [];
    w.svg.querySelector(".mstp-pills")?.remove();
    render(w);
    renderPanel(w);
  }
}

// -- BPDU animation -------------------------------------------------
//
// Every port's transmit counters, keyed by port handle.
function capturePortTx(snap) {
  const m = new Map();
  for (const [handle, ps] of snap.ports)
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

// Send the BPDUs the bridges have transmitted since the last wave on their way,
// as one pill per frame. Every pill takes FLIGHT_MS to cross its link. The pills
// mirror the frames the core has queued, so once they have all landed the wave
// can be delivered. Stores the wave on the widget, or null when the bridges had
// nothing to say.
function emitWave(w, gen) {
  const events = tallyEvents(w.eventBuf);
  w.eventBuf = [];

  // What each port put on the wire, and how many of those frames carried a
  // topology change. The baseline carries over from the previous wave, so a
  // bridge that spoke up on its own, without a BPDU or a tick to prompt it,
  // still gets its pills.
  const before = w.txBase;
  w.txBase = capturePortTx(snapshot(w));
  const sent = new Map();
  for (const [handle, ps] of w.txBase) {
    const b = before.get(handle) || { tx: 0, tcn: 0 };
    const n = ps.tx - b.tx;
    if (n > 0) sent.set(handle, { n, tc: Math.max(0, ps.tcn - b.tcn) });
  }

  const now = w.clock;
  for (const e of w.links) {
    if (!e.geom) continue;
    const { x1, y1, x2, y2 } = e.geom;
    // Each endpoint that transmitted sends its pills to its peer.
    for (const [port, peer, sx, sy, ex, ey] of [
      [e.aPort, e.bPort, x1, y1, x2, y2],
      [e.bPort, e.aPort, x2, y2, x1, y1],
    ]) {
      if (!port) continue;
      // Do not animate one way links.
      if (e.oneway && port === e.bPort) continue;
      const t = sent.get(port.handle);
      if (!t) continue;
      const ev = events.get(port.handle) || NO_EV;
      // A real handshake agreement answers a proposal the peer sent one wave
      // earlier (it took a delivery hop to arrive). Count only those as
      // agreements, the rest are plain hellos.
      const peerProposals =
        (peer && w.previousEvents && w.previousEvents.get(peer.handle)?.prop) ||
        0;
      const nAgree = Math.min(ev.agree, peerProposals);
      const pills = classifyBpdus(t.n, ev.prop, nAgree, t.tc);
      // A port sending several BPDUs at once staggers them a little so they can
      // be told apart.
      const gap = Math.min(90, FLIGHT_MS / (pills.length + 1));
      pills.forEach((pill, i) => {
        w.flights.push({
          link: e,
          sx,
          sy,
          tx: ex,
          ty: ey,
          color: BPDU_COLOR[pill.type],
          tc: !!pill.tc,
          start: now + i * gap,
        });
      });
      w.bpdus += pills.length;
    }
  }

  // A cut or a restore puts its BPDUs on a wire that may still be carrying the
  // previous ones. The core has them all in one queue, so they make up a single
  // wave, landing when the last of them arrives.
  const landAt = w.flights.reduce(
    (m, f) => Math.max(m, f.start + FLIGHT_MS),
    0,
  );
  if (!landAt) {
    w.wave = null;
    return;
  }
  if (w.wave)
    for (const [handle, ev] of w.wave.events) {
      const g = events.get(handle) || NO_EV;
      events.set(handle, {
        prop: g.prop + ev.prop,
        agree: g.agree + ev.agree,
      });
    }
  w.wave = { gen, landAt, events };
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
    const p = (w.clock - f.start) / FLIGHT_MS;
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

// A down port keeps BR_STATE_BLOCKING but reports role "Disabled", so it lands
// on the discarding colour like any other blocked port.
const isDown = (ps) => !!ps && ps.role === "Disabled";

// The core reports RSTP/MSTP's discarding state as the kernel's "blocking"
// (mstpd maps it onto BR_STATE_BLOCKING). Show the RSTP name when appropriate.
function stateLabel(w, state) {
  const p = w.model.directives.protocol;
  if (state === "blocking" && (p === "rstp" || p === "mstp"))
    return "discarding";
  return state;
}

// -- rendering ------------------------------------------------------

function renderClock(w) {
  w.clockTime.textContent = `t=${w.time}s`;
  w.clockBpdu.textContent = `${w.bpdus} BPDUs`;
  if (w.settledAt !== null)
    w.clockConv.textContent = `🌳 ${w.settledAt - w.actionAt}s`;
  else if (!w.bpdus)
    w.clockConv.replaceChildren(); // nothing has been sent yet
  else if (!w.clockConv.firstElementChild)
    w.clockConv.replaceChildren(h("i", { class: "mstp-wait", text: "⏳" }));
}

function render(w) {
  const snap = snapshot(w);
  const live = !!w.mstp;
  renderClock(w);
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
    const active =
      live && pa?.state === "forwarding" && pb?.state === "forwarding";
    const down = live ? isDown(pa) || isDown(pb) : e.link.broken;

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
          toggleLink(w, e);
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

// Disabled and Designated both start with "D", so mark disabled ports with "X".
const roleLetter = (role) => (role === "Disabled" ? "X" : role[0]);

function drawEndpoint(parent, from, to, ps, ox = 0, oy = 0) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = from.x + ux * (R + 9) + ox;
  const py = from.y + uy * (R + 9) + oy;
  svgEl(
    "rect",
    {
      x: px - 6,
      y: py - 6,
      width: 12,
      height: 12,
      rx: 2,
      fill: colorFor(ps?.state),
      "pointer-events": "none",
    },
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
    ).textContent = roleLetter(role);
}

// -- details panel --------------------------------------------------

function select(w, sel) {
  w.selected = sel;
  render(w);
  renderPanel(w);
}

// Cutting a link takes down whatever is on it: the core drops the frames it had
// queued there, so their pills go too. The bridges react at once, without
// waiting for the next second, so put the BPDUs they answer with on the wire
// now: that is where reconvergence starts.
function toggleLink(w, e) {
  if (e.oneway) return; // a one-way fault cannot be toggled
  e.link.toggle();
  w.flights = w.flights.filter((f) => f.link !== e);
  emitWave(w, w.wave ? w.wave.gen : 0);
  markAction(w);
  select(w, { type: "link", ref: e });
}

function renderPanel(w) {
  const panel = w.panel;
  panel.replaceChildren();
  const snap = snapshot(w);

  if (!w.selected) {
    panel.appendChild(h("h3", { text: "Global timers" }));
    const b0 = snap.topo.bridges[0];
    const protos = protocolsUsed(w);
    // Hops are an MSTP notion. Inside a region MSTP counts hops instead of
    // ageing BPDUs, and every MSTP bridge here joins the same region, so max age
    // only matters when some bridge speaks STP or RSTP.
    const hasMstp = protos.has("mstp");
    const oneRegion = hasMstp && protos.size === 1;
    const rows = [["protocol", w.model.directives.protocol.toUpperCase()]];
    if (b0) {
      rows.push(
        ["hello time", `${b0.hello_time} s`],
        ["forward delay", `${b0.forward_delay} s`],
      );
      if (!oneRegion) rows.push(["max age", `${b0.max_age} s`]);
      if (hasMstp) rows.push(["max hops", b0.max_hops]);
      rows.push(["tx hold count", b0.tx_hold_count]);
    }
    panel.appendChild(kvTable(rows));
    if (w.mstp) panel.appendChild(pcapButton(w, "bpdus.pcap"));
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
          onclick: () => toggleLink(w, e),
        }),
      );
    const rows = [
      [`${e.a.name} port`, roleState(w, pa), colorFor(pa?.state)],
      [`${e.b.name} port`, roleState(w, pb), colorFor(pb?.state)],
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
    if (w.mstp && e.aPort)
      panel.appendChild(pcapButton(w, `${e.a.name}-${e.b.name}.pcap`, e.aPort));
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
    td.style.color = colorFor(ps?.state);
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

// A button that saves captured BPDUs as a pcap: the whole capture when no port
// is given, or just that port's link (both directions) when one is.
function pcapButton(w, filename, port) {
  return h("button", {
    class: "mstp-btn mstp-pcap",
    text: "📦 Download packets",
    onclick: () => w.mstp.downloadPcap(port, filename),
  });
}

// -- bootstrap ------------------------------------------------------

const SELECTOR = "pre.mstp-topology, div.mstp-topology:has(> pre > code)";

function mountAll(scope = document) {
  for (const el of scope.querySelectorAll(SELECTOR)) mount(el);
}

if (document.readyState === "loading")
  document.addEventListener("DOMContentLoaded", () => mountAll());
else mountAll();
