---
summary: Supply production deployment configuration through SecretSpec and SOPS/age without plaintext secret files.
status: approved-design
approved_design: 2026-08-10
implementation: not-started
change_policy: Semantic changes require operator approval and an explicit specification revision.
---

# 0004 — Encrypted deployment configuration

## Goal

Deploy the Cloudflare Environment graph without storing or logging plaintext credentials. One SecretSpec production profile defines every required deployment input. SOPS ciphertext is the repository-visible source; an age private identity remains in the operator's system keyring.

## Authority and flow

```text
system keyring (age private identity)
              +
repository SOPS ciphertext (deployment values)
              |
              v
SecretSpec production profile
              |
              v
process environment, scoped to one command
              |
              v
Effect Config validation in infra/alchemy.run.ts
              |
              v
Alchemy Cloudflare deployment
              |
              v
Worker secret bindings and non-secret configuration
```

- SecretSpec owns provider resolution and command-scoped injection.
- SOPS owns encryption at rest.
- The system keyring is the sole authority for the age private identity.
- Effect `Config` is the sole application boundary for decoded deployment values.
- Alchemy receives `Config.redacted` values for secrets and writes runtime secrets through Cloudflare APIs.
- No `.env`, decrypted file, shell interpolation, console output, or committed plaintext is permitted.

## Required production values

Secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUD_TASK_AUTH_TOKEN`
- `CLOUD_TASK_ROUTER_SECRET`
- `ENVIRONMENT_ROUTER_SECRET`
- `CREDENTIAL_BROKER_SECRET`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

Non-secret deployment configuration, encrypted with the same profile to keep one injection path:

- `CLOUDFLARE_ACCOUNT_ID`
- `WORK_ENGINE_DOMAIN`
- `CREDENTIAL_BROKER_URL`
- `ENVIRONMENT_PUBLIC_ORIGIN`
- `ENVIRONMENT_IMAGE_DIGEST`

## Deployment interface

The repository exposes bounded commands for:

1. checking that the production profile resolves every required value;
2. producing an Alchemy plan;
3. deploying the graph;
4. running the real 0003 tracer.

Each command runs beneath `secretspec run --profile production`. The TypeScript deployment graph continues to consume values only through Effect v4 `Config`; scripts do not read `process.env` directly.

## Failure and evidence

- Missing SecretSpec, SOPS, age identity, profile value, or Effect Config value fails before provider mutation.
- Planning and deployment errors remain structured Effect/Alchemy failures.
- Logs may name missing keys but never values.
- The committed encrypted document must remain SOPS-decryptable and contain no plaintext deployment values.
- Deployment is accepted only after the real create, connect, checkpoint, forced-loss recovery, and destroy tracer succeeds against Cloudflare.

## Non-goals

- Creating provider credentials automatically.
- Storing credentials in repository plaintext, `.env`, shell history, or Alchemy state.
- Replacing Cloudflare runtime secret bindings with direct application access to SOPS.
- Supporting multiple secret backends before the production tracer passes.
