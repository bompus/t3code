import { useAtomValue } from "@effect/atom-react";
import type { DesktopSshEnvironmentBootstrap, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import type { EnvironmentPresentation } from "~/state/environments";

type SshServerKind = NonNullable<DesktopSshEnvironmentBootstrap["remoteServerKind"]>;

const STORAGE_KEY = "t3code:ssh-server-kinds:v1";
const StoredKindsSchema = Schema.Record(Schema.String, Schema.Literals(["external", "managed"]));
type StoredKinds = typeof StoredKindsSchema.Type;

// Cached server configs render before an SSH connection is prepared again, so
// the last kind seen must survive a restart.
export function readStoredSshServerKinds(): StoredKinds {
  try {
    return getLocalStorageItem(STORAGE_KEY, StoredKindsSchema) ?? {};
  } catch (error) {
    console.error("Could not read SSH server kinds.", error);
    return {};
  }
}

const sshServerKindsAtom = Atom.make<StoredKinds>(readStoredSshServerKinds()).pipe(
  Atom.keepAlive,
  Atom.withLabel("desktop:ssh-server-kinds"),
);

/** The desktop app relaunches a "managed" server on its own version at every connect; it leaves an "external" one alone. */
export function recordSshServerKind(
  environmentId: EnvironmentId,
  kind: SshServerKind | undefined,
): void {
  if (kind === undefined) return;
  const kinds = appAtomRegistry.get(sshServerKindsAtom);
  if (kinds[environmentId] === kind) return;
  const next = { ...kinds, [environmentId]: kind };
  appAtomRegistry.set(sshServerKindsAtom, next);
  try {
    setLocalStorageItem(STORAGE_KEY, next, StoredKindsSchema);
  } catch (error) {
    console.error("Could not persist SSH server kinds.", error);
  }
}

/**
 * Whether the desktop app started and relaunches this environment's server,
 * so its updates need no manual step. Only an SSH connection qualifies: the
 * same server paired by URL after its SSH environment was removed does not.
 */
export function useDesktopRelaunchesServer(): (
  environment: Pick<EnvironmentPresentation, "environmentId" | "entry">,
) => boolean {
  const kinds = useAtomValue(sshServerKindsAtom);
  return ({ environmentId, entry }) =>
    entry.target._tag === "SshConnectionTarget" && kinds[environmentId] === "managed";
}
