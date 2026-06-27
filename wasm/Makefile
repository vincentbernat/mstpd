# Build the mstpd MSTP core as a WebAssembly module.

EMCC ?= emcc

ROOT = ..
DIST = dist

# Core MSTP sources plus the WASM harness.
SRCS = $(ROOT)/mstp.c $(ROOT)/hmac_md5.c $(ROOT)/driver_deps.c wasm_api.c
HDRS = config.h \
       $(wildcard compat/linux/*.h compat/asm/*.h) \
       $(ROOT)/mstp.h $(ROOT)/log.h $(ROOT)/list.h $(ROOT)/driver.h \
       $(ROOT)/bridge_ctl.h $(ROOT)/clock_gettime.h

# Runtime helpers JS needs to marshal arguments and read returned strings.
RUNTIME_METHODS = ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8,HEAPU8

CFLAGS = -O3 -DNO_DAEMON=1 -I. -I$(ROOT) -Icompat -Wno-unused-parameter
EMFLAGS = \
	-sMODULARIZE=1 \
	-sEXPORT_ES6=1 \
	-sEXPORT_NAME=createMstpd \
	-sALLOW_MEMORY_GROWTH=1 \
	-sENVIRONMENT=node,web \
	-sEXPORTED_FUNCTIONS=_free \
	-sEXPORTED_RUNTIME_METHODS=$(RUNTIME_METHODS) \
	-sINVOKE_RUN=0

.DELETE_ON_ERROR:

$(DIST)/mstpd.mjs: $(SRCS) $(HDRS) Makefile | $(DIST)
	$(EMCC) $(CFLAGS) $(SRCS) -o $@ $(EMFLAGS)

$(DIST):
	mkdir -p $(DIST)

.PHONY: test
test: $(DIST)/mstpd.mjs
	node --test *.test.mjs

.PHONY: clean
clean:
	rm -rf $(DIST)
