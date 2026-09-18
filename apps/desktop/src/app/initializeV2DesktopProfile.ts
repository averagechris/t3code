import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DesktopProfileInitializationError extends Schema.TaggedError<V2DesktopProfileInitializationError>()(
  "V2DesktopProfileInitializationError",
  { destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not preserve Windows credential encryption for the V2 desktop profile at ${this.destinationPath}.`;
  }
}

/** Preserve Windows safeStorage keys without sharing Chromium's locked databases. */
export const initializeV2DesktopProfile = Effect.fn("initializeV2DesktopProfile")(function* (
  appDataDirectory: string,
  legacyUserDataDirName: string,
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.gen(function* () {
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* fs.exists(destinationState)) return;
    const legacyPath = path.join(appDataDirectory, legacyUserDataDirName);
    const sourcePath = (yield* fs.exists(legacyPath))
      ? legacyPath
      : path.join(appDataDirectory, "t3code");
    const sourceState = path.join(sourcePath, "Local State");
    if (!(yield* fs.exists(sourceState))) return;
    const state = yield* fs.readFileString(sourceState);
    yield* fs.makeDirectory(destinationPath, { recursive: true });
    yield* fs
      .writeFileString(destinationState, state, { flag: "wx" })
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.mapError((cause) => new V2DesktopProfileInitializationError({ destinationPath, cause })),
  );
});
