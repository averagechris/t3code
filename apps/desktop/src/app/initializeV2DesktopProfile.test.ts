import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { initializeV2DesktopProfile } from "./initializeV2DesktopProfile.ts";

for (const sourceName of ["t3code", "T3 Code (Alpha)"]) {
  it.effect(
    `preserves Windows credential keys from ${sourceName} without copying browser databases`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
        const source = path.join(directory, sourceName);
        const destination = path.join(directory, "t3code-v2");
        const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
        yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
        yield* fs.writeFileString(path.join(source, "Local State"), state);
        yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
        yield* initializeV2DesktopProfile(directory, "T3 Code (Alpha)", destination);
        assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
        assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
        assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
        yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
        yield* initializeV2DesktopProfile(directory, "T3 Code (Alpha)", destination);
        assert.equal(
          yield* fs.readFileString(path.join(destination, "Local State")),
          "existing V2 state",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("uses the same legacy-profile precedence as V1", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    for (const sourceName of ["t3code", "T3 Code (Alpha)"]) {
      const source = path.join(directory, sourceName);
      yield* fs.makeDirectory(source);
      yield* fs.writeFileString(path.join(source, "Local State"), sourceName);
    }
    const destination = path.join(directory, "t3code-v2");
    yield* initializeV2DesktopProfile(directory, "T3 Code (Alpha)", destination);
    assert.equal(
      yield* fs.readFileString(path.join(destination, "Local State")),
      "T3 Code (Alpha)",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("leaves fresh installations without an imported Local State file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
    const destination = path.join(directory, "t3code-v2");
    yield* initializeV2DesktopProfile(directory, "T3 Code (Alpha)", destination);
    assert.isFalse(yield* fs.exists(path.join(destination, "Local State")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
