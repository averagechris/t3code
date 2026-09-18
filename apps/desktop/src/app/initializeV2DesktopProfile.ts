import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class V2DesktopProfileInitializationError extends Schema.TaggedError<V2DesktopProfileInitializationError>()(
  "V2DesktopProfileInitializationError",
  {
    operation: Schema.Literals(["inspect", "read", "create-directory", "write"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not preserve Windows credential encryption during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: V2DesktopProfileInitializationError["operation"],
    resourcePath: string,
  ) {
    return new V2DesktopProfileInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
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
  const inspect = (resourcePath: string) =>
    fs
      .exists(resourcePath)
      .pipe(
        Effect.mapError((cause) =>
          V2DesktopProfileInitializationError.fromFileSystem(cause, "inspect", resourcePath),
        ),
      );
  const destinationState = path.join(destinationPath, "Local State");
  if (yield* inspect(destinationState)) return;
  const legacyPath = path.join(appDataDirectory, legacyUserDataDirName);
  const sourcePath = (yield* inspect(legacyPath))
    ? legacyPath
    : path.join(appDataDirectory, "t3code");
  const sourceState = path.join(sourcePath, "Local State");
  if (!(yield* inspect(sourceState))) return;
  const state = yield* fs
    .readFileString(sourceState)
    .pipe(
      Effect.mapError((cause) =>
        V2DesktopProfileInitializationError.fromFileSystem(cause, "read", sourceState),
      ),
    );
  yield* fs
    .makeDirectory(destinationPath, { recursive: true })
    .pipe(
      Effect.mapError((cause) =>
        V2DesktopProfileInitializationError.fromFileSystem(
          cause,
          "create-directory",
          destinationPath,
        ),
      ),
    );
  yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
    Effect.catch((error) =>
      error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
    ),
    Effect.mapError((cause) =>
      V2DesktopProfileInitializationError.fromFileSystem(cause, "write", destinationState),
    ),
  );
});
