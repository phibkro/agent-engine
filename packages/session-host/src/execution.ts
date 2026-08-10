import type * as Effect from "effect/Effect";

/**
 * The only capability allowed to close an Effect in the session-host package.
 * The container composition root supplies the live Bun runner; libraries and
 * adapters keep their Effect requirements visible until that boundary.
 */
export interface EffectExecutor {
  readonly execute: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
}
