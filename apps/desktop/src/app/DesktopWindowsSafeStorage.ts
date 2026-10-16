// @effect-diagnostics nodeBuiltinImport:off - `node:crypto` implements the
// Windows OSCrypt AES-256-GCM format Electron safeStorage writes; Effect has
// no equivalent.
/**
 * Windows profile keys for data another T3 Code profile encrypted.
 *
 * Electron's `safeStorage` only ever uses the key in the running profile's
 * `Local State` (`os_crypt.encrypted_key`, DPAPI-wrapped). The shared
 * connection catalog can instead be encrypted with a legacy profile's key
 * when the V2 profile was seeded from the wrong source or created its own
 * key. On Windows the stored value is Chromium's `v10` format: the prefix
 * `v10`, a 12-byte nonce, AES-256-GCM ciphertext and a 16-byte auth tag, so
 * a value written for one profile can be opened with that profile's own key
 * once DPAPI unwraps it for the current user. Reading a key never modifies
 * any profile, so both versions keep the credentials already encrypted
 * under their own keys.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import * as ChromiumKeys from "../preview/BrowserImport/ChromiumKeys.ts";

const V10_PREFIX = Buffer.from("v10");
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export class DesktopWindowsSafeStorageError extends Schema.TaggedError<DesktopWindowsSafeStorageError>()(
  "DesktopWindowsSafeStorageError",
  {
    localStatePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read the Windows profile key at ${this.localStatePath}.`;
  }
}

export class DesktopWindowsSafeStorage extends Context.Service<
  DesktopWindowsSafeStorage,
  {
    /** Unwraps the AES key a Windows Electron profile stores in `Local State`. */
    readonly readProfileKey: (
      localStatePath: string,
    ) => Effect.Effect<Uint8Array, DesktopWindowsSafeStorageError>;
  }
>()("@t3tools/desktop/app/DesktopWindowsSafeStorage") {}

/**
 * Decrypts one Windows safeStorage value with an explicit profile key.
 * Returns none when the value is not `v10` or the key does not authenticate
 * it; a wrong key and a corrupt value are indistinguishable by design.
 */
export const decryptWithProfileKey = (
  key: Uint8Array,
  encrypted: Uint8Array,
): Option.Option<string> => {
  const buffer = Buffer.from(encrypted);
  if (key.length !== KEY_LENGTH || buffer.length < V10_PREFIX.length + NONCE_LENGTH + TAG_LENGTH) {
    return Option.none();
  }
  if (!buffer.subarray(0, V10_PREFIX.length).equals(V10_PREFIX)) {
    return Option.none();
  }
  const payload = buffer.subarray(V10_PREFIX.length);
  try {
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key),
      payload.subarray(0, NONCE_LENGTH),
    );
    decipher.setAuthTag(payload.subarray(-TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(payload.subarray(NONCE_LENGTH, -TAG_LENGTH)),
      decipher.final(),
    ]);
    return Option.some(plaintext.toString("utf8"));
  } catch {
    return Option.none();
  }
};

/** Encrypts one value exactly as Windows safeStorage would for `key`. */
export const encryptWithProfileKey = (key: Uint8Array, plaintext: string): Uint8Array => {
  const nonce = NodeCrypto.randomBytes(NONCE_LENGTH);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", Buffer.from(key), nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([V10_PREFIX, nonce, ciphertext, cipher.getAuthTag()]);
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return DesktopWindowsSafeStorage.of({
    readProfileKey: (localStatePath) =>
      ChromiumKeys.readWindowsKey(localStatePath).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) => new DesktopWindowsSafeStorageError({ localStatePath, cause })),
      ),
  });
});

export const layer = Layer.effect(DesktopWindowsSafeStorage, make);
