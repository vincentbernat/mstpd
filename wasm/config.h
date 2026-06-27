/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * Hand-written config.h for the Emscripten/WASM build.
 *
 * The autotools build generates this file via ./configure; the WASM build does
 * not run configure, so we provide the handful of macros the sources expect.
 */
#ifndef _MSTPD_WASM_CONFIG_H
#define _MSTPD_WASM_CONFIG_H

/* Emscripten's libc provides both of these. */
#define HAVE_CLOCK_GETTIME   1
#define HAVE_STRUCT_TIMESPEC 1

#define PACKAGE_VERSION "mstpd-wasm"
#define PACKAGE_BUILD   "wasm"

#endif /* _MSTPD_WASM_CONFIG_H */
