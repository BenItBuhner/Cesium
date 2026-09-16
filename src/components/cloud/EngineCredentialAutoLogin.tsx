"use client";

import { useEffect, useRef } from "react";
import { setStoredSessionToken } from "@cesium/client";
import { useAuth } from "@/components/auth/AuthProvider";
import { useServerConnections } from "@/components/preferences/ServerConnectionsProvider";
import { useCloudContext } from "@/contexts/CloudContext";
import {
  findEngineCredentialPayload,
  openEngineCredential,
} from "@/lib/cloud/engine-pairing";
import { loginToEngine } from "@/lib/onboarding/engine-api";

/** Do not hammer an engine that keeps rejecting the sealed credential. */
const RETRY_AFTER_MS = 60_000;

/**
 * Signs this device in to engines attached through `/connect/<code>`.
 *
 * The approving device sealed the engine credential for the account; every
 * other signed-in device receives the ciphertext in its bootstrap. Whenever a
 * saved engine reports `auth_required` (fresh device, expired session,
 * rotated tunnel), open the credential with the account wrapping key, log in,
 * and store the session token - so the picker never asks for a password.
 */
export function EngineCredentialAutoLogin() {
  const cloud = useCloudContext();
  const auth = useAuth();
  const { servers, serverStatusById, activeServer, hasServer, refreshServerHealth } =
    useServerConnections();
  const attemptsRef = useRef(new Map<string, number>());
  const inflightRef = useRef(new Set<string>());

  const secrets = cloud.bootstrap?.secrets ?? null;
  const activeNeedsLogin =
    hasServer && auth.ready && auth.enabled && !auth.authenticated && !auth.connectionError;

  useEffect(() => {
    if (!secrets || secrets.length === 0) {
      return;
    }
    const candidates = servers.filter((server) => {
      const serverId = server.rendezvous?.serverId;
      if (!serverId || !findEngineCredentialPayload(secrets, serverId)) {
        return false;
      }
      if (server.id === activeServer.id) {
        return activeNeedsLogin;
      }
      return serverStatusById[server.id]?.health === "auth_required";
    });
    if (candidates.length === 0) {
      return;
    }
    let cancelled = false;
    const now = Date.now();
    for (const server of candidates) {
      const serverId = server.rendezvous!.serverId;
      const attemptKey = `${server.id}\0${server.baseUrl}`;
      const lastAttempt = attemptsRef.current.get(attemptKey) ?? 0;
      if (inflightRef.current.has(attemptKey) || now - lastAttempt < RETRY_AFTER_MS) {
        continue;
      }
      attemptsRef.current.set(attemptKey, now);
      inflightRef.current.add(attemptKey);
      void (async () => {
        try {
          const payload = findEngineCredentialPayload(secrets, serverId);
          const credential = payload ? await openEngineCredential(payload, serverId) : null;
          if (!credential || cancelled) {
            return;
          }
          const { token } = await loginToEngine(
            server.baseUrl,
            credential.username,
            credential.password
          );
          if (cancelled) {
            return;
          }
          setStoredSessionToken(token, null, server.baseUrl);
          if (server.id === activeServer.id) {
            await auth.refreshAuthStatus().catch(() => undefined);
          }
          await refreshServerHealth().catch(() => undefined);
        } catch {
          // Wrong wrapping key, rotated engine password, or an unreachable
          // tunnel: the manual sign-in in Settings -> Servers still works.
        } finally {
          inflightRef.current.delete(attemptKey);
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [
    activeNeedsLogin,
    activeServer.id,
    auth,
    refreshServerHealth,
    secrets,
    serverStatusById,
    servers,
  ]);

  return null;
}
