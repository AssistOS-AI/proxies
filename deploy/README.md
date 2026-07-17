# Proxy Gateway Deployment (runtime v5)

The legacy `deploy.sh` helper is intentionally disabled. It exits before
reading `setEnv.sh`, touching local secret material, or contacting a remote
host. This checkout has no reviewed immutable Kiro or Antigravity runtime-v5
agent artifacts, so it cannot safely perform deployment.

Edge publication is owned by the Ploinky runtime-v5 box. This repository does
not install, configure, start, stop, or mutate a standalone connector, DNS
record, public hostname, or tunnel. A deployment remains local-only until the
box owner has a complete, separately authorized publication configuration.

## Operator prerequisite

A replacement deployment path requires all of the following:

- reviewed immutable runtime-v5 agent images and slim manifests;
- authenticated Router services and Ploinky operator lifecycle control;
- a reviewed secret provider that does not place credential values in output,
  command arguments, generated scripts, status, or artifacts; and
- root-only (`0600`) secret files if the provider must materialize a file.

Do not provide credentials to `deploy.sh`. It has no activation path.

The remaining environment template is only for the separate interactive OAuth
authentication helper after an operator has provisioned an approved runtime-v5
deployment:

```bash
cd proxies/deploy
cp setEnv.sh.example setEnv.sh
```

Configure only `REMOTE_HOST`, `REMOTE_USER`, `SSH_KEY_PATH`, and any optional
process-local OAuth callback ports. Keep `setEnv.sh` untracked.

## Disabled deployment

```bash
chmod +x deploy.sh
./deploy.sh
```

This command always returns a nonzero status before reading configuration or
performing network access. Do not bypass that guard or copy the retired remote
setup logic into another workflow.

After a separately reviewed deployment exists, authenticate each gateway
through the interactive helper:

```bash
./auth-gateways.sh
```

Publication, DNS, and external verification must be performed by the Ploinky
box workflow with dedicated test or operator-approved resources. Invalid or
incomplete public mode must fail closed and must not change the selected mode.

## Verify

On the remote host:

```bash
cd ~/proxy-gateway/workspace
ploinky status
```

Then exercise each service through its current Router locator. Do not address a
private target port from a browser or add a physical-host publication to an
agent manifest.

The `deploy-cliProxy.yml` workflow uses only local Ploinky operator commands for
status, stop, and restart. Its `deploy` action creates a redacted candidate
record and then fails closed: this checkout does not contain a tracked
`cliproxyapi-gateway/manifest.json`, and runtime v5 has no safe direct-port or
mutable-container activation path. The separate in-container update workflow
is intentionally disabled until an immutable image and authenticated operator
flow are reviewed.

The Copilot, Search, and Kiro deployment workflows are also intentionally
disabled before any remote access. Their expected runtime-v5 agent manifests
are not tracked in this checkout, while their former workflows depended on
stable direct target ports (and, for Search, plaintext secret staging). They
must remain fail-closed until each service has a reviewed immutable image,
slim manifest, authenticated Router service, and operator-controlled lifecycle.
