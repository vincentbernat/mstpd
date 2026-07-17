/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * wasm_api.c - WebAssembly harness around MSTPD core.
 *
 * This file replaces the Linux netlink/kernel gluewith a self-contained,
 * deterministic environment suitable for running inside WebAssembly:
 *
 *   - bridges and ports are created/managed entirely in memory,
 *   - BPDUs transmitted by one port are queued and delivered to the port it is
 *     linked to,
 *   - time is driven explicitly by the host via mstpw_step(),
 *   - state is exported to JavaScript as JSON.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <stdbool.h>

#include <netinet/in.h>
#include <asm/byteorder.h>
#include <linux/if_bridge.h>

#include <emscripten.h>
#define API EMSCRIPTEN_KEEPALIVE

#include "mstp.h"
#include "driver.h"
#include "log.h"
#include "list.h"

/* String builder */

typedef struct
{
    char *buf;
    size_t len;
    size_t cap;
} sb_t;

static void sb_init(sb_t *s)
{
    s->cap = 1024;
    s->buf = malloc(s->cap);
    s->len = 0;
    if(s->buf)
        s->buf[0] = '\0';
}

static void sb_printf(sb_t *s, const char *fmt, ...)
{
    if(!s->buf)
        return;
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if(n < 0)
    {
        va_end(ap2);
        return;
    }
    if(s->len + (size_t)n + 1 > s->cap)
    {
        while(s->len + (size_t)n + 1 > s->cap)
            s->cap *= 2;
        char *nb = realloc(s->buf, s->cap);
        if(!nb)
        {
            va_end(ap2);
            return;
        }
        s->buf = nb;
    }
    vsnprintf(s->buf + s->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    s->len += (size_t)n;
}

/* Append a string as a JSON-escaped, double-quoted value. */
static void sb_json_str(sb_t *s, const char *str)
{
    sb_printf(s, "\"");
    for(const char *p = str; *p; ++p)
    {
        unsigned char c = (unsigned char)*p;
        switch(c)
        {
            case '"':  sb_printf(s, "\\\""); break;
            case '\\': sb_printf(s, "\\\\"); break;
            case '\n': sb_printf(s, "\\n"); break;
            case '\r': sb_printf(s, "\\r"); break;
            case '\t': sb_printf(s, "\\t"); break;
            default:
                if(c < 0x20)
                    sb_printf(s, "\\u%04x", c);
                else
                    sb_printf(s, "%c", c);
        }
    }
    sb_printf(s, "\"");
}

/* Emit a "key": prefix, inserting a separating comma before every field but
 * the first one of the current object (tracked through *first). */
static void sb_key(sb_t *s, bool *first, const char *key)
{
    sb_printf(s, "%s\"%s\":", *first ? "" : ",", key);
    *first = false;
}

/* Append a "key":value pair of the matching JSON type. */
static void sb_kv_uint(sb_t *s, bool *first, const char *key, unsigned long v)
{
    sb_key(s, first, key);
    sb_printf(s, "%lu", v);
}

static void sb_kv_int(sb_t *s, bool *first, const char *key, long v)
{
    sb_key(s, first, key);
    sb_printf(s, "%ld", v);
}

static void sb_kv_bool(sb_t *s, bool *first, const char *key, bool v)
{
    sb_key(s, first, key);
    sb_printf(s, "%s", v ? "true" : "false");
}

static void sb_kv_str(sb_t *s, bool *first, const char *key, const char *v)
{
    sb_key(s, first, key);
    sb_json_str(s, v);
}

/* Append raw bytes as a lower-case hex JSON string. */
static void sb_kv_hex(sb_t *s, bool *first, const char *key,
                      const unsigned char *data, int len)
{
    sb_key(s, first, key);
    sb_printf(s, "\"");
    for(int i = 0; i < len; ++i)
        sb_printf(s, "%02x", data[i]);
    sb_printf(s, "\"");
}

/* Append a bridge identifier as a JSON string "prio.mac". */
static void sb_bridge_id(sb_t *s, bool *first, const char *key,
                         bridge_identifier_t id)
{
    const __u8 *m = id.s.mac_address;
    char val[32];
    snprintf(val, sizeof val, "%u.%02x:%02x:%02x:%02x:%02x:%02x",
             __be16_to_cpu(id.s.priority), m[0], m[1], m[2], m[3], m[4], m[5]);
    sb_kv_str(s, first, key, val);
}

/* Append a port identifier as a JSON number plus its low-12-bit port number. */
static void sb_port_id(sb_t *s, bool *first, const char *key,
                       port_identifier_t pid)
{
    __u16 v = __be16_to_cpu(pid);
    char numkey[32];
    sb_kv_uint(s, first, key, v);
    snprintf(numkey, sizeof numkey, "%s_number", key);
    sb_kv_uint(s, first, numkey, v & 0x0FFF);
}

/* Tracing */

/* Simulation time in seconds, advanced one tick at a time by mstpw_step(). */
static unsigned long g_now;

/* An optional ring of recent state-machine events (proposal/agreement BPDUs and
 * port state changes) the host can drain. */
#define MSTPW_TRACE_CAP 8192
typedef struct
{
    unsigned long t;
    int port;
    const char *event;
} trace_event_t;
static bool g_trace_on;
static trace_event_t g_trace[MSTPW_TRACE_CAP];
static unsigned int g_trace_count;

static void trace_record(int porth, const char *event)
{
    if(!g_trace_on || g_trace_count >= MSTPW_TRACE_CAP)
        return;
    trace_event_t *e = &g_trace[g_trace_count++];
    e->t = g_now;
    e->port = porth;
    e->event = event;
}

/* An optional capture of transmitted BPDUs the host reads to build a pcap.
 * Capture is done in a ring buffer. Each entry keeps the raw BPDU bytes plus
 * what a real capture needs: the sending port and its MAC. Time is the integer
 * sim clock, with a within-second sequence so frames sent in the same tick keep
 * their order. */
#define MSTPW_CAPTURE_CAP 8192
typedef struct
{
    unsigned long t;
    unsigned int subsec;
    int port;
    int len;
    unsigned char src[ETH_ALEN];
    unsigned char *data;  /* owned */
} capture_frame_t;
static bool g_capture_on;
static capture_frame_t g_capture[MSTPW_CAPTURE_CAP];
static unsigned int g_capture_head;   /* index of the oldest frame */
static unsigned int g_capture_count;  /* frames stored, up to the cap */
static unsigned long g_capture_t;
static unsigned int g_capture_subsec;

static void capture_reset(void)
{
    for(unsigned int i = 0; i < g_capture_count; ++i)
    {
        unsigned int idx = (g_capture_head + i) % MSTPW_CAPTURE_CAP;
        free(g_capture[idx].data);
        g_capture[idx].data = NULL;
    }
    g_capture_head = 0;
    g_capture_count = 0;
    g_capture_t = 0;
    g_capture_subsec = 0;
}

static void capture_record(port_t *prt, const void *data, int len)
{
    if(!g_capture_on)
        return;
    unsigned char *copy = malloc(len);
    if(!copy)
        return;
    memcpy(copy, data, len);
    if(g_now != g_capture_t)
    {
        g_capture_t = g_now;
        g_capture_subsec = 0;
    }
    unsigned int idx;
    if(g_capture_count < MSTPW_CAPTURE_CAP)
        idx = (g_capture_head + g_capture_count++) % MSTPW_CAPTURE_CAP;
    else
    {
        /* Ring is full: reuse the oldest slot and advance the head. */
        idx = g_capture_head;
        free(g_capture[idx].data);
        g_capture_head = (g_capture_head + 1) % MSTPW_CAPTURE_CAP;
    }
    capture_frame_t *c = &g_capture[idx];
    c->t = g_now;
    c->subsec = g_capture_subsec++;
    c->port = prt->sysdeps.if_index;
    memcpy(c->src, prt->sysdeps.macaddr, ETH_ALEN);
    c->len = len;
    c->data = copy;
}

/* Bridge and port registries */

#define MSTPW_MAX_BRIDGES 256
#define MSTPW_MAX_PORTS   4096

typedef struct
{
    port_t *prt;     /* NULL marks a free slot */
    int brh;         /* owning bridge handle */
    int peer;        /* port at the other end of the cable, or -1 */
    bool admin_up;   /* enabled by the caller */
    bool mute;       /* transmitter is dead: a one-way fault */
} port_slot_t;

/* A NULL pointer marks a free slot in either table. */
static bridge_t *g_bridges[MSTPW_MAX_BRIDGES];
static port_slot_t g_ports[MSTPW_MAX_PORTS];

static bool br_handle_ok(int h)
{
    return h >= 0 && h < MSTPW_MAX_BRIDGES && g_bridges[h] != NULL;
}

static bool port_handle_ok(int h)
{
    return h >= 0 && h < MSTPW_MAX_PORTS && g_ports[h].prt != NULL;
}

static int alloc_br_handle(void)
{
    for(int i = 0; i < MSTPW_MAX_BRIDGES; ++i)
        if(!g_bridges[i])
            return i;
    return -1;
}

static int alloc_port_handle(void)
{
    for(int i = 0; i < MSTPW_MAX_PORTS; ++i)
        if(!g_ports[i].prt)
            return i;
    return -1;
}

/* BPDU transport */

typedef struct frame
{
    struct frame *next;
    unsigned long seq;
    int src;           /* source port handle */
    int dst;           /* destination port handle */
    int len;           /* BPDU length in bytes */
    unsigned char data[];
} frame_t;

static frame_t *g_q_head, *g_q_tail;
static unsigned long g_frames_delivered;
static unsigned long g_frame_seq;

static void frame_enqueue(int src, int dst, const void *data, int len)
{
    frame_t *f = malloc(sizeof(*f) + len);
    if(!f)
        return;
    f->next = NULL;
    f->seq = ++g_frame_seq;
    f->src = src;
    f->dst = dst;
    f->len = len;
    memcpy(f->data, data, len);
    if(g_q_tail)
        g_q_tail->next = f;
    else
        g_q_head = f;
    g_q_tail = f;
}

static frame_t *frame_dequeue(void)
{
    frame_t *f = g_q_head;
    if(!f)
        return NULL;
    g_q_head = f->next;
    if(!g_q_head)
        g_q_tail = NULL;
    return f;
}

/* Drop every queued frame addressed to a port. */
static void frame_purge_dst(int dst)
{
    frame_t **pp = &g_q_head;
    g_q_tail = NULL;
    while(*pp)
    {
        frame_t *f = *pp;
        if(f->dst == dst)
        {
            *pp = f->next;
            free(f);
        }
        else
        {
            g_q_tail = f;
            pp = &f->next;
        }
    }
}

/* Safety cap: convergence of a sane topology empties the queue quickly. */
#define MSTPW_DELIVER_CAP 2000000UL

/* Carrier */

/* A port is really up once it is enabled and, when a cable is plugged in, the
 * far end is enabled too. A port with no cable stays up, since it may well have
 * a host on it and nobody to talk STP to. */
static bool port_carrier(int porth)
{
    const port_slot_t *p = &g_ports[porth];
    if(!p->admin_up)
        return false;
    if(!port_handle_ok(p->peer))
        return true;
    return g_ports[p->peer].admin_up;
}

/* Bring the two ends of a cable up or down together. Both carriers are set
 * before either bridge's state machines run: a port sends a BPDU as soon as it
 * comes up, and that frame would be dropped were its peer not up yet. Pass -1 as
 * the second port to refresh a single one. */
static void sync_carrier(int a, int b)
{
    const int ports[2] = {a, b};
    bool changed[2] = {false, false};

    for(int i = 0; i < 2; ++i)
    {
        if(!port_handle_ok(ports[i]))
            continue;
        port_t *prt = g_ports[ports[i]].prt;
        bool up = port_carrier(ports[i]);
        changed[i] = up != prt->sysdeps.up;
        prt->sysdeps.up = up;
        /* Whatever was on its way to a port that just went down is lost with the
         * cable. */
        if(changed[i] && !up)
            frame_purge_dst(ports[i]);
    }
    for(int i = 0; i < 2; ++i)
    {
        if(!changed[i])
            continue;
        port_t *prt = g_ports[ports[i]].prt;
        MSTP_IN_set_port_enable(prt, prt->sysdeps.up, prt->sysdeps.speed,
                                prt->sysdeps.duplex);
    }
}

/* Pull the cable out of both ends and return the port this one was plugged into,
 * or -1. The carriers are left to the caller to sync, so that a port getting a
 * new cable can be brought up once, with the cable in place. */
static int unplug(int porth)
{
    int peer = g_ports[porth].peer;
    g_ports[porth].peer = -1;
    g_ports[porth].mute = false;
    if(port_handle_ok(peer))
    {
        g_ports[peer].peer = -1;
        g_ports[peer].mute = false;
    }
    return peer;
}

/* Helpers */

static int hexval(char c)
{
    if(c >= '0' && c <= '9') return c - '0';
    if(c >= 'a' && c <= 'f') return c - 'a' + 10;
    if(c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Parse "aa:bb:cc:dd:ee:ff" (also accepts '-' separators or none) into 6 bytes.
 * Returns true on success.  On failure leaves mac untouched. */
static bool parse_mac(const char *s, __u8 mac[ETH_ALEN])
{
    __u8 out[ETH_ALEN];
    int n = 0;
    if(!s)
        return false;
    while(*s && n < ETH_ALEN)
    {
        if(*s == ':' || *s == '-')
        {
            ++s;
            continue;
        }
        int hi = hexval(*s++);
        if(hi < 0 || !*s)
            return false;
        int lo = hexval(*s++);
        if(lo < 0)
            return false;
        out[n++] = (__u8)((hi << 4) | lo);
    }
    if(n != ETH_ALEN)
        return false;
    memcpy(mac, out, ETH_ALEN);
    return true;
}

static const char *role_name(port_role_t role)
{
    switch(role)
    {
        case roleDisabled:   return "Disabled";
        case roleRoot:       return "Root";
        case roleDesignated: return "Designated";
        case roleAlternate:  return "Alternate";
        case roleBackup:     return "Backup";
        case roleMaster:     return "Master";
        default:             return "Unknown";
    }
}

static const char *state_name(int state)
{
    switch(state)
    {
        case BR_STATE_DISABLED:   return "disabled";
        case BR_STATE_LISTENING:  return "listening";
        case BR_STATE_LEARNING:   return "learning";
        case BR_STATE_FORWARDING: return "forwarding";
        case BR_STATE_BLOCKING:   return "blocking";
        default:                  return "unknown";
    }
}

static const char *protocol_version_name(protocol_version_t v)
{
    switch(v)
    {
        case protoSTP:  return "stp";
        case protoRSTP: return "rstp";
        case protoMSTP: return "mstp";
        default:        return "unknown";
    }
}

static const char *admin_p2p_name(admin_p2p_t p2p)
{
    switch(p2p)
    {
        case p2pAuto:       return "auto";
        case p2pForceTrue:  return "yes";
        case p2pForceFalse: return "no";
        default:            return "unknown";
    }
}

static tree_t *find_tree(bridge_t *br, int mstid)
{
    __be16 id = __cpu_to_be16((__u16)mstid);
    tree_t *tree;
    list_for_each_entry(tree, &br->trees, bridge_list)
        if(tree->MSTID == id)
            return tree;
    return NULL;
}

static per_tree_port_t *find_ptp(port_t *prt, __be16 mstid)
{
    per_tree_port_t *ptp;
    list_for_each_entry(ptp, &prt->trees, port_list)
        if(ptp->MSTID == mstid)
            return ptp;
    return NULL;
}

/* JSON output */

static void json_port(sb_t *s, int porth)
{
    port_t *prt = g_ports[porth].prt;
    CIST_PortStatus st;
    MSTP_IN_get_cist_port_status(prt, &st);

    bool first = true;
    sb_printf(s, "{");
    sb_kv_int(s, &first, "handle", porth);
    sb_kv_str(s, &first, "name", prt->sysdeps.name);
    sb_kv_int(s, &first, "peer", g_ports[porth].peer);
    sb_kv_bool(s, &first, "up", prt->sysdeps.up);
    sb_port_id(s, &first, "port_id", st.port_id);
    sb_kv_str(s, &first, "role", role_name(st.role));
    sb_kv_str(s, &first, "state", state_name(st.state));
    sb_kv_bool(s, &first, "admin_edge", st.admin_edge_port);
    sb_kv_bool(s, &first, "auto_edge", st.auto_edge_port);
    sb_kv_bool(s, &first, "oper_edge", st.oper_edge_port);
    sb_kv_str(s, &first, "admin_p2p", admin_p2p_name(st.admin_p2p));
    sb_kv_bool(s, &first, "oper_p2p", st.oper_p2p);
    sb_kv_bool(s, &first, "bpdu_guard_port", st.bpdu_guard_port);
    sb_kv_bool(s, &first, "bpdu_guard_error", st.bpdu_guard_error);
    sb_kv_bool(s, &first, "restricted_role", st.restricted_role);
    sb_kv_bool(s, &first, "restricted_tcn", st.restricted_tcn);
    sb_kv_bool(s, &first, "disputed", st.disputed);
    sb_kv_bool(s, &first, "network_port", st.network_port);
    sb_kv_bool(s, &first, "ba_inconsistent", st.ba_inconsistent);
    sb_kv_bool(s, &first, "send_rstp", st.sendRSTP);

    per_tree_port_t *cist = find_ptp(prt, 0);
    if(cist)
    {
        sb_kv_bool(s, &first, "proposing", cist->proposing);
        sb_kv_bool(s, &first, "proposed", cist->proposed);
        sb_kv_bool(s, &first, "agree", cist->agree);
        sb_kv_bool(s, &first, "agreed", cist->agreed);
        sb_kv_bool(s, &first, "sync", cist->sync);
        sb_kv_bool(s, &first, "synced", cist->synced);
        sb_kv_bool(s, &first, "re_root", cist->reRoot);
    }

    sb_kv_uint(s, &first, "admin_external_path_cost", st.admin_external_port_path_cost);
    sb_kv_uint(s, &first, "external_path_cost", st.external_port_path_cost);
    sb_kv_uint(s, &first, "internal_path_cost", st.internal_port_path_cost);
    sb_bridge_id(s, &first, "designated_root", st.designated_root);
    sb_bridge_id(s, &first, "designated_bridge", st.designated_bridge);
    sb_port_id(s, &first, "designated_port", st.designated_port);
    sb_kv_uint(s, &first, "tx_bpdu", st.num_tx_bpdu);
    sb_kv_uint(s, &first, "rx_bpdu", st.num_rx_bpdu);
    sb_kv_uint(s, &first, "tx_tcn", st.num_tx_tcn);
    sb_kv_uint(s, &first, "rx_tcn", st.num_rx_tcn);

    /* Per-MSTI role/state for this port. */
    sb_key(s, &first, "mstis");
    sb_printf(s, "[");
    bool mfirst = true;
    per_tree_port_t *ptp;
    list_for_each_entry(ptp, &prt->trees, port_list)
    {
        if(0 == ptp->MSTID)
            continue; /* CIST already reported above */
        MSTI_PortStatus mst;
        MSTP_IN_get_msti_port_status(ptp, &mst);
        bool ifirst = true;
        sb_printf(s, "%s{", mfirst ? "" : ",");
        sb_kv_uint(s, &ifirst, "mstid", __be16_to_cpu(ptp->MSTID));
        sb_kv_str(s, &ifirst, "role", role_name(mst.role));
        sb_kv_str(s, &ifirst, "state", state_name(mst.state));
        sb_kv_uint(s, &ifirst, "admin_internal_path_cost",
                   mst.admin_internal_port_path_cost);
        sb_kv_uint(s, &ifirst, "internal_path_cost",
                   mst.internal_port_path_cost);
        sb_kv_bool(s, &ifirst, "disputed", mst.disputed);
        sb_printf(s, "}");
        mfirst = false;
    }
    sb_printf(s, "]}");
}

static void json_bridge(sb_t *s, int brh)
{
    bridge_t *br = g_bridges[brh];
    CIST_BridgeStatus st;
    MSTP_IN_get_cist_bridge_status(br, &st);

    bool first = true;
    sb_printf(s, "{");
    sb_kv_int(s, &first, "handle", brh);
    sb_kv_str(s, &first, "name", br->sysdeps.name);
    sb_kv_bool(s, &first, "enabled", st.enabled);
    sb_bridge_id(s, &first, "bridge_id", st.bridge_id);
    sb_bridge_id(s, &first, "designated_root", st.designated_root);
    sb_kv_uint(s, &first, "root_path_cost", st.root_path_cost);
    sb_bridge_id(s, &first, "regional_root", st.regional_root);
    sb_kv_uint(s, &first, "internal_path_cost", st.internal_path_cost);
    sb_kv_bool(s, &first, "is_root", cmp(st.bridge_id, ==, st.designated_root));
    sb_kv_bool(s, &first, "topology_change", st.topology_change);
    sb_kv_uint(s, &first, "topology_change_count", st.topology_change_count);
    sb_kv_uint(s, &first, "max_age", st.bridge_max_age);
    sb_kv_uint(s, &first, "forward_delay", st.bridge_forward_delay);
    sb_kv_uint(s, &first, "hello_time", st.bridge_hello_time);
    sb_kv_uint(s, &first, "max_hops", st.max_hops);
    sb_kv_uint(s, &first, "tx_hold_count", st.tx_hold_count);
    sb_kv_str(s, &first, "protocol_version",
              protocol_version_name(st.protocol_version));

    char cfg_name[CONFIGURATION_NAME_LEN + 1];
    memcpy(cfg_name, br->MstConfigId.s.configuration_name,
           CONFIGURATION_NAME_LEN);
    cfg_name[CONFIGURATION_NAME_LEN] = '\0';
    sb_kv_str(s, &first, "mst_config_name", cfg_name);
    sb_kv_uint(s, &first, "mst_config_revision",
               __be16_to_cpu(br->MstConfigId.s.revision_level));

    /* Ports */
    sb_key(s, &first, "ports");
    sb_printf(s, "[");
    bool pfirst = true;
    for(int i = 0; i < MSTPW_MAX_PORTS; ++i)
    {
        if(!g_ports[i].prt || g_ports[i].brh != brh)
            continue;
        if(!pfirst)
            sb_printf(s, ",");
        json_port(s, i);
        pfirst = false;
    }
    sb_printf(s, "]");

    /* MSTI bridge-level status */
    sb_key(s, &first, "mstis");
    sb_printf(s, "[");
    bool mfirst = true;
    tree_t *tree;
    list_for_each_entry(tree, &br->trees, bridge_list)
    {
        if(0 == tree->MSTID)
            continue;
        MSTI_BridgeStatus mst;
        MSTP_IN_get_msti_bridge_status(tree, &mst);
        bool ifirst = true;
        sb_printf(s, "%s{", mfirst ? "" : ",");
        sb_kv_uint(s, &ifirst, "mstid", __be16_to_cpu(tree->MSTID));
        sb_bridge_id(s, &ifirst, "regional_root", mst.regional_root);
        sb_kv_uint(s, &ifirst, "internal_path_cost", mst.internal_path_cost);
        sb_printf(s, "}");
        mfirst = false;
    }
    sb_printf(s, "]}");
}

/* mstp.h */

void MSTP_OUT_set_state(per_tree_port_t *ptp, int new_state)
{
    port_t *prt = ptp->port;
    if(ptp->state == new_state)
        return;
    ptp->state = driver_set_new_state(ptp, new_state);

    switch(ptp->state)
    {
        case BR_STATE_FORWARDING:
            ++(prt->num_trans_fwd);
            break;
        case BR_STATE_BLOCKING:
            ++(prt->num_trans_blk);
            break;
        default:
            break;
    }
    trace_record(prt->sysdeps.if_index, state_name(ptp->state));
    INFO_MSTINAME(ptp, "Entering %s state", state_name(ptp->state));
}

void MSTP_OUT_flush_all_fids(per_tree_port_t *ptp)
{
    /* driver_flush_all_fids() signals completion synchronously via
     * MSTP_IN_all_fids_flushed(), matching the default driver_deps.c. */
    driver_flush_all_fids(ptp);
}

void MSTP_OUT_set_ageing_time(port_t *prt, unsigned int ageingTime)
{
    unsigned int actual = driver_set_ageing_time(prt, ageingTime);
    INFO_PRTNAME(prt, "Setting new ageing time to %u", actual);
}

void MSTP_OUT_tx_bpdu(port_t *prt, bpdu_t *bpdu, int size)
{
    /* Keep the per-port counters in sync with the daemon's bridge_track.c. */
    ++(prt->num_tx_bpdu);
    if((protoSTP == bpdu->protocolVersion) && (bpduTypeTCN == bpdu->bpduType))
        ++(prt->num_tx_tcn);
    else if(bpdu->flags & (1 << offsetTc))
        ++(prt->num_tx_tcn);

    int porth = prt->sysdeps.if_index;
    if(bpduTypeRST == bpdu->bpduType)
    {
        if(bpdu->flags & (1 << offsetProposal))
            trace_record(porth, "proposal");
        if(bpdu->flags & (1 << offsetAgreement))
            trace_record(porth, "agreement");
    }

    /* Record the egress frame, whether or not a peer is listening. */
    capture_record(prt, bpdu, size);

    if(!port_handle_ok(porth))
        return;
    if(g_ports[porth].mute)
        return; /* one-way fault: this end cannot transmit */
    int peer = g_ports[porth].peer;
    if(!port_handle_ok(peer))
        return; /* nothing plugged in: frame is lost */

    frame_enqueue(porth, peer, bpdu, size);
}

void MSTP_OUT_shutdown_port(port_t *prt)
{
    /* BPDU-guard / errdisable: take the port administratively down, which drops
     * the carrier at the other end of the cable too. */
    int porth = prt->sysdeps.if_index;
    g_ports[porth].admin_up = false;
    sync_carrier(porth, g_ports[porth].peer);
}

/* log.h */

int log_level = LOG_LEVEL_ERROR;

void vDprintf(int level, const char *fmt, va_list ap)
{
    if(level > log_level)
        return;
    vfprintf(stderr, fmt, ap);
    /* The core's log strings are not newline-terminated; add one so the host
     * (Emscripten's line-buffered printErr) emits one message per line. */
    size_t len = strlen(fmt);
    if(0 == len || '\n' != fmt[len - 1])
        fputc('\n', stderr);
}

void Dprintf(int level, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vDprintf(level, fmt, ap);
    va_end(ap);
}

/* Public C API */

API void mstpw_init(void)
{
    driver_mstp_init();
}

API void mstpw_set_log_level(int level)
{
    log_level = level;
}

/* Returns a bridge handle (>= 0) or -1 on error. */
API int mstpw_bridge_create(const char *name, const char *mac)
{
    int brh = alloc_br_handle();
    if(brh < 0)
        return -1;

    bridge_t *br = calloc(1, sizeof(*br));
    if(!br)
        return -1;

    br->sysdeps.if_index = brh;
    snprintf(br->sysdeps.name, IFNAMSIZ, "%s", name ? name : "br");
    if(!parse_mac(mac, br->sysdeps.macaddr))
    {
        br->sysdeps.macaddr[0] = 0x02;
        br->sysdeps.macaddr[1] = 0x00;
        br->sysdeps.macaddr[2] = 0x00;
        br->sysdeps.macaddr[3] = 0x00;
        br->sysdeps.macaddr[4] = (__u8)(brh >> 8);
        br->sysdeps.macaddr[5] = (__u8)(brh & 0xff);
    }

    if(!driver_create_bridge(br, br->sysdeps.macaddr) ||
       !MSTP_IN_bridge_create(br, br->sysdeps.macaddr))
    {
        free(br);
        return -1;
    }

    g_bridges[brh] = br;
    return brh;
}

/* Enable/disable STP processing for the whole bridge. */
API int mstpw_bridge_set_enable(int brh, int up)
{
    if(!br_handle_ok(brh))
        return -1;
    bridge_t *br = g_bridges[brh];
    br->sysdeps.up = !!up;
    br->stp_enabled = !!up;
    MSTP_IN_set_bridge_enable(br, !!up);
    return 0;
}

API int mstpw_bridge_delete(int brh)
{
    if(!br_handle_ok(brh))
        return -1;
    bridge_t *br = g_bridges[brh];

    /* Drop ports belonging to this bridge first. */
    for(int i = 0; i < MSTPW_MAX_PORTS; ++i)
    {
        if(g_ports[i].prt && g_ports[i].brh == brh)
        {
            int peer = unplug(i);
            MSTP_IN_delete_port(g_ports[i].prt);
            free(g_ports[i].prt);
            g_ports[i].prt = NULL;
            g_ports[i].admin_up = false;
            frame_purge_dst(i);
            sync_carrier(peer, -1);
        }
    }

    MSTP_IN_delete_bridge(br);
    free(br);
    g_bridges[brh] = NULL;
    return 0;
}

/* Returns a port handle (>= 0) or -1 on error. */
API int mstpw_port_create(int brh, const char *name, const char *mac,
                          int portno, int speed, int duplex)
{
    if(!br_handle_ok(brh))
        return -1;
    if(portno <= 0 || portno > MAX_PORT_NUMBER)
        return -1;

    int porth = alloc_port_handle();
    if(porth < 0)
        return -1;

    port_t *prt = calloc(1, sizeof(*prt));
    if(!prt)
        return -1;

    bridge_t *br = g_bridges[brh];
    prt->bridge = br;
    prt->sysdeps.if_index = porth;
    snprintf(prt->sysdeps.name, IFNAMSIZ, "%s", name ? name : "p");
    if(!parse_mac(mac, prt->sysdeps.macaddr))
    {
        prt->sysdeps.macaddr[0] = 0x02;
        prt->sysdeps.macaddr[1] = 0x00;
        prt->sysdeps.macaddr[2] = 0x00;
        prt->sysdeps.macaddr[3] = (__u8)brh;
        prt->sysdeps.macaddr[4] = (__u8)(porth >> 8);
        prt->sysdeps.macaddr[5] = (__u8)(porth & 0xff);
    }
    prt->sysdeps.speed = speed > 0 ? speed : 1000;
    prt->sysdeps.duplex = duplex ? 1 : 0;

    if(!driver_create_port(prt, (__u16)portno) ||
       !MSTP_IN_port_create_and_add_tail(prt, (__u16)portno))
    {
        free(prt);
        return -1;
    }

    g_ports[porth].prt = prt;
    g_ports[porth].brh = brh;
    g_ports[porth].peer = -1;
    g_ports[porth].admin_up = false;
    g_ports[porth].mute = false;
    return porth;
}

API int mstpw_port_set_enable(int porth, int up, int speed, int duplex)
{
    if(!port_handle_ok(porth))
        return -1;
    port_t *prt = g_ports[porth].prt;
    if(up)
    {
        prt->sysdeps.speed = speed > 0 ? speed : prt->sysdeps.speed;
        prt->sysdeps.duplex = duplex ? 1 : 0;
    }
    g_ports[porth].admin_up = !!up;
    sync_carrier(porth, g_ports[porth].peer);
    return 0;
}

API int mstpw_port_delete(int porth)
{
    if(!port_handle_ok(porth))
        return -1;
    int peer = unplug(porth);
    MSTP_IN_delete_port(g_ports[porth].prt);
    free(g_ports[porth].prt);
    g_ports[porth].prt = NULL;
    g_ports[porth].admin_up = false;
    sync_carrier(peer, -1);
    return 0;
}

/* Connect two ports with a virtual cable: each one's transmitted BPDUs are
 * delivered to the other.  Re-linking transparently detaches old peers. */
API int mstpw_link(int a, int b)
{
    if(!port_handle_ok(a) || !port_handle_ok(b) || a == b)
        return -1;
    sync_carrier(unplug(a), unplug(b)); /* whatever a and b were plugged into */
    g_ports[a].peer = b;
    g_ports[b].peer = a;
    sync_carrier(a, b);
    return 0;
}

/* A unidirectional link: BPDUs flow from->to only (a one-way fibre failure).
 * The cable is whole, so both ends keep their carrier and `to` still receives.
 * Its transmitter is what is dead, so `from` never hears it. */
API int mstpw_link_oneway(int from, int to)
{
    if(!port_handle_ok(from) || !port_handle_ok(to) || from == to)
        return -1;
    sync_carrier(unplug(from), unplug(to));
    g_ports[from].peer = to;
    g_ports[to].peer = from;
    g_ports[to].mute = true;
    sync_carrier(from, to);
    return 0;
}

API int mstpw_unlink(int porth)
{
    if(!port_handle_ok(porth))
        return -1;
    sync_carrier(porth, unplug(porth));
    return 0;
}

/* One second of timer ticks, transmitting the BPDUs the tick produces but
 * leaving them queued. */
API void mstpw_one_second(void)
{
    ++g_now;
    for(int j = 0; j < MSTPW_MAX_BRIDGES; ++j)
        if(g_bridges[j] && g_bridges[j]->stp_enabled)
            MSTP_IN_one_second(g_bridges[j]);
}

/* Deliver queued BPDUs. With `all`, keep going until the cascade is quiescent;
 * otherwise deliver just the frames queued right now (one generation), leaving
 * the frames they cause for the next call. Returns the number delivered, so a
 * generation-at-a-time caller can loop until it returns 0. */
API int mstpw_deliver_bpdus(int all)
{
    unsigned long guard = 0;
    int delivered = 0;
    do
    {
        /* Detach the current generation up front so responses transmitted while
         * we deliver it wait for the next round. */
        frame_t *wave = g_q_head;
        g_q_head = g_q_tail = NULL;
        while(wave)
        {
            frame_t *f = wave;
            wave = f->next;
            if(++guard > MSTPW_DELIVER_CAP)
            {
                ERROR("mstpw_deliver_bpdus: frame cap reached, not converging?");
                free(f);
                while(wave) { frame_t *n = wave->next; free(wave); wave = n; }
                while((f = frame_dequeue()))
                    free(f);
                return delivered;
            }
            if(port_handle_ok(f->dst) && g_ports[f->dst].prt->sysdeps.up)
            {
                ++g_frames_delivered;
                ++delivered;
                MSTP_IN_rx_bpdu(g_ports[f->dst].prt, (bpdu_t *)f->data, f->len);
            }
            free(f);
        }
    } while(all && g_q_head);
    return delivered;
}

/* The BPDUs on the wire: what the next mstpw_deliver_bpdus() will hand over,
 * each with the flags that say what it is. Frames after `since` only, so a
 * caller that has already drawn the wave can pick up what a cut has just added
 * to it without seeing the rest twice. Pass 0 for the whole queue. */
API char *mstpw_queued_json(unsigned long since)
{
    sb_t s;
    sb_init(&s);
    sb_printf(&s, "[");
    bool first_frame = true;
    for(const frame_t *f = g_q_head; f; f = f->next)
    {
        if(f->seq <= since)
            continue;
        const bpdu_t *b = (const bpdu_t *)f->data;
        bool rst = (bpduTypeRST == b->bpduType);
        bool tcn = (protoSTP == b->protocolVersion)
                   && (bpduTypeTCN == b->bpduType);
        bool first = true;
        sb_printf(&s, "%s{", first_frame ? "" : ",");
        first_frame = false;
        sb_kv_uint(&s, &first, "seq", f->seq);
        sb_kv_int(&s, &first, "src", f->src);
        sb_kv_int(&s, &first, "dst", f->dst);
        sb_kv_bool(&s, &first, "proposal",
                   rst && (b->flags & (1 << offsetProposal)));
        sb_kv_bool(&s, &first, "agreement",
                   rst && (b->flags & (1 << offsetAgreement)));
        sb_kv_bool(&s, &first, "tc", tcn || (b->flags & (1 << offsetTc)));
        sb_printf(&s, "}");
    }
    sb_printf(&s, "]");
    return s.buf;
}

/* Advance the whole simulation by `seconds`, delivering BPDUs after each tick. */
API void mstpw_step(int seconds)
{
    for(int i = 0; i < seconds; ++i)
    {
        mstpw_one_second();
        mstpw_deliver_bpdus(1);
    }
}

API void mstpw_trace_enable(int on)
{
    g_trace_on = !!on;
    if(!g_trace_on)
        g_trace_count = 0;
}

/* Return the events recorded since the last drain as a JSON array, then clear
 * the buffer. Caller frees. */
API char *mstpw_trace_json(void)
{
    sb_t s;
    sb_init(&s);
    sb_printf(&s, "[");
    for(unsigned int i = 0; i < g_trace_count; ++i)
    {
        trace_event_t *e = &g_trace[i];
        bool first = true;
        sb_printf(&s, "%s{", i ? "," : "");
        sb_kv_uint(&s, &first, "t", e->t);
        sb_kv_int(&s, &first, "port", e->port);
        if(port_handle_ok(e->port))
        {
            sb_kv_str(&s, &first, "port_name", g_ports[e->port].prt->sysdeps.name);
            bridge_t *br = g_bridges[g_ports[e->port].brh];
            sb_kv_str(&s, &first, "bridge", br ? br->sysdeps.name : "");
        }
        sb_kv_str(&s, &first, "event", e->event);
        sb_printf(&s, "}");
    }
    sb_printf(&s, "]");
    g_trace_count = 0;
    return s.buf;
}

API void mstpw_capture_enable(int on)
{
    g_capture_on = !!on;
    capture_reset();
}

/* Return the BPDUs currently in the ring as a JSON array, oldest first. This
 * is non-destructive: the frames stay in the ring so it can be read again.
 * Each entry is { t, subsec, port, src, data } with src and data hex-encoded;
 * the host wraps the BPDU in Ethernet/LLC framing to build a pcap. Caller
 * frees the string.
 *
 * With porth < 0 every frame is returned. With a valid port handle only the
 * frames on that port's link are kept: those whose source MAC is the port's
 * own or its current peer's. */
API char *mstpw_capture_json(int porth)
{
    bool filter = porth >= 0;
    const unsigned char *localmac = NULL, *peermac = NULL;
    if(filter && port_handle_ok(porth))
    {
        localmac = g_ports[porth].prt->sysdeps.macaddr;
        int peer = g_ports[porth].peer;
        if(port_handle_ok(peer))
            peermac = g_ports[peer].prt->sysdeps.macaddr;
    }

    sb_t s;
    sb_init(&s);
    sb_printf(&s, "[");
    bool first_frame = true;
    for(unsigned int i = 0; i < g_capture_count; ++i)
    {
        capture_frame_t *c = &g_capture[(g_capture_head + i) % MSTPW_CAPTURE_CAP];
        if(filter)
        {
            /* An unknown port matches nothing; otherwise keep local or peer. */
            if(!localmac)
                continue;
            if(0 != memcmp(c->src, localmac, ETH_ALEN)
               && (!peermac || 0 != memcmp(c->src, peermac, ETH_ALEN)))
                continue;
        }
        bool first = true;
        sb_printf(&s, "%s{", first_frame ? "" : ",");
        first_frame = false;
        sb_kv_uint(&s, &first, "t", c->t);
        sb_kv_uint(&s, &first, "subsec", c->subsec);
        sb_kv_int(&s, &first, "port", c->port);
        if(port_handle_ok(c->port))
        {
            sb_kv_str(&s, &first, "port_name",
                      g_ports[c->port].prt->sysdeps.name);
            bridge_t *br = g_bridges[g_ports[c->port].brh];
            sb_kv_str(&s, &first, "bridge", br ? br->sysdeps.name : "");
        }
        sb_kv_hex(&s, &first, "src", c->src, ETH_ALEN);
        sb_kv_hex(&s, &first, "data", c->data, c->len);
        sb_printf(&s, "}");
    }
    sb_printf(&s, "]");
    return s.buf;
}

API int mstpw_set_mst_config_id(int brh, int revision, const char *name)
{
    if(!br_handle_ok(brh))
        return -1;
    MSTP_IN_set_mst_config_id(g_bridges[brh], (__u16)revision, (__u8 *)(name ? name : ""));
    return 0;
}

/* version: protoSTP(0), protoRSTP(2), protoMSTP(3).  Defaults to RSTP; set
 * MSTP on every bridge that should share an MST region. */
API int mstpw_set_force_protocol_version(int brh, int version)
{
    if(!br_handle_ok(brh))
        return -1;
    CIST_BridgeConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_protocol_version = true;
    cfg.protocol_version = (protocol_version_t)version;
    return MSTP_IN_set_cist_bridge_config(g_bridges[brh], &cfg);
}

/* Set the CIST bridge timers.  Any argument <= 0 is left unchanged.  Times are
 * validated together (the standard's interdependencies), so on an invalid
 * combination nothing is applied and -1 is returned. */
API int mstpw_set_bridge_times(int brh, int max_age, int forward_delay,
                               int hello_time, int max_hops, int tx_hold_count)
{
    if(!br_handle_ok(brh))
        return -1;
    CIST_BridgeConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    if(max_age > 0)
    {
        cfg.set_bridge_max_age = true;
        cfg.bridge_max_age = (__u8)max_age;
    }
    if(forward_delay > 0)
    {
        cfg.set_bridge_forward_delay = true;
        cfg.bridge_forward_delay = (__u8)forward_delay;
    }
    if(hello_time > 0)
    {
        cfg.set_bridge_hello_time = true;
        cfg.bridge_hello_time = (__u8)hello_time;
    }
    if(max_hops > 0)
    {
        cfg.set_max_hops = true;
        cfg.max_hops = (__u8)max_hops;
    }
    if(tx_hold_count > 0)
    {
        cfg.set_tx_hold_count = true;
        cfg.tx_hold_count = (unsigned int)tx_hold_count;
    }
    return MSTP_IN_set_cist_bridge_config(g_bridges[brh], &cfg);
}

API int mstpw_create_msti(int brh, int mstid)
{
    if(!br_handle_ok(brh))
        return -1;
    bridge_t *br = g_bridges[brh];
    if(!driver_create_msti(br, (__u16)mstid) ||
       !MSTP_IN_create_msti(br, (__u16)mstid))
        return -1;
    return 0;
}

API int mstpw_delete_msti(int brh, int mstid)
{
    if(!br_handle_ok(brh))
        return -1;
    bridge_t *br = g_bridges[brh];
    if(!driver_delete_msti(br, (__u16)mstid) ||
       !MSTP_IN_delete_msti(br, (__u16)mstid))
        return -1;
    return 0;
}

API int mstpw_set_vid2fid(int brh, int vid, int fid)
{
    if(!br_handle_ok(brh))
        return -1;
    return MSTP_IN_set_vid2fid(g_bridges[brh], (__u16)vid, (__u16)fid) ? 0 : -1;
}

API int mstpw_set_fid2mstid(int brh, int fid, int mstid)
{
    if(!br_handle_ok(brh))
        return -1;
    return MSTP_IN_set_fid2mstid(g_bridges[brh], (__u16)fid, (__u16)mstid)
               ? 0 : -1;
}

/* priority is the 0..15 multiplier (actual priority = value * 4096). */
API int mstpw_set_bridge_priority(int brh, int mstid, int priority)
{
    if(!br_handle_ok(brh))
        return -1;
    tree_t *tree = find_tree(g_bridges[brh], mstid);
    if(!tree)
        return -1;
    return MSTP_IN_set_msti_bridge_config(tree, (__u8)priority);
}

API int mstpw_set_port_path_cost(int porth, int mstid, int cost)
{
    if(!port_handle_ok(porth))
        return -1;
    port_t *prt = g_ports[porth].prt;
    if(0 == mstid)
    {
        CIST_PortConfig cfg;
        memset(&cfg, 0, sizeof(cfg));
        cfg.set_admin_external_port_path_cost = true;
        cfg.admin_external_port_path_cost = (__u32)cost;
        return MSTP_IN_set_cist_port_config(prt, &cfg);
    }
    per_tree_port_t *ptp = find_ptp(prt, __cpu_to_be16((__u16)mstid));
    if(!ptp)
        return -1;
    MSTI_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_admin_internal_port_path_cost = true;
    cfg.admin_internal_port_path_cost = (__u32)cost;
    return MSTP_IN_set_msti_port_config(ptp, &cfg);
}

API int mstpw_set_port_admin_edge(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_admin_edge_port = true;
    cfg.admin_edge_port = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

API int mstpw_set_port_auto_edge(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_auto_edge_port = true;
    cfg.auto_edge_port = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

/* p2p: p2pAuto(0), p2pForceTrue(1), p2pForceFalse(2). */
API int mstpw_set_port_admin_p2p(int porth, int p2p)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_admin_p2p = true;
    cfg.admin_p2p = (admin_p2p_t)p2p;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

API int mstpw_set_port_bpdu_guard(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_bpdu_guard_port = true;
    cfg.bpdu_guard_port = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

API int mstpw_set_port_restricted_role(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_restricted_role = true;
    cfg.restricted_role = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

API int mstpw_set_port_restricted_tcn(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_restricted_tcn = true;
    cfg.restricted_tcn = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

API int mstpw_set_port_network(int porth, int yes)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_network_port = true;
    cfg.network_port = !!yes;
    return MSTP_IN_set_cist_port_config(g_ports[porth].prt, &cfg);
}

/* Returns port_role_t for the given tree (0 == CIST), or -1 on error. */
API int mstpw_port_role(int porth, int mstid)
{
    if(!port_handle_ok(porth))
        return -1;
    per_tree_port_t *ptp = find_ptp(g_ports[porth].prt,
                                    __cpu_to_be16((__u16)mstid));
    return ptp ? (int)ptp->role : -1;
}

/* Returns BR_STATE_xxx for the given tree (0 == CIST), or -1 on error. */
API int mstpw_port_state(int porth, int mstid)
{
    if(!port_handle_ok(porth))
        return -1;
    per_tree_port_t *ptp = find_ptp(g_ports[porth].prt,
                                    __cpu_to_be16((__u16)mstid));
    return ptp ? ptp->state : -1;
}

/*
 * All json getters return a malloc'd, NUL-terminated UTF-8 string that the
 * caller must free (the build exports _free for that).
 */

API char *mstpw_bridge_json(int brh)
{
    sb_t s;
    sb_init(&s);
    if(!br_handle_ok(brh))
        sb_printf(&s, "null");
    else
        json_bridge(&s, brh);
    return s.buf;
}

API char *mstpw_port_json(int porth)
{
    sb_t s;
    sb_init(&s);
    if(!port_handle_ok(porth))
        sb_printf(&s, "null");
    else
        json_port(&s, porth);
    return s.buf;
}

API char *mstpw_topology_json(void)
{
    sb_t s;
    sb_init(&s);
    bool first = true;
    sb_printf(&s, "{");
    sb_kv_uint(&s, &first, "frames_delivered", g_frames_delivered);
    sb_key(&s, &first, "bridges");
    sb_printf(&s, "[");
    bool bfirst = true;
    for(int i = 0; i < MSTPW_MAX_BRIDGES; ++i)
    {
        if(!g_bridges[i])
            continue;
        if(!bfirst)
            sb_printf(&s, ",");
        json_bridge(&s, i);
        bfirst = false;
    }
    sb_printf(&s, "]}");
    return s.buf;
}
