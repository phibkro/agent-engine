import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as BunPath from "@effect/platform-bun/BunPath";
import { Effect, FileSystem, Option, Path } from "effect";

export interface PlatformFileInspection {
  readonly uid: number;
  readonly mode: number;
}

const provideFileSystem = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
): Effect.Effect<A, E> => Effect.provide(effect, BunFileSystem.layer);

export const readTextFile = (path: string) =>
  provideFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.readFileString(path);
    }),
  );

export const inspectFile = (path: string): Effect.Effect<PlatformFileInspection, unknown> =>
  provideFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const metadata = yield* fileSystem.stat(path);
      return {
        uid: Option.getOrElse(metadata.uid, () => -1),
        mode: metadata.mode & 0o777,
      };
    }),
  );

export const makeDirectory = (path: string) =>
  provideFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 });
    }),
  );

export const writeTextFileExclusive = (path: string, content: string) =>
  provideFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(path, content, { flag: "wx", mode: 0o600 });
    }),
  );

export const removeFile = (path: string) =>
  provideFileSystem(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(path);
    }),
  );

export const resolvePath = (...parts: ReadonlyArray<string>): Effect.Effect<string> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.resolve(...parts);
  }).pipe(Effect.provide(BunPath.layer));

export const currentUid = (): number => {
  const result = Bun.spawnSync(["id", "-u"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return -1;
  const parsed = Number(new TextDecoder().decode(result.stdout).trim());
  return Number.isSafeInteger(parsed) ? parsed : -1;
};

export const environment = (): Readonly<Record<string, string | undefined>> => Bun.env;
