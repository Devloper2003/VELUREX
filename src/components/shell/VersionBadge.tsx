"use client";

import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { APP_NAME, APP_RELEASE_CODENAME, APP_RELEASE_DATE, APP_VERSION, APP_VERSION_TAG, RELEASES } from "@/lib/version";
import { cn } from "@/lib/utils";

/**
 * VersionBadge — small brass pill showing the live release (e.g. "v2.0.0").
 * Clicking it opens the "What's new" dialog rendered from src/lib/version.ts,
 * so every release in the series is visible in-app without leaving the product.
 */
export function VersionBadge({ variant = "dark", className }: { variant?: "dark" | "light"; className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`${APP_NAME} ${APP_VERSION_TAG} — what's new`}
        title={`${APP_NAME} ${APP_VERSION_TAG} · ${APP_RELEASE_CODENAME} — click for release notes`}
        className={cn(
          "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-wide transition cursor-pointer",
          variant === "dark"
            ? "border-brass/40 bg-brass/10 text-brass-light hover:bg-brass/20"
            : "border-brass/50 bg-brass/10 text-brass hover:bg-brass/20",
          className,
        )}
      >
        <Sparkles className="h-2.5 w-2.5" aria-hidden />
        {APP_VERSION_TAG}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display">
              <Sparkles className="h-4 w-4 text-brass" aria-hidden />
              What&apos;s new in {APP_NAME}
            </DialogTitle>
            <DialogDescription>
              Live release series — currently on{" "}
              <span className="font-semibold text-pine">
                {APP_VERSION_TAG} · {APP_RELEASE_CODENAME}
              </span>{" "}
              ({APP_RELEASE_DATE}).
            </DialogDescription>
          </DialogHeader>

          <ol className="space-y-4 pr-1">
            {RELEASES.map((rel, idx) => (
              <li key={rel.version} className="relative pl-4 border-l border-line-strong">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className={cn("font-display text-[15px] font-semibold", idx === 0 ? "text-brass" : "text-pine")}>
                    v{rel.version}
                  </span>
                  <span className="text-[11px] uppercase tracking-[0.14em] text-muted-ink">{rel.codename}</span>
                  <span className="text-[11px] text-muted-ink">· {rel.date}</span>
                  {idx === 0 && (
                    <span className="rounded-full bg-ok/10 text-ok text-[10px] font-semibold px-2 py-0.5">live</span>
                  )}
                </div>
                <ul className="mt-1.5 space-y-1">
                  {rel.highlights.map((h) => (
                    <li key={h} className="text-[12.5px] leading-relaxed text-ink/90 flex gap-1.5">
                      <span className="text-brass mt-[1px] shrink-0" aria-hidden>
                        •
                      </span>
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <p className="text-[11px] text-muted-ink border-t border-line pt-3">
            Full history lives in <span className="font-mono">CHANGELOG.md</span>. Every update ships under a
            version bump — patch for fixes, minor for feature drops, major for milestones.
          </p>

          <button
            type="button"
            onClick={() => setOpen(false)}
            className="absolute right-4 top-4 rounded-sm opacity-70 transition hover:opacity-100"
            aria-label="Close release notes"
          >
            <X className="h-4 w-4" />
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
