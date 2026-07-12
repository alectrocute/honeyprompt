# Deploying honeyprompt

The public image is `alectrocute/honeyprompt` on Docker Hub. Release tags are built for Linux
`amd64` and `arm64`.

## Publish releases from GitHub Actions

This repository publishes the image when a tag matching `v*` is pushed.

1. Create the public Docker Hub repository `alectrocute/honeyprompt`.
2. In Docker Hub, create a personal access token with **Read & Write** permission. Use a dedicated
   automation token rather than your account password.
3. In the GitHub repository, open **Settings → Secrets and variables → Actions** and add:
   - Name: `DOCKERHUB_TOKEN`
   - Value: the Docker Hub access token
4. Push a semantic version tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

The release workflow publishes:

- `alectrocute/honeyprompt:0.1.0`
- `alectrocute/honeyprompt:0.1`
- `alectrocute/honeyprompt:latest`

It also attaches provenance and an SBOM to the multi-architecture image. Pull requests and ordinary
pushes only build the image in CI; they never publish it.

## Deploy with Docker Compose

The included [`compose.yaml`](./compose.yaml) starts every decoy from the annotated
[`honeyprompt.yaml`](./honeyprompt.yaml), persists attacker events, and keeps the operator panel
bound to the host's loopback interface.

Copy the environment template and replace the placeholder values:

```bash
cp .env.example .env
chmod 600 .env
```

At minimum, set:

```dotenv
HONEYPROMPT_IMAGE=alectrocute/honeyprompt:0.1.0
OPENROUTER_API_KEY=your-dedicated-provider-key
HONEYPROMPT_PANEL_PASSWORD=use-a-long-random-password
```

Use a dedicated LLM key with a strict spend limit. Do not reuse a production application key.

Validate and start the deployment:

```bash
docker compose config
docker compose pull
docker compose up -d
```

Check readiness and startup logs:

```bash
docker compose ps
docker compose logs -f honeyprompt
curl http://127.0.0.1:9090/healthz
```

The panel is deliberately published only on `127.0.0.1:9090`. On a remote host, reach it through an
SSH tunnel:

```bash
ssh -L 9090:127.0.0.1:9090 user@honeypot-host
```

Then open <http://127.0.0.1:9090> and sign in as `admin` with `HONEYPROMPT_PANEL_PASSWORD`.

Attacker events are appended to `/data/events.jsonl` in the `honeyprompt-data` named volume. To
inspect them:

```bash
docker compose exec honeyprompt sh -c 'tail -f /data/events.jsonl'
```

## Network exposure

The provided Compose file publishes the default decoys:

- `80/tcp` — generic corporate web decoy
- `2222/tcp` — SSH build runner
- `2323/tcp` — OT Telnet management
- `2375/tcp` — Docker Engine API
- `6379/tcp` — Redis
- `8000/tcp` — MCP agent gateway
- `8001/tcp` — Kubernetes API proxy
- `127.0.0.1:9090/tcp` — operator panel

Remove any port you do not intend to expose. Cloud security groups and host firewalls must allow the
decoy ports, while the panel should remain private.

## Upgrade or roll back

Pin `HONEYPROMPT_IMAGE` to an immutable release tag instead of `latest`, then redeploy:

```bash
docker compose pull
docker compose up -d
```

To roll back, restore the previous tag in `.env` and run the same commands. The named data volume is
retained across container replacement.

## Isolation guidance

Run honeyprompt on an isolated host or network segment with no route to production systems. Do not
mount the Docker socket, host filesystem, SSH keys, cloud credentials, or real application data into
the container. Persist `events.jsonl` (or forward it with a collector), and/or configure an outbound
sink such as CrowdStrike HEC under `events.sinks`. Monitor provider spending and sink delivery
errors in the operational logs / Prometheus metrics (`honeyprompt_sink_events_total`,
`honeyprompt_sink_dropped_total`).
