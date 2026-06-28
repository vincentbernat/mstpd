/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * wasm_api.c - WebAssembly harness around the mstpd MSTP core.
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

/* Bridge and port registries */

#define MSTPW_MAX_BRIDGES 256
#define MSTPW_MAX_PORTS   4096

typedef struct
{
    port_t *prt;     /* NULL marks a free slot */
    int brh;         /* owning bridge handle */
    int peer;        /* linked peer port handle, or -1 */
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
    int dst;     /* destination port handle */
    int len;     /* BPDU length in bytes */
    unsigned char data[];
} frame_t;

static frame_t *g_q_head, *g_q_tail;
static unsigned long g_frames_delivered;

static void frame_enqueue(int dst, const void *data, int len)
{
    frame_t *f = malloc(sizeof(*f) + len);
    if(!f)
        return;
    f->next = NULL;
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

/* Safety cap: convergence of a sane topology empties the queue quickly. */
#define MSTPW_DELIVER_CAP 2000000UL

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
    sb_kv_bool(s, &first, "oper_edge", st.oper_edge_port);
    sb_kv_bool(s, &first, "oper_p2p", st.oper_p2p);
    sb_kv_bool(s, &first, "send_rstp", st.sendRSTP);
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
    if(!port_handle_ok(porth))
        return;
    int peer = g_ports[porth].peer;
    if(peer < 0 || !port_handle_ok(peer))
        return; /* unconnected link: frame is lost */
    if(!g_ports[peer].prt->sysdeps.up)
        return;

    frame_enqueue(peer, bpdu, size);
}

void MSTP_OUT_shutdown_port(port_t *prt)
{
    /* BPDU-guard / errdisable: take the port administratively down. */
    prt->sysdeps.up = false;
    MSTP_IN_set_port_enable(prt, false, 0, 0);
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
            if(g_ports[i].peer >= 0 && port_handle_ok(g_ports[i].peer))
                g_ports[g_ports[i].peer].peer = -1;
            MSTP_IN_delete_port(g_ports[i].prt);
            free(g_ports[i].prt);
            g_ports[i].prt = NULL;
            g_ports[i].peer = -1;
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
    prt->sysdeps.up = !!up;
    MSTP_IN_set_port_enable(prt, !!up, prt->sysdeps.speed, prt->sysdeps.duplex);
    return 0;
}

API int mstpw_port_delete(int porth)
{
    if(!port_handle_ok(porth))
        return -1;
    if(g_ports[porth].peer >= 0 && port_handle_ok(g_ports[porth].peer))
        g_ports[g_ports[porth].peer].peer = -1;
    MSTP_IN_delete_port(g_ports[porth].prt);
    free(g_ports[porth].prt);
    g_ports[porth].prt = NULL;
    g_ports[porth].peer = -1;
    return 0;
}

/* Connect two ports with a virtual cable: each one's transmitted BPDUs are
 * delivered to the other.  Re-linking transparently detaches old peers. */
API int mstpw_link(int a, int b)
{
    if(!port_handle_ok(a) || !port_handle_ok(b) || a == b)
        return -1;
    if(g_ports[a].peer >= 0 && port_handle_ok(g_ports[a].peer))
        g_ports[g_ports[a].peer].peer = -1;
    if(g_ports[b].peer >= 0 && port_handle_ok(g_ports[b].peer))
        g_ports[g_ports[b].peer].peer = -1;
    g_ports[a].peer = b;
    g_ports[b].peer = a;
    return 0;
}

API int mstpw_unlink(int porth)
{
    if(!port_handle_ok(porth))
        return -1;
    int peer = g_ports[porth].peer;
    if(peer >= 0 && port_handle_ok(peer))
        g_ports[peer].peer = -1;
    g_ports[porth].peer = -1;
    return 0;
}

/* Deliver all queued BPDUs (and any generated in response) until quiescent. */
API void mstpw_deliver(void)
{
    frame_t *f;
    unsigned long guard = 0;
    while((f = frame_dequeue()))
    {
        if(++guard > MSTPW_DELIVER_CAP)
        {
            ERROR("mstpw_deliver: frame cap reached, topology not converging?");
            free(f);
            while((f = frame_dequeue()))
                free(f);
            break;
        }
        if(port_handle_ok(f->dst) && g_ports[f->dst].prt->sysdeps.up)
        {
            ++g_frames_delivered;
            MSTP_IN_rx_bpdu(g_ports[f->dst].prt, (bpdu_t *)f->data, f->len);
        }
        free(f);
    }
}

/* Advance the whole simulation by `seconds`, delivering BPDUs after each tick. */
API void mstpw_step(int seconds)
{
    for(int i = 0; i < seconds; ++i)
    {
        for(int j = 0; j < MSTPW_MAX_BRIDGES; ++j)
            if(g_bridges[j] && g_bridges[j]->stp_enabled)
                MSTP_IN_one_second(g_bridges[j]);
        mstpw_deliver();
    }
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

API int mstpw_set_port_admin_edge(int porth, int edge)
{
    if(!port_handle_ok(porth))
        return -1;
    CIST_PortConfig cfg;
    memset(&cfg, 0, sizeof(cfg));
    cfg.set_admin_edge_port = true;
    cfg.admin_edge_port = !!edge;
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
