"use client";

import { useEffect } from "react";
import { useSession } from "@/lib/store";
import { useImpersonation } from "@/lib/owner-store";
import { LoginScreen } from "@/components/auth/LoginScreen";
import { AppShell } from "@/components/shell/AppShell";
import { OwnerShell } from "@/components/owner/OwnerShell";
import { ImpersonationBanner } from "@/components/owner/ImpersonationBanner";
import { isPlatformRole } from "@/lib/owner-roles";
import { Loader2 } from "lucide-react";

export default function Home() {
  const { user, hydrated, token } = useSession();
  const impersonation = useImpersonation();

  // Guard: an impersonation session whose owner token is gone → drop the flag.
  useEffect(() => {
    if (impersonation.active && !token) {
      impersonation.end();
    }
  }, [token]);

  if (!hydrated) {
    return (
      <div className="min-h-screen bg-plaster flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-6 w-6 animate-spin text-brass" />
          <p className="text-sm text-muted-ink tracking-wide">Velurex HMS</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginScreen />;
  }

  // Platform console — the software owner AND invited team members
  // (platform_admin / platform_support / platform_finance) all land here.
  if (isPlatformRole(user.role)) {
    return <OwnerShell />;
  }

  return (
    <div className="min-h-screen flex flex-col">
      {impersonation.active && <ImpersonationBanner />}
      <div className="flex-1 flex flex-col">
        <AppShell />
      </div>
    </div>
  );
}
