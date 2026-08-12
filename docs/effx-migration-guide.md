# effx migration review

Classification: `agent-migration-opt-in-required`

This repository declares an Effect release outside the exact reviewed effx release `4.0.0-beta.107`. The pull request adds the two-stage effx review integration, but it does not change dependencies or application source.

## Required migration review

1. Review every Effect-family dependency against `4.0.0-beta.107`.
2. Supply exact reviewed targets for every `@effect/*` package. Do not guess package versions.
3. Run this repository's package-manager, type, lint, and test checks.
4. Opt in explicitly before an agent changes application source.

## Limits

- No mechanical migration was proven safe from the observed dependency declarations.
- The integration performs syntax and scope enforcement. Effect-specific typed diagnostics remain owned by `@effect/tsgo`.
- The publication workflow uses only artifacts from the unprivileged analysis workflow and binds publication to the immutable pull-request head SHA.
