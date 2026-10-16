// @effect-diagnostics nodeBuiltinImport:off - Fixtures use the same Windows
// OSCrypt AES-256-GCM primitives Electron safeStorage writes.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWindowsSafeStorage from "./DesktopWindowsSafeStorage.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

const layerWindowsSafeStorageUnavailable = Layer.succeed(
  DesktopWindowsSafeStorage.DesktopWindowsSafeStorage,
  {
    readProfileKey: (localStatePath) =>
      Effect.fail(
        new DesktopWindowsSafeStorage.DesktopWindowsSafeStorageError({
          localStatePath,
          cause: new Error("no Windows profile keys in this test"),
        }),
      ),
  } satisfies DesktopWindowsSafeStorage.DesktopWindowsSafeStorage["Service"],
);

interface LayerOverrides {
  readonly platform?: NodeJS.Platform;
  readonly appDataDirectory?: string;
  readonly safeStorage?: Layer.Layer<ElectronSafeStorage.ElectronSafeStorage>;
  readonly windowsSafeStorage?: Layer.Layer<DesktopWindowsSafeStorage.DesktopWindowsSafeStorage>;
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  overrides: LayerOverrides = {},
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: overrides.platform ?? "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          APPDATA: overrides.appDataDirectory,
        }),
      ),
    ),
  );
  const layerSafeStorage =
    overrides.safeStorage ?? layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    overrides.windowsSafeStorage ?? layerWindowsSafeStorageUnavailable,
    NodeServices.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists, reads, and clears an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const records: readonly PersistedSavedEnvironmentRecord[] = [
          {
            environmentId: EnvironmentId.make("relay-environment"),
            label: "Relay",
            httpBaseUrl: "https://relay.example.com/",
            wsBaseUrl: "wss://relay.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
            relayManaged: { relayUrl: "https://relay-control.example.com/" },
          },
          {
            environmentId: EnvironmentId.make("ssh-environment"),
            label: "SSH",
            httpBaseUrl: "http://127.0.0.1:41773/",
            wsBaseUrl: "ws://127.0.0.1:41773/",
            createdAt: "2026-06-02T00:00:00.000Z",
            lastConnectedAt: null,
            desktopSsh: {
              alias: "devbox",
              hostname: "devbox.example.com",
              username: "julius",
              port: 22,
            },
          },
          {
            environmentId: EnvironmentId.make("bearer-environment"),
            label: "Bearer",
            httpBaseUrl: "https://bearer.example.com/",
            wsBaseUrl: "wss://bearer.example.com/",
            createdAt: "2026-06-03T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ];
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
                      textEncoder.encode("encrypted:legacy-token"),
                    ),
                  }
                : record,
            ),
          }),
        );

        const migrated = yield* store.get;
        assert.isTrue(Option.isSome(migrated));
        if (Option.isNone(migrated)) {
          return;
        }
        const catalog = yield* decodeConnectionCatalog(migrated.value);

        assert.deepInclude(catalog.targets[0], {
          _tag: "RelayConnectionTarget",
          environmentId: EnvironmentId.make("relay-environment"),
          label: "Relay",
        });
        assert.deepInclude(catalog.targets[1], {
          _tag: "SshConnectionTarget",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          connectionId: "ssh:ssh-environment",
        });
        assert.deepInclude(catalog.targets[2], {
          _tag: "BearerConnectionTarget",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          connectionId: "bearer:bearer-environment",
        });
        assert.deepInclude(catalog.profiles[0], {
          _tag: "SshConnectionProfile",
          connectionId: "ssh:ssh-environment",
          environmentId: EnvironmentId.make("ssh-environment"),
          label: "SSH",
          target: {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 22,
          },
        });
        assert.deepInclude(catalog.profiles[1], {
          _tag: "BearerConnectionProfile",
          connectionId: "bearer:bearer-environment",
          environmentId: EnvironmentId.make("bearer-environment"),
          label: "Bearer",
          httpBaseUrl: "https://bearer.example.com/",
          wsBaseUrl: "wss://bearer.example.com/",
        });
        assert.equal(catalog.credentials.length, 1);
        assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
        assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
        if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
          assert.equal(catalog.credentials[0].credential.token, "legacy-token");
        }

        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          '{"version":1,"records":[]}',
        );
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

  it.effect("surfaces catalog filesystem failures instead of treating them as missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: path.join(baseDir, "userdata", "connection-catalog.json"),
      });
      const layerFileSystem = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, null, layerFileSystem)),
      );

      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreReadError,
      );
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Failed to read the desktop connection catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the failed catalog write operation and path", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: path.join(baseDir, "userdata"),
      });
      const layerFileSystem = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          makeDirectory: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, null, layerFileSystem)),
      );

      const error = yield* store.set("{}").pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
      );
      assert.equal(error.operation, "create-directory");
      assert.equal(error.path, path.join(baseDir, "userdata"));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Desktop connection catalog write failed during create-directory at ${path.join(baseDir, "userdata")}.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the legacy migration stage", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreMigrationError,
        );
        assert.equal(error.operation, "read-legacy-registry");
        assert.equal(error.catalogPath, path.join(environment.stateDir, "connection-catalog.json"));
        assert.instanceOf(
          error.cause,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const registryError =
          error.cause as DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError;
        assert.exists(registryError.cause);
        assert.equal(
          error.message,
          `Legacy desktop saved-environment migration failed during read-legacy-registry into ${path.join(environment.stateDir, "connection-catalog.json")}.`,
        );
        assert.notEqual(error.message, registryError.message);
      }),
    ),
  );

  it.effect("reports invalid encrypted catalog data without exposing it", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, '{"version":1,"encryptedCatalog":"%%%"}\n');

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDecodeError,
        );
        assert.equal(error.resource, "encryptedCatalog");
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Failed to decode encryptedCatalog for the desktop connection catalog at ${catalogPath}.`,
        );
        assert.notInclude(error.message, "%%%");
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = layerFor(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

// Windows V1/V2 profiles share one catalog file but can hold different
// safeStorage keys. These fixtures use the real `v10` AES-256-GCM format
// Electron writes on Windows, with three distinct profile keys.
const stableProfileKey = Buffer.alloc(32, 1);
const alphaProfileKey = Buffer.alloc(32, 2);
const v2ProfileKey = Buffer.alloc(32, 3);
const unknownProfileKey = Buffer.alloc(32, 4);

const encryptWindowsV10 = (value: string, key: Buffer): Buffer => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), nonce, ciphertext, cipher.getAuthTag()]);
};

const decryptWindowsV10 = (value: Uint8Array, key: Buffer): string | null => {
  const buffer = Buffer.from(value);
  if (buffer.subarray(0, 3).toString("latin1") !== "v10" || buffer.length < 3 + 12 + 16) {
    return null;
  }
  try {
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, buffer.subarray(3, 15));
    decipher.setAuthTag(buffer.subarray(-16));
    return Buffer.concat([decipher.update(buffer.subarray(15, -16)), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
};

const layerWindowsSafeStorageAsV2 = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: (value) => Effect.succeed(encryptWindowsV10(value, v2ProfileKey)),
  decryptString: (value) => {
    const decrypted = decryptWindowsV10(value, v2ProfileKey);
    return decrypted === null
      ? Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("Error while decrypting the ciphertext"),
          }),
        )
      : Effect.succeed(decrypted);
  },
  selectedStorageBackend: Effect.succeedNone,
} satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

const layerWindowsProfileKeys = (keys: Readonly<Record<string, Buffer>>, calls: Array<string>) =>
  Layer.succeed(DesktopWindowsSafeStorage.DesktopWindowsSafeStorage, {
    readProfileKey: (localStatePath) => {
      calls.push(localStatePath);
      const profile = localStatePath.includes("T3 Code (Alpha)")
        ? "T3 Code (Alpha)"
        : localStatePath.includes("t3code")
          ? "t3code"
          : undefined;
      const key = profile === undefined ? undefined : keys[profile];
      return key === undefined
        ? Effect.fail(
            new DesktopWindowsSafeStorage.DesktopWindowsSafeStorageError({
              localStatePath,
              cause: new Error("no such profile"),
            }),
          )
        : Effect.succeed(new Uint8Array(key));
    },
  } satisfies DesktopWindowsSafeStorage.DesktopWindowsSafeStorage["Service"]);

const withWindowsStore = <A, E, R>(
  catalogKey: Buffer,
  effect: (context: {
    readonly catalogPath: string;
    readonly appDataDirectory: string;
    readonly profileKeyCalls: ReadonlyArray<string>;
  }) => Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-windows-",
    });
    const appDataDirectory = path.join(baseDir, "appdata");
    const catalogPath = path.join(baseDir, "userdata", "connection-catalog.json");
    const catalog = '{"schemaVersion":1,"targets":[{"label":"saved"}]}';
    for (const profile of ["t3code", "T3 Code (Alpha)", "t3code-v2"]) {
      yield* fileSystem.makeDirectory(path.join(appDataDirectory, profile), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(appDataDirectory, profile, "Local State"),
        `{"os_crypt":{"encrypted_key":"wrapped-${profile}"}}`,
      );
    }
    yield* fileSystem.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
    yield* fileSystem.writeFileString(
      catalogPath,
      `{"version":1,"encryptedCatalog":"${Base64.encode(encryptWindowsV10(catalog, catalogKey))}"}\n`,
    );
    const profileKeyCalls: Array<string> = [];
    const layer = layerFor(baseDir, true, null, NodeServices.layer, {
      platform: "win32",
      appDataDirectory,
      safeStorage: layerWindowsSafeStorageAsV2,
      windowsSafeStorage: layerWindowsProfileKeys(
        { t3code: stableProfileKey, "T3 Code (Alpha)": alphaProfileKey },
        profileKeyCalls,
      ),
    });
    const result = yield* effect({ catalogPath, appDataDirectory, profileKeyCalls }).pipe(
      Effect.provide(layer),
    );
    return { result, catalog };
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore Windows profile key recovery", () => {
  it.effect.each(["t3code", "T3 Code (Alpha)"] as const)(
    "recovers a catalog encrypted with the %s key without touching any profile",
    (profile) =>
      withWindowsStore(
        profile === "t3code" ? stableProfileKey : alphaProfileKey,
        ({ catalogPath, appDataDirectory }) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
            const before = yield* fileSystem.readFileString(catalogPath);

            const recovered = yield* store.get;
            assert.deepStrictEqual(
              recovered,
              Option.some('{"schemaVersion":1,"targets":[{"label":"saved"}]}'),
            );

            // Recovery is read-only: the shared catalog and every profile's
            // Local State stay byte-identical, so V1 and any credentials V2
            // already encrypted with its own key keep working.
            assert.equal(yield* fileSystem.readFileString(catalogPath), before);
            for (const profile of ["t3code", "T3 Code (Alpha)", "t3code-v2"]) {
              assert.equal(
                yield* fileSystem.readFileString(
                  path.join(appDataDirectory, profile, "Local State"),
                ),
                `{"os_crypt":{"encrypted_key":"wrapped-${profile}"}}`,
              );
            }
          }),
      ),
  );

  it.effect("keeps recovered catalog writes readable by the legacy (V1) profile", () =>
    withWindowsStore(stableProfileKey, ({ catalogPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const updated = '{"schemaVersion":1,"targets":[{"label":"updated"}]}';

        // Even when set runs before any get, the existing catalog's key is
        // resolved first so the rewrite stays decryptable by V1's profile.
        assert.isTrue(yield* store.set(updated));
        const written = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
          encryptedCatalog: string;
        };
        const writtenBytes = Buffer.from(written.encryptedCatalog, "base64");
        assert.equal(decryptWindowsV10(writtenBytes, stableProfileKey), updated);
        assert.isNull(decryptWindowsV10(writtenBytes, v2ProfileKey));
        assert.deepStrictEqual(yield* store.get, Option.some(updated));
      }),
    ),
  );

  it.effect("leaves a catalog encrypted with the current V2 key on safeStorage", () =>
    withWindowsStore(v2ProfileKey, ({ catalogPath, profileKeyCalls }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const updated = '{"schemaVersion":1,"targets":[]}';

        assert.deepStrictEqual(
          yield* store.get,
          Option.some('{"schemaVersion":1,"targets":[{"label":"saved"}]}'),
        );
        assert.isTrue(yield* store.set(updated));
        const written = JSON.parse(yield* fileSystem.readFileString(catalogPath)) as {
          encryptedCatalog: string;
        };
        assert.equal(
          decryptWindowsV10(Buffer.from(written.encryptedCatalog, "base64"), v2ProfileKey),
          updated,
        );
        // A working V2 key never triggers legacy key recovery.
        assert.deepEqual([...profileKeyCalls], []);
      }),
    ),
  );

  it.effect("fails closed without overwriting a catalog no profile key can open", () =>
    withWindowsStore(unknownProfileKey, ({ catalogPath }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const before = yield* fileSystem.readFileString(catalogPath);

        const getError = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          getError,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
        );
        assert.equal(getError.operation, "decrypt-catalog");

        const setError = yield* store.set('{"schemaVersion":1,"targets":[]}').pipe(Effect.flip);
        assert.instanceOf(
          setError,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
        );
        assert.equal(yield* fileSystem.readFileString(catalogPath), before);
      }),
    ),
  );
});
