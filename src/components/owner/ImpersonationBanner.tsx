"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/lib/store";
import { useImpersonation, useOwner } from "@/lib/owner-store";
import { EyeOff, Loader2 } from "lucide-react";

/**
 * Persistent banner shown while a software owner impersonates a tenant admin.
 * Exit restores the parked owner session and returns to the Businesses view.
 */
export function ImpersonationBanner() {
  const { user, token, setSession } = useSession();
  const impersonation = useImpersonation();
  const { setView } = useOwner();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const exit = async () => {
    if (busy) return;
    setBusy(true);
    // Audited server-side (IMPERSONATE_END).
    await fetch("/api/owner/impersonate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${impersonation.ownerToken}` },
      body: JSON.stringify({ action: "exit", propertyId: user?.propertyId ?? "" }),
    }).catch(() => {});
    if (impersonation.ownerToken && impersonation.ownerUser) {
      setSession(impersonation.ownerToken, {
        id: impersonation.ownerUser.id,
        name: impersonation.ownerUser.name,
        email: impersonation.ownerUser.email,
        role: "software_owner",
        propertyId: "",
        propertyName: "Velurex Platform",
      });
    }
    impersonation.end();
    setView("businesses");
    router.refresh();
  };

  return (
    <div className="bg-pine text-panel px-4 py-2 flex items-center justify-center gap-3 text-[13px]" role="status">
      <span className="hidden sm:inline-flex h-2 w-2 rounded-full bg-brass-light animate-pulse" aria-hidden />
      <span>
        You are impersonating <strong className="text-brass-light">{user?.name}</strong>
        <span className="text-panel/60"> · {user?.propertyName}</span>
      </span>
      <button
        onClick={exit}
        disabled={busy}
        className="inline-flex items-center gap-1.5 h-7 px-3 rounded-full bg-brass text-pine text-[12px] font-semibold hover:bg-brass-light transition disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <EyeOff className="h-3.5 w-3.5" />}
        Exit impersonation
      </button>
    </div>
  );
}
