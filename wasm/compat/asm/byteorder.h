/* SPDX-License-Identifier: GPL-2.0-or-later */
/*
 * WebAssembly is always little-endian, so the host<->big-endian helpers are
 * byte swaps and the host<->little-endian helpers are no-ops.
 */
#ifndef _MSTPD_WASM_ASM_BYTEORDER_H
#define _MSTPD_WASM_ASM_BYTEORDER_H

#include <linux/types.h>

#define __cpu_to_be16(x) ((__be16)__builtin_bswap16((__u16)(x)))
#define __cpu_to_be32(x) ((__be32)__builtin_bswap32((__u32)(x)))
#define __cpu_to_be64(x) ((__be64)__builtin_bswap64((__u64)(x)))
#define __be16_to_cpu(x) ((__u16)__builtin_bswap16((__u16)(x)))
#define __be32_to_cpu(x) ((__u32)__builtin_bswap32((__u32)(x)))
#define __be64_to_cpu(x) ((__u64)__builtin_bswap64((__u64)(x)))

#define __constant_cpu_to_be16(x) __cpu_to_be16(x)
#define __constant_cpu_to_be32(x) __cpu_to_be32(x)
#define __constant_cpu_to_be64(x) __cpu_to_be64(x)
#define __constant_be16_to_cpu(x) __be16_to_cpu(x)
#define __constant_be32_to_cpu(x) __be32_to_cpu(x)
#define __constant_be64_to_cpu(x) __be64_to_cpu(x)

#define __cpu_to_le16(x) ((__le16)(__u16)(x))
#define __cpu_to_le32(x) ((__le32)(__u32)(x))
#define __cpu_to_le64(x) ((__le64)(__u64)(x))
#define __le16_to_cpu(x) ((__u16)(__le16)(x))
#define __le32_to_cpu(x) ((__u32)(__le32)(x))
#define __le64_to_cpu(x) ((__u64)(__le64)(x))

#endif /* _MSTPD_WASM_ASM_BYTEORDER_H */
