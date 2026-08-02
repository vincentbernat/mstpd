# Build MSTPD core as a WebAssembly module.

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

CFLAGS = -O3 -DNO_DAEMON=1 -I. -I$(ROOT) -Icompat \
         -Wno-unused-parameter -Wno-unknown-warning-option
EMFLAGS = \
	-sMODULARIZE=1 \
	-sEXPORT_NAME=createMSTPD \
	-sSINGLE_FILE=1 \
	-sINITIAL_MEMORY=2MB \
	-sALLOW_MEMORY_GROWTH=1 \
	-sENVIRONMENT=web,worker \
	-sEXPORTED_FUNCTIONS=_free \
	-sEXPORTED_RUNTIME_METHODS=$(RUNTIME_METHODS) \
	-sINVOKE_RUN=0 \
	--extern-post-js wrapper.js

.DELETE_ON_ERROR:

# Emit with a .js extension so Emscripten locates itself via
# document.currentScript instead of import.meta.url (which it forces for .mjs
# output). The wrapper's own `export`s keep the renamed file a valid ES module,
# and SINGLE_FILE means there is no companion .wasm to find anyway.
$(DIST)/mstpd.mjs: $(SRCS) $(HDRS) wrapper.js Makefile | $(DIST)
	$(EMCC) $(CFLAGS) $(SRCS) -o $(DIST)/mstpd.js $(EMFLAGS)
	mv $(DIST)/mstpd.js $@

$(DIST):
	mkdir -p $(DIST)

.PHONY: test
test: $(DIST)/mstpd.mjs
	node --test *.test.mjs

.PHONY: clean
clean:
	rm -rf $(DIST)
