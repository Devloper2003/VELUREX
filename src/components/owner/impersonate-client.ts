"use client";

import { useSession } from "@/lib/store";
import { useImpersonation } from "@/lib/owner-store";

/**
 * Owner "Login As" flow: audits IMPERSONATE_START server-side, parks the owner
 * session in the impersonation store, and swaps the active session to the
 * tenant admin. The ImpersonationBanner handles the exit (also audited).
 */
export async function startImpersonation(propertyId: string, propertyName: string): Promise<void> {
  const { token, setSession, user } = useSession.getState();
  if (!token || !user || user.role !== "software_owner") {
    throw new Error("Only the software owner can impersonate");
  }

  const res = await fetch("/api/owner/impersonate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "start", propertyId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? "Impersonation failed");

  // Park the owner session, then swap the live session to the tenant admin.
  useImpersonation.getState().start({
    ownerToken: token,
    ownerUser: { id: user.id, name: user.name, email: user.email },
    tenantName: propertyName,
  });

  setSession(data.token, {
    id: data.user.id,
    name: data.user.name,
    email: data.user.email,
    role: data.user.role,
    propertyId: data.user.propertyId,
    propertyName: data.user.propertyName,
  });
}
