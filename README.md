# honeyprompt

An LLM-powered honeypot that talks back. Point it at a config file and it stands up believable SSH,
HTTP, TCP, and Telnet services and lets a language model play the part of a real, slightly careless
production host. Attackers poke around what looks like your infrastructure; you capture every
keystroke, credential, and command they try — without exposing a single real system.

It ships as a small container (and a single static binary), and keeps every knob in one
`honeyprompt.yaml`. No plugins to compile, no database to run, no agent to install.

```
 attacker          honeyprompt                    you
─────────      ┌──────────────────┐          ┌───────────┐
 ssh root@ ───▶│  ssh / http /    │──prompt──▶│ llm pool  │
 GET /wp-admin │  tcp / telnet    │◀─reply────│ (failover)│
 PING ────────▶│  decoy services  │          └───────────┘
               └────────┬─────────┘
                        │ events + metrics + logs
                        ▼
           read-only web panel · JSONL on disk · Prometheus
```

## Quick start

You need Docker. Nothing else — not even an API key to begin with.

**1. Write a minimal `honeyprompt.yaml`.** This one needs no LLM and no secrets; it answers a few
SSH commands from static rules:

```yaml
panel:
  enabled: true
  address: "0.0.0.0:8080"

events:
  buffer: 2000
  file: /data/events.jsonl # durable attacker activity

services:
  - protocol: ssh
    address: "0.0.0.0:2222"
    description: "Ubuntu 26.04 LTS build runner"
    serverName: "gpu-runner-07"
    passwordRegex: "^(root|admin|123456)$" # which passwords "work"
    commands:
      - regex: "^whoami$"
        handler: "root"
      - regex: "^(.+)$"
        handler: "bash: command not found"
```

**2. Run it**, mounting your config read-only:

```bash
docker run --rm \
  -p 2222:2222 -p 8080:8080 \
  -v "$(pwd)/honeyprompt.yaml:/etc/honeyprompt/honeyprompt.yaml:ro" \
  -v honeyprompt-data:/data \
  alectrocute/honeyprompt:latest
```

**3. Poke it:**

```bash
ssh -p 2222 root@localhost        # password: root — then type whoami
```

**4. Watch it happen** in the read-only panel at <http://localhost:8080>.

> Pin a numbered release instead of `latest` for production deployments.

### Turning on the LLM

Static rules only get you so far. Add one or more providers, tell a service to defer to them, and
now unmatched commands get a believable, context-aware answer instead of a canned string. Keys are
passed as environment variables and never written into the config file:

```yaml
providers:
  - name: openai
    type: openai
    model: gpt-4o-mini
    apiKeyEnv: OPENAI_API_KEY

services:
  - protocol: ssh
    address: "0.0.0.0:2222"
    description: "Ubuntu 26.04 LTS AI build runner"
    passwordRegex: "^(root|admin|123456)$"
    llm:
      enabled: true
      historyLimit: 20 # remember this many turns per session
      providers: [openai] # pin this service to one provider
    commands:
      - regex: "^whoami$" # answer some commands instantly, for free
        handler: "root"
      - regex: "^(.+)$" # hand everything else to the model
        llm: true
```

```bash
docker run --rm \
  -p 2222:2222 -p 8080:8080 \
  -v "$(pwd)/honeyprompt.yaml:/etc/honeyprompt/honeyprompt.yaml:ro" \
  -v honeyprompt-data:/data \
  -e OPENAI_API_KEY \
  alectrocute/honeyprompt:latest
```

The [`honeyprompt.yaml`](./honeyprompt.yaml) in this repo is a fully annotated 2027-oriented
showcase. It ships profiles for:

- **MCP / agent gateways** — Streamable HTTP discovery, OAuth metadata, JSON-RPC tool calls, and
  tempting production tools.
- **Docker Engine API 29.5** — the unauthenticated port 2375 surface used by real cloud worms.
- **Kubernetes API v1.36** — namespace, workload, Secret, ConfigMap, and RBAC discovery.
- **Ubuntu 26.04 AI build infrastructure** — SSH, GPU workloads, Docker, kubeconfigs, CI state, and
  provider credentials.
- **Redis 8.8** — common RESP probes used for credential theft, persistence, and lateral movement.
- **Industrial edge / OT** — an intentionally legacy Telnet management plane, because modern defense
  still has to catch attacks against old infrastructure.

The versions are contemporary, but the personas intentionally look useful and slightly exposed. A
good decoy should attract interaction, not advertise perfect hardening.

## Deployment

For a persistent deployment, use the included [`compose.yaml`](./compose.yaml). The
[deployment guide](./DEPLOYMENT.md) covers Docker Hub releases, required GitHub secrets, port and
firewall setup, panel access over SSH, upgrades, rollback, event storage, and isolation.

## Why deception, briefly

A honeypot only has to do one thing well: stay convincing long enough that the attacker keeps
typing. Every command they run is intelligence — the tools they reach for, the credentials they
reuse, the CVEs they assume you haven't patched. Static honeypots break character the moment someone
runs a command the author didn't anticipate. honeyprompt hands that moment to an LLM, so the shell
answers `dmesg | tail` or `cat /etc/shadow` the way a real one would, and the session keeps going.

## What gets logged: two separate streams

This is the part worth understanding up front, because the two are deliberately kept apart:

- **Deception events — the honey.** Every attacker interaction: connections, auth attempts, each
  command or request, the response honeyprompt sent back, which provider answered, and how long it
  took. This is your threat intel. It's held in a bounded in-memory buffer for the live panel, and
  you can persist all of it to disk.
- **Operational logs — honeyprompt talking about itself.** Startup, which ports it bound, provider
  failures, shutdown, internal errors. This is what you read when the _runtime_ misbehaves. It has
  nothing to do with attacker activity.

You configure them separately:

```yaml
# The honey: attacker activity.
events:
  buffer: 2000 # recent events kept in memory for the panel
  file: /data/events.jsonl # persist every event as JSON Lines

# The runtime's own diagnostics.
logging:
  level: info # debug | info | warn | error
  format: text # how it looks on the console: text (human) or json
  file: /data/honeyprompt.log # optional; on disk it's always JSON
```

`events.jsonl` is one self-contained JSON object per line — ready to `tail -f`, ship to a SIEM, or
replay with `jq`. The Docker commands above mount the named volume `honeyprompt-data` at `/data`, so
events survive container replacement. Both files are appended to and flushed on a clean shutdown.

`format` only affects how operational logs are rendered to the console; the operational log _file_,
when enabled, is always structured JSON so it's easy to parse.

## The web panel

![screenshot](./src/panel/assets/screenshot.png)

An optional, **read-only** dashboard streams deception events as they happen, breaks them down by
protocol, and exports everything to JSON with one click:

```yaml
panel:
  enabled: true
  address: "0.0.0.0:8080"
  auth: # optional basic auth
    username: admin
    password: "${HONEYPROMPT_PANEL_PASSWORD}"
```

You give the password in plaintext and honeyprompt handles the rest — no `htpasswd`, no manual
hashing. The comparison is constant-time so the auth check doesn't leak. The dashboard is plain
HTML, CSS, and JavaScript ([`src/panel/assets`](./src/panel/assets)) embedded into the binary — no
bundler, no framework.

## Providers

Each provider is its own module with its own timeouts, retries, rate limits, and headers. Keys come
from the environment. Out of the box:

| Provider               | `type`              | Notes                                         |
| ---------------------- | ------------------- | --------------------------------------------- |
| Ollama                 | `ollama`            | Local models; defaults to `localhost:11434`   |
| llama.cpp              | `llamacpp`          | Local `server` OpenAI endpoint                |
| OpenAI                 | `openai`            | `OPENAI_API_KEY`                              |
| Azure OpenAI           | `azure`             | needs `azure.deployment` + `azure.apiVersion` |
| OpenRouter             | `openrouter`        | `OPENROUTER_API_KEY`                          |
| Anthropic              | `anthropic`         | `ANTHROPIC_API_KEY`                           |
| Google Gemini          | `google`            | `GEMINI_API_KEY`                              |
| Anything OpenAI-shaped | `openai-compatible` | point `baseUrl` at your gateway               |

### Load balancing and failover

List the providers you trust, pick a `pool.strategy` (`round-robin`, `weighted`, `random`, or
`failover`), and honeyprompt spreads traffic across them. If the chosen provider times out or
returns a retryable error, honeyprompt transparently falls over to the next one — a dead backend
never takes the honeypot offline. Non-retryable errors (a bad API key, say) stop the cascade so you
find out instead of silently draining quota.

Services use the global pool unless they name their own provider subset:

```yaml
llm:
  enabled: true
  providers: [local-ollama] # one name: force this service to this provider
```

List several names to keep load balancing and failover, but only within that subset:

```yaml
llm:
  enabled: true
  providers: [openai-primary, openrouter-backup]
```

## Extending responses with hooks

When "match a regex" or "ask the model" isn't enough, hooks let you splice your own TypeScript into
the request and response path. A hook can rewrite the prompt before it reaches the model, or rewrite
the reply before it reaches the attacker.

```ts
import { registerHook } from "./src/engine/hooks.ts";

registerHook({
  name: "fake-latency-notice",
  transformResponse(response, ctx) {
    if (ctx.protocol === "ssh" && /rm -rf/.test(ctx.input)) {
      return "rm: cannot remove '/': Operation not permitted\n";
    }
    return response;
  },
});
```

Reference it by name from any service's `hooks:` list. A built-in `redact-secrets` hook ships
enabled in the example config so the model can never echo a real credential back out.

## Metrics

Prometheus metrics are served at `/metrics` on the panel (unauthenticated, so scrapers just work):

```
honeyprompt_events_total{protocol="ssh"}                          412
honeyprompt_llm_requests_total{provider="openai",protocol="ssh"}  118
honeyprompt_auth_attempts_total{protocol="ssh"}                    87
honeyprompt_engine_errors_total{protocol="http"}                   0
```

## Built to sit still and stay cheap

A honeypot spends most of its life idle and occasionally gets hammered. honeyprompt is built for
both: async I/O throughout, a bounded in-memory event buffer (it never grows without limit),
token-bucket rate limiting per provider so a flood of connections can't run up your LLM bill, capped
request-body reads so a hostile upload can't exhaust memory, and per-connection idle deadlines that
reap abandoned sessions. Static-rule responses never touch the network at all. Idle, it costs you a
few megabytes of RAM and no CPU.

## Build from source

Contributing, or want a native binary? You'll need [Deno](https://deno.com) 2.x — the only
dependency.

```bash
deno task check    # type-check
deno task lint
deno task fmt
deno task test     # unit + integration tests

deno task start -- --config honeyprompt.yaml    # run locally
deno task dev   -- --config honeyprompt.yaml    # run with file watching
deno task compile                                # -> ./dist/honeyprompt (self-contained binary)
```

`deno compile` bakes the runtime, panel assets, and all into one executable with no dependencies.
Prebuilt binaries for Linux, macOS, and Windows are attached to every tagged
[release](../../releases).

CI runs formatting, lint, type-check, tests, config validation, a cross-platform `compile`, and a
Docker build on every push. Tagging `vX.Y.Z` cuts release binaries and publishes the provenance- and
SBOM-attested multi-arch image to
[`alectrocute/honeyprompt`](https://hub.docker.com/r/alectrocute/honeyprompt).

## CLI

```
honeyprompt run [--config <path>]        start every configured service (default)
honeyprompt validate [--config <path>]   parse and validate config, then exit — great for CI
honeyprompt version
honeyprompt help
```

`--config` defaults to `./honeyprompt.yaml`, or `$HONEYPROMPT_CONFIG` if set (the container sets it
to `/etc/honeyprompt/honeyprompt.yaml`).

## A word of warning

This is a tool for luring and studying attackers on infrastructure **you own or are authorized to
test**. Exposing decoy services still means exposing services; run it on isolated hosts, keep it
patched, and don't point it at anything you can't afford to have probed. Deception is not a
substitute for actually securing the real thing.

## License

[MIT](./LICENSE). Take it, fork it, make it yours.
