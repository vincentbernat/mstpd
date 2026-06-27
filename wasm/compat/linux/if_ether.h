/* SPDX-License-Identifier: GPL-2.0-or-later */
#ifndef _MSTPD_WASM_LINUX_IF_ETHER_H
#define _MSTPD_WASM_LINUX_IF_ETHER_H

#include <linux/types.h>

#define ETH_ALEN      6     /* Octets in one ethernet addr   */
#define ETH_HLEN      14    /* Total octets in header.       */
#define ETH_ZLEN      60    /* Min. octets in frame sans FCS */
#define ETH_DATA_LEN  1500  /* Max. octets in payload        */
#define ETH_FRAME_LEN 1514  /* Max. octets in frame sans FCS */

#endif /* _MSTPD_WASM_LINUX_IF_ETHER_H */
