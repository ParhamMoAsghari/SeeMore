# seemore — common tasks. `make help` lists them.
SHELL := /bin/sh
COMPOSE ?= docker compose

.PHONY: help bootstrap host host-uninstall build up down restart ps logs config panel test test-unit test-integration lint scan backup
help:            ## list targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/' | expand -t 20

bootstrap:       ## .env, docker network, directories and permissions (install.sh)
	sh install.sh
host:            ## install host components: USB auto-mount + seemore-ctl (sudo)
	sudo sh host/install.sh --all --dir "$(CURDIR)"
host-uninstall:  ## remove host components (sudo)
	sudo sh host/uninstall.sh
build:           ## build the seemore image (panel + core)
	$(COMPOSE) build seemore
up:              ## start everything in COMPOSE_PROFILES
	$(COMPOSE) up -d
down:            ## stop the stack
	$(COMPOSE) down
restart:         ## restart seemore only
	$(COMPOSE) restart seemore
ps:              ## container status
	$(COMPOSE) ps
logs:            ## follow seemore logs
	$(COMPOSE) logs -f --tail=200 seemore
config:          ## validate + print the effective compose config (secrets included: do not paste it anywhere)
	$(COMPOSE) config --quiet && echo "compose config OK"
panel:           ## build the React panel into app/public (for running the core without Docker)
	cd panel && npm ci --no-audit --no-fund && npm run build
test: lint test-unit test-integration  ## all offline tests
test-unit:       ## unit tests (Telegram/Bale adapters against the mock Bot API)
	cd app && node --test 'tests/unit/*.test.js'
test-integration: ## core process end-to-end against the mock Telegram API
	cd app && node --test 'tests/integration/*.test.js'
lint:            ## syntax checks (JS, Python, shell)
	@for f in $$(find app -name '*.js' -not -path '*/node_modules/*' -not -path 'app/public/*'); do node --check $$f || exit 1; done
	@python3 -m py_compile subfa/app/subfa.py host/seemore-ctl/seemore-ctl
	@for f in install.sh host/install.sh host/uninstall.sh host/usb-automount/usb-automount; do sh -n $$f 2>/dev/null || bash -n $$f || exit 1; done
	@echo "lint OK"
scan:            ## secret scan of the working tree and git history (needs gitleaks)
	gitleaks detect --source . --config .gitleaks.toml --redact --verbose
backup:          ## take a DB backup now (also runs daily)
	$(COMPOSE) exec seemore node bot.js --backup
