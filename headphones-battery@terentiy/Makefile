SHELL := /bin/bash
.DELETE_ON_ERROR:

CC ?= gcc
NODE ?= node
GJS ?= gjs
BUILD_DIR ?= build
CPPFLAGS += -D_FORTIFY_SOURCE=2
CFLAGS ?= -O2
HP_WARNINGS := -std=c11 -Wall -Wextra -Werror -Wpedantic -Wformat=2 -Wshadow
HP_HARDENING := -fstack-protector-strong -fPIE
HP_LINK := -pie -Wl,-z,relro,-z,now
HELPER := $(BUILD_DIR)/headphones-battery-aap-helper
PURE_TESTS := tests/test-bluez.js tests/test-battery.js tests/test-estimator.js tests/test-registry.js
NODE_TESTS := $(PURE_TESTS) tests/test-presentation.js tests/test-extension.js
JS_SOURCES := $(wildcard *.js tests/*.js tests/fixtures/*.js tests/mocks/*.js)

.PHONY: all native check check-node check-js test test-js test-gjs test-native test-sanitize test-install lint install doctor

all: native
native: $(HELPER)

$(BUILD_DIR):
	mkdir -p -- "$@"

$(HELPER): headphones-battery-aap-helper.c | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(HP_WARNINGS) $(HP_HARDENING) $(HP_LINK) -o "$@" "$<"

$(BUILD_DIR)/test-aap: tests/test-aap.c headphones-battery-aap-helper.c | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(HP_WARNINGS) $(HP_HARDENING) $(HP_LINK) -o "$@" "$<"

$(BUILD_DIR)/test-aap-sanitize: tests/test-aap.c headphones-battery-aap-helper.c | $(BUILD_DIR)
	$(CC) -O1 -g3 $(HP_WARNINGS) -fsanitize=address,undefined -fno-sanitize-recover=all -fno-omit-frame-pointer -o "$@" "$<"

check-node:
	@$(NODE) -e 'if (typeof require("node:module").registerHooks !== "function") { console.error("Development tests require Node.js with module.registerHooks (Node 22.15+ or Node 24 LTS). Node is not needed by the installed extension."); process.exit(1); }'

check-js: check-node
	@set -e; for file in $(JS_SOURCES); do $(NODE) --check "$$file"; done

test-js: check-node
	@set -e; for file in $(NODE_TESTS); do $(NODE) "$$file"; done

test-gjs:
	@set -e; for file in $(PURE_TESTS); do $(GJS) -m "$$file"; done
	$(GJS) -m tests/test-pet-gjs.js
	$(GJS) -m tests/test-aap-session.js
	$(GJS) -m tests/test-state-store.js
	dbus-run-session -- $(GJS) -m tests/test-bluez-dbus.js

test-native: $(BUILD_DIR)/test-aap
	"$(BUILD_DIR)/test-aap"

test-sanitize: $(BUILD_DIR)/test-aap-sanitize
	ASAN_OPTIONS=detect_leaks=1 "$(BUILD_DIR)/test-aap-sanitize"

test-install:
	bash tests/test-install.sh

test: check-js test-js test-gjs test-native test-install

lint:
	shellcheck -x scripts/*.sh tests/test-install.sh
	$(CC) $(CPPFLAGS) -O2 $(HP_WARNINGS) -fanalyzer -fsyntax-only headphones-battery-aap-helper.c

check: test lint test-sanitize

install:
	bash scripts/install.sh

doctor:
	bash scripts/doctor.sh
