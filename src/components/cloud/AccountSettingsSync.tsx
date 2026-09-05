"use client";

import { useEffect, useRef, useState } from "react";
import { clientKeyValueStore } from "@cesium/client";
import { useGlobalSettings } from "@/components/preferences/GlobalSettingsProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  accountSettingsSignature,
  applyAccountSyncedSettings,
  resolveAccountSettingsSync,
  serializeAccountSettingsDocument,
  type AccountSettingsSyncMarker,
} from "@/lib/cloud/account-settings";

const SYNC_MARKER_KEY_PREFIX = "cesium.cloud.account-settings-sync:";
/** Settle time after the last local edit before the document is uploaded. */
export const ACCOUNT_SETTINGS_PUSH_DEBOUNCE_MS = 1_200;
const ACCOUNT_SETTINGS_RETRY_MS = 5_000;

function markerStorageKey(userKey: string): string {
  return `${SYNC_MARKER_KEY_PREFIX}${userKey}`;
}

export function readAccountSettingsSyncMarker(userKey: string): AccountSettingsSyncMarker | null {
  try {
    const raw = clientKeyValueStore().getItem(markerStorageKey(userKey));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AccountSettingsSyncMarker> | null;
    if (
      !parsed ||
      typeof parsed.signature !== "string" ||
      typeof parsed.cloudUpdatedAt !== "number"
    ) {
      return null;
    }
    return { signature: parsed.signature, cloudUpdatedAt: parsed.cloudUpdatedAt };
  } catch {
    return null;
  }
}

function writeMarker(userKey: string, marker: AccountSettingsSyncMarker): void {
  try {
    clientKeyValueStore().setItem(markerStorageKey(userKey), JSON.stringify(marker));
  } catch {
    // Without the marker the next boot simply treats the cloud copy as authoritative.
  }
}

/**
 * Keeps the global settings document and the account settings document in
 * lockstep for signed-in clients:
 *
 * - The account document (Convex, live query) is the source of truth across
 *   devices and engines. When it changes anywhere, every client applies it
 *   immediately; the settings provider then persists it to that client's
 *   settings server, so engines follow the account.
 * - Explicit edits on this device are debounced and uploaded; each device
 *   pushes its own edits once and then follows the account.
 * - One-time legacy-store migrations upload only while nobody else changed
 *   the account, so an old device can never clobber a fresh pick.
 * - Loading settings from an engine is never mistaken for an edit, so
 *   connecting a fresh engine (factory defaults) or switching the settings
 *   server can never reset the account.
 *
 * Renders nothing. Mounts under both the cloud and global settings providers;
 * with the cloud disabled it is inert.
 */
export function AccountSettingsSync() {
  const cloud = useCloudContext();
  const { settings, hydrated, editVersion, migrationVersion, applyAccountSettings } =
    useGlobalSettings();
  const userKey = cloud.status === "ready" ? cloud.userKey : null;
  const actions = cloud.status === "ready" ? cloud.actions : null;
  const accountSettings = cloud.accountSettings;

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const editVersionRef = useRef(editVersion);
  editVersionRef.current = editVersion;
  const migrationVersionRef = useRef(migrationVersion);
  migrationVersionRef.current = migrationVersion;
  /** Versions this device last reconciled (pushed, or accepted the account over). */
  const syncedEditVersionRef = useRef(editVersion);
  const syncedMigrationVersionRef = useRef(migrationVersion);
  const pushTimerRef = useRef<number | null>(null);
  const pushInFlightRef = useRef(false);
  const activeUserKeyRef = useRef<string | null>(null);
  /** Bumped after a failed upload so the reconcile effect re-runs and retries. */
  const [retryTick, setRetryTick] = useState(0);

  // Pending edits are tracked per account; switching accounts (or signing
  // out) resets the bookkeeping so one user's pending edits never reach another.
  useEffect(() => {
    if (activeUserKeyRef.current === userKey) {
      return;
    }
    activeUserKeyRef.current = userKey;
    syncedEditVersionRef.current = editVersionRef.current;
    syncedMigrationVersionRef.current = migrationVersionRef.current;
    if (pushTimerRef.current != null) {
      window.clearTimeout(pushTimerRef.current);
      pushTimerRef.current = null;
    }
  }, [userKey]);

  useEffect(() => {
    if (!userKey || !actions) {
      return;
    }
    const decision = resolveAccountSettingsSync({
      cloud: accountSettings,
      local: settings,
      hydrated,
      marker: readAccountSettingsSyncMarker(userKey),
      localEditsPending: editVersion !== syncedEditVersionRef.current,
      localMigrationsPending: migrationVersion !== syncedMigrationVersionRef.current,
    });

    if (decision.action === "wait") {
      return;
    }

    if (decision.action === "noop") {
      if (accountSettings) {
        // In sync with a real account document: record the revision and
        // forget pending edits, they are all reflected in the cloud copy.
        writeMarker(userKey, {
          signature: accountSettingsSignature(settings),
          cloudUpdatedAt: accountSettings.updatedAt,
        });
        syncedEditVersionRef.current = editVersion;
        syncedMigrationVersionRef.current = migrationVersion;
      }
      return;
    }

    if (decision.action === "apply") {
      const cloudSettings = decision.settings;
      applyAccountSettings((current) => applyAccountSyncedSettings(current, cloudSettings));
      writeMarker(userKey, {
        signature: accountSettingsSignature(applyAccountSyncedSettings(settings, cloudSettings)),
        cloudUpdatedAt: accountSettings!.updatedAt,
      });
      // Whatever was pending locally is superseded by the account.
      syncedEditVersionRef.current = editVersion;
      syncedMigrationVersionRef.current = migrationVersion;
      return;
    }

    // push: debounce so a burst of edits (model picker, rail tweaks) becomes
    // one upload once the user settles.
    if (pushTimerRef.current != null) {
      window.clearTimeout(pushTimerRef.current);
    }
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      if (pushInFlightRef.current) {
        // The in-flight upload's query update re-runs this effect afterwards.
        return;
      }
      const snapshot = settingsRef.current;
      const pushedEditVersion = editVersionRef.current;
      const pushedMigrationVersion = migrationVersionRef.current;
      pushInFlightRef.current = true;
      void actions
        .saveAccountSettings(serializeAccountSettingsDocument(snapshot))
        .then(({ updatedAt }) => {
          writeMarker(userKey, {
            signature: accountSettingsSignature(snapshot),
            cloudUpdatedAt: updatedAt,
          });
          if (syncedEditVersionRef.current < pushedEditVersion) {
            syncedEditVersionRef.current = pushedEditVersion;
          }
          if (syncedMigrationVersionRef.current < pushedMigrationVersion) {
            syncedMigrationVersionRef.current = pushedMigrationVersion;
          }
        })
        .catch(() => {
          // Offline or rejected: retry after a pause (any settings/cloud
          // change in the meantime re-runs the effect sooner).
          window.setTimeout(() => setRetryTick((tick) => tick + 1), ACCOUNT_SETTINGS_RETRY_MS);
        })
        .finally(() => {
          pushInFlightRef.current = false;
        });
    }, ACCOUNT_SETTINGS_PUSH_DEBOUNCE_MS);

    return () => {
      if (pushTimerRef.current != null) {
        window.clearTimeout(pushTimerRef.current);
        pushTimerRef.current = null;
      }
    };
  }, [
    accountSettings,
    actions,
    applyAccountSettings,
    editVersion,
    hydrated,
    migrationVersion,
    retryTick,
    settings,
    userKey,
  ]);

  return null;
}
