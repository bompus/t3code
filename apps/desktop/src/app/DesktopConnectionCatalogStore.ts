import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
  RelayConnectionTarget,
  SshConnectionProfile,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import {
  ConnectionCatalogDocument as RuntimeConnectionCatalogDocument,
  type ConnectionCatalogDocument as RuntimeConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import type { PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopWindowsSafeStorage from "./DesktopWindowsSafeStorage.ts";

const EncryptedConnectionCatalogDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedCatalog: Schema.String,
});
type EncryptedConnectionCatalogDocument = typeof EncryptedConnectionCatalogDocument.Type;

const EncryptedConnectionCatalogDocumentJson = fromLenientJson(EncryptedConnectionCatalogDocument);
const decodeEncryptedConnectionCatalogDocumentJson = Schema.decodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const encodeEncryptedConnectionCatalogDocumentJson = Schema.encodeEffect(
  EncryptedConnectionCatalogDocumentJson,
);
const RuntimeConnectionCatalogDocumentJson = Schema.fromJsonString(
  RuntimeConnectionCatalogDocument,
);
const encodeRuntimeConnectionCatalogDocumentJson = Schema.encodeEffect(
  RuntimeConnectionCatalogDocumentJson,
);

const DesktopConnectionCatalogStoreWriteOperation = Schema.Literals([
  "create-temporary-file-name",
  "encode-document",
  "create-directory",
  "write-temporary-file",
  "replace-catalog-file",
]);

const DesktopConnectionCatalogStoreMigrationOperation = Schema.Literals([
  "read-legacy-registry",
  "read-legacy-secret",
  "encode-catalog",
  "persist-catalog",
]);

const DesktopConnectionCatalogStoreProtectionOperation = Schema.Literals([
  "check-encryption-availability",
  "encrypt-catalog",
  "decrypt-catalog",
]);

export class DesktopConnectionCatalogStoreWriteError extends Schema.TaggedError<DesktopConnectionCatalogStoreWriteError>()(
  "DesktopConnectionCatalogStoreWriteError",
  {
    operation: DesktopConnectionCatalogStoreWriteOperation,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog write failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopConnectionCatalogStoreDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDecodeError>()(
  "DesktopConnectionCatalogStoreDecodeError",
  {
    resource: Schema.Literal("encryptedCatalog"),
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.resource} for the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreReadError extends Schema.TaggedError<DesktopConnectionCatalogStoreReadError>()(
  "DesktopConnectionCatalogStoreReadError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the desktop connection catalog at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreDocumentDecodeError extends Schema.TaggedError<DesktopConnectionCatalogStoreDocumentDecodeError>()(
  "DesktopConnectionCatalogStoreDocumentDecodeError",
  {
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode the desktop connection catalog document at ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreMigrationError extends Schema.TaggedError<DesktopConnectionCatalogStoreMigrationError>()(
  "DesktopConnectionCatalogStoreMigrationError",
  {
    operation: DesktopConnectionCatalogStoreMigrationOperation,
    catalogPath: Schema.String,
    environmentId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment ${this.environmentId}`;
    return `Legacy desktop saved-environment migration failed during ${this.operation}${environment} into ${this.catalogPath}.`;
  }
}

export class DesktopConnectionCatalogStoreProtectionError extends Schema.TaggedError<DesktopConnectionCatalogStoreProtectionError>()(
  "DesktopConnectionCatalogStoreProtectionError",
  {
    operation: DesktopConnectionCatalogStoreProtectionOperation,
    catalogPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop connection catalog protection failed during ${this.operation} at ${this.catalogPath}.`;
  }
}

const isProtectionError = Schema.is(DesktopConnectionCatalogStoreProtectionError);

export class DesktopConnectionCatalogStore extends Context.Service<
  DesktopConnectionCatalogStore,
  {
    readonly get: Effect.Effect<
      Option.Option<string>,
      | DesktopConnectionCatalogStoreReadError
      | DesktopConnectionCatalogStoreDocumentDecodeError
      | DesktopConnectionCatalogStoreDecodeError
      | DesktopConnectionCatalogStoreMigrationError
      | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly set: (
      catalog: string,
    ) => Effect.Effect<
      boolean,
      DesktopConnectionCatalogStoreWriteError | DesktopConnectionCatalogStoreProtectionError
    >;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopConnectionCatalogStore") {}

function decodeSecretBytes(
  catalogPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopConnectionCatalogStoreDecodeError> {
  return Effect.fromResult(Base64.decode(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreDecodeError({
          resource: "encryptedCatalog",
          catalogPath,
          cause,
        }),
    ),
  );
}

const readDocument = (
  fileSystem: FileSystem.FileSystem,
  catalogPath: string,
): Effect.Effect<
  Option.Option<EncryptedConnectionCatalogDocument>,
  DesktopConnectionCatalogStoreReadError | DesktopConnectionCatalogStoreDocumentDecodeError
> =>
  fileSystem.readFileString(catalogPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopConnectionCatalogStoreReadError({
              catalogPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed(Option.none<EncryptedConnectionCatalogDocument>())
        : decodeEncryptedConnectionCatalogDocumentJson(raw).pipe(
            Effect.asSome,
            Effect.mapError(
              (cause) =>
                new DesktopConnectionCatalogStoreDocumentDecodeError({
                  catalogPath,
                  cause,
                }),
            ),
          ),
    ),
  );

const writeDocument = Effect.fn("desktop.connectionCatalogStore.writeDocument")(function* (input: {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly catalogPath: string;
  readonly document: EncryptedConnectionCatalogDocument;
  readonly suffix: string;
}): Effect.fn.Return<void, DesktopConnectionCatalogStoreWriteError> {
  const directory = input.path.dirname(input.catalogPath);
  const tempPath = `${input.catalogPath}.${process.pid}.${input.suffix}.tmp`;
  const encoded = yield* encodeEncryptedConnectionCatalogDocumentJson(input.document).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "encode-document",
          path: input.catalogPath,
          cause,
        }),
    ),
  );
  yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreWriteError({
          operation: "create-directory",
          path: directory,
          cause,
        }),
    ),
  );
  yield* Effect.gen(function* () {
    yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "write-temporary-file",
            path: tempPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.rename(tempPath, input.catalogPath).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "replace-catalog-file",
            path: input.catalogPath,
            cause,
          }),
      ),
    );
  }).pipe(
    Effect.ensuring(
      input.fileSystem.remove(tempPath, { force: true }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not remove a temporary connection catalog file.", {
            tempPath,
            error,
          }),
        ),
      ),
    ),
  );
});

function connectionId(prefix: "bearer" | "ssh", environmentId: string): string {
  return `${prefix}:${environmentId}`;
}

const migrateSavedEnvironmentRecords = Effect.fn(
  "desktop.connectionCatalogStore.migrateSavedEnvironmentRecords",
)(function* (
  records: readonly PersistedSavedEnvironmentRecord[],
  savedEnvironments: DesktopSavedEnvironments.DesktopSavedEnvironments["Service"],
  catalogPath: string,
): Effect.fn.Return<
  RuntimeConnectionCatalogDocumentType,
  DesktopConnectionCatalogStoreMigrationError
> {
  const targets: Array<RuntimeConnectionCatalogDocumentType["targets"][number]> = [];
  const profiles: Array<RuntimeConnectionCatalogDocumentType["profiles"][number]> = [];
  const credentials: Array<RuntimeConnectionCatalogDocumentType["credentials"][number]> = [];

  for (const record of records) {
    if (record.relayManaged !== undefined) {
      targets.push(
        new RelayConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
        }),
      );
      continue;
    }

    if (record.desktopSsh !== undefined) {
      const id = connectionId("ssh", record.environmentId);
      targets.push(
        new SshConnectionTarget({
          environmentId: record.environmentId,
          label: record.label,
          connectionId: id,
        }),
      );
      profiles.push(
        new SshConnectionProfile({
          connectionId: id,
          environmentId: record.environmentId,
          label: record.label,
          target: record.desktopSsh,
        }),
      );
      continue;
    }

    const id = connectionId("bearer", record.environmentId);
    targets.push(
      new BearerConnectionTarget({
        environmentId: record.environmentId,
        label: record.label,
        connectionId: id,
      }),
    );
    profiles.push(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: record.environmentId,
        label: record.label,
        httpBaseUrl: record.httpBaseUrl,
        wsBaseUrl: record.wsBaseUrl,
      }),
    );
    const token = yield* savedEnvironments.getSecret(record.environmentId).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-secret",
            catalogPath,
            environmentId: record.environmentId,
            cause,
          }),
      ),
    );
    if (Option.isSome(token)) {
      credentials.push({
        connectionId: id,
        credential: new BearerConnectionCredential({ token: token.value }),
      });
    }
  }

  return {
    schemaVersion: 1,
    targets,
    profiles,
    credentials,
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
});

/**
 * Which key encrypts the shared catalog, resolved from the catalog itself.
 * `Legacy` means a Windows V1 profile key opened a catalog the running
 * V2 profile key could not; writes then keep that key so V1 can still read
 * the file, and no profile's `Local State` is ever rewritten.
 */
type CatalogKeyState =
  | { readonly _tag: "Unresolved" }
  | { readonly _tag: "Current" }
  | { readonly _tag: "Legacy"; readonly profile: string; readonly key: Uint8Array }
  | { readonly _tag: "Unrecoverable"; readonly encryptedCatalog: string };

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const windowsSafeStorage = yield* DesktopWindowsSafeStorage.DesktopWindowsSafeStorage;
  const crypto = yield* Crypto.Crypto;
  const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
  const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
  const catalogKeyState = yield* Ref.make<CatalogKeyState>({ _tag: "Unresolved" });
  // Windows V1 profiles whose safeStorage key may have encrypted the
  // shared catalog before the V2 profile existed. Both names can coexist
  // with different keys, so recovery tries each against the catalog.
  const legacyProfileCandidates =
    environment.platform === "win32" && !environment.isDevelopment
      ? ["t3code", "T3 Code (Alpha)"].map((profile) => ({
          profile,
          localStatePath: path.join(environment.appDataDirectory, profile, "Local State"),
        }))
      : [];
  const encryptionAvailable = safeStorage.isEncryptionAvailable.pipe(
    Effect.mapError(
      (cause) =>
        new DesktopConnectionCatalogStoreProtectionError({
          operation: "check-encryption-availability",
          catalogPath,
          cause,
        }),
    ),
  );

  const persistEncryptedCatalog = Effect.fn(
    "desktop.connectionCatalogStore.persistEncryptedCatalog",
  )(function* (encrypted: Uint8Array) {
    const suffix = (yield* crypto.randomUUIDv4().pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreWriteError({
            operation: "create-temporary-file-name",
            path: catalogPath,
            cause,
          }),
      ),
    )).replace(/-/g, "");
    yield* writeDocument({
      fileSystem,
      path,
      catalogPath,
      document: { version: 1, encryptedCatalog: Base64.encode(encrypted) },
      suffix,
    });
  });

  const writeCatalog = Effect.fn("desktop.connectionCatalogStore.writeCatalog")(function* (
    catalog: string,
  ) {
    yield* persistEncryptedCatalog(
      yield* safeStorage.encryptString(catalog).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopConnectionCatalogStoreProtectionError({
              operation: "encrypt-catalog",
              catalogPath,
              cause,
            }),
        ),
      ),
    );
  });

  const decryptProtectionError = (cause: unknown) =>
    new DesktopConnectionCatalogStoreProtectionError({
      operation: "decrypt-catalog",
      catalogPath,
      cause,
    });

  const recoverWithLegacyProfileKey = Effect.fn(
    "desktop.connectionCatalogStore.recoverWithLegacyProfileKey",
  )(function* (encryptedCatalog: Uint8Array, encodedCatalog: string, cause: unknown) {
    const state = yield* Ref.get(catalogKeyState);
    if (
      legacyProfileCandidates.length === 0 ||
      (state._tag === "Unrecoverable" && state.encryptedCatalog === encodedCatalog)
    ) {
      return yield* decryptProtectionError(cause);
    }
    for (const candidate of legacyProfileCandidates) {
      const key = yield* windowsSafeStorage.readProfileKey(candidate.localStatePath).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          Effect.logWarning("Could not read a legacy Windows profile key for catalog recovery.", {
            profile: candidate.profile,
            error,
          }).pipe(Effect.as(Option.none<Uint8Array>())),
        ),
      );
      if (Option.isNone(key)) continue;
      const decrypted = DesktopWindowsSafeStorage.decryptWithProfileKey(
        key.value,
        encryptedCatalog,
      );
      if (Option.isNone(decrypted)) continue;
      yield* Ref.set(catalogKeyState, {
        _tag: "Legacy",
        profile: candidate.profile,
        key: key.value,
      });
      yield* Effect.logWarning(
        "Recovered the connection catalog with a legacy Windows profile key.",
        { profile: candidate.profile, catalogPath },
      );
      return decrypted.value;
    }
    yield* Ref.set(catalogKeyState, { _tag: "Unrecoverable", encryptedCatalog: encodedCatalog });
    return yield* decryptProtectionError(cause);
  });

  const decryptCatalog = Effect.fn("desktop.connectionCatalogStore.decryptCatalog")(function* (
    document: EncryptedConnectionCatalogDocument,
  ) {
    const encryptedCatalog = yield* decodeSecretBytes(catalogPath, document.encryptedCatalog);
    const state = yield* Ref.get(catalogKeyState);
    if (state._tag === "Legacy") {
      const decrypted = DesktopWindowsSafeStorage.decryptWithProfileKey(
        state.key,
        encryptedCatalog,
      );
      if (Option.isSome(decrypted)) {
        return decrypted.value;
      }
      // The catalog was rewritten under another key since recovery (for
      // example by V1 after its own profile changed); resolve it again.
      yield* Ref.set(catalogKeyState, { _tag: "Unresolved" });
    }
    return yield* safeStorage.decryptString(encryptedCatalog).pipe(
      Effect.tap(() => Ref.set(catalogKeyState, { _tag: "Current" })),
      Effect.catch((cause) =>
        recoverWithLegacyProfileKey(encryptedCatalog, document.encryptedCatalog, cause),
      ),
    );
  });

  const migrateLegacyCatalog = Effect.gen(function* () {
    if (!(yield* encryptionAvailable)) {
      return Option.none<string>();
    }
    const records = yield* savedEnvironments.getRegistry.pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "read-legacy-registry",
            catalogPath,
            cause,
          }),
      ),
    );
    if (records.length === 0) {
      return Option.none<string>();
    }
    const catalog = yield* migrateSavedEnvironmentRecords(records, savedEnvironments, catalogPath);
    const encoded = yield* encodeRuntimeConnectionCatalogDocumentJson(catalog).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "encode-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    yield* writeCatalog(encoded).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopConnectionCatalogStoreMigrationError({
            operation: "persist-catalog",
            catalogPath,
            cause,
          }),
      ),
    );
    return Option.some(encoded);
  });

  return DesktopConnectionCatalogStore.of({
    get: Effect.gen(function* () {
      const document = yield* readDocument(fileSystem, catalogPath);
      if (Option.isNone(document)) {
        return yield* migrateLegacyCatalog;
      }
      if (!(yield* encryptionAvailable)) {
        return Option.none<string>();
      }
      return Option.some(yield* decryptCatalog(document.value));
    }).pipe(Effect.withSpan("desktop.connectionCatalogStore.get")),
    set: Effect.fn("desktop.connectionCatalogStore.set")(function* (catalog) {
      if (!(yield* encryptionAvailable)) {
        return false;
      }
      const state = yield* Ref.get(catalogKeyState);
      if (state._tag === "Legacy") {
        yield* persistEncryptedCatalog(
          DesktopWindowsSafeStorage.encryptWithProfileKey(state.key, catalog),
        );
        return true;
      }
      if (state._tag !== "Current" && legacyProfileCandidates.length > 0) {
        // Resolve the existing catalog's key before rewriting it, so a
        // catalog V1 encrypted is never silently re-encrypted under a key
        // V1 cannot read, and an undecryptable catalog is never silently
        // overwritten. A missing catalog keeps the current key.
        const document = yield* readDocument(fileSystem, catalogPath).pipe(
          Effect.mapError((cause) => decryptProtectionError(cause)),
        );
        if (Option.isSome(document)) {
          yield* decryptCatalog(document.value).pipe(
            Effect.mapError((cause) =>
              isProtectionError(cause) ? cause : decryptProtectionError(cause),
            ),
          );
          const resolved = yield* Ref.get(catalogKeyState);
          if (resolved._tag === "Legacy") {
            yield* persistEncryptedCatalog(
              DesktopWindowsSafeStorage.encryptWithProfileKey(resolved.key, catalog),
            );
            return true;
          }
        }
      }
      yield* writeCatalog(catalog);
      return true;
    }),
    clear: fileSystem.remove(catalogPath, { force: true }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not clear the desktop connection catalog.", {
          catalogPath,
          error,
        }),
      ),
      Effect.withSpan("desktop.connectionCatalogStore.clear"),
    ),
  });
});

export const layer = Layer.effect(DesktopConnectionCatalogStore, make);
