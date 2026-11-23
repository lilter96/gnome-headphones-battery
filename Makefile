.PHONY: check test native install doctor
check:
	$(MAKE) -C headphones-battery@terentiy check
	gjs -m tests/run.js

test:
	$(MAKE) -C headphones-battery@terentiy test
	gjs -m tests/run.js

native install doctor:
	$(MAKE) -C headphones-battery@terentiy $@
