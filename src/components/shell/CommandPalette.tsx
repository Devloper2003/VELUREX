"use client";

import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import {
  LogIn, MoonStar, Sparkles, ReceiptIndianRupee, MessageCircle, ConciergeBell,
} from "lucide-react";
import type { ViewKey } from "@/lib/store";
import { NAV, VIEW_TITLES, GO_KEYS, isGroup, type NavItem } from "./nav-config";

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowed: ViewKey[];
  view: ViewKey;
  onNavigate: (key: ViewKey) => void;
  onNewReservation: () => void;
}

/** Flatten NAV to role-allowed items in display order. */
function flatAllowed(allowed: ViewKey[]): NavItem[] {
  const out: NavItem[] = [];
  for (const entry of NAV) {
    if (isGroup(entry)) {
      for (const item of entry.items) {
        if (allowed.includes(item.key)) out.push(item);
      }
    } else if (allowed.includes(entry.key)) {
      out.push(entry);
    }
  }
  return out;
}

export function CommandPalette({ open, onOpenChange, allowed, view, onNavigate, onNewReservation }: CommandPaletteProps) {
  // The input is uncontrolled — remounting it on open (via key) clears the query
  const items = flatAllowed(allowed);
  const canNewReservation = allowed.includes("reservations");

  const run = (fn: () => void) => {
    onOpenChange(false);
    // Let the dialog unmount before the view swap for a clean transition
    setTimeout(fn, 60);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a module or run a quick action"
      className="command-palette"
    >
      <CommandInput key={open ? "open" : "closed"} placeholder="Type a command or search modules…" />
      <CommandList className="scroll-slim">
        <CommandEmpty>No matching commands — try “reservations” or “audit”.</CommandEmpty>

        {canNewReservation && (
          <>
            <CommandGroup heading="Quick actions">
              <CommandItem
                value="new reservation create booking"
                onSelect={() => run(onNewReservation)}
                className="gap-2.5"
              >
                <Sparkles className="h-4 w-4 text-brass" />
                <span>New reservation</span>
                <kbd className="cmd-kbd">N</kbd>
              </CommandItem>
              {items
                .filter((i) => i.key === "night-audit" || i.key === "billing" || i.key === "whatsapp" || i.key === "pos")
                .map((i) => (
                  <CommandItem
                    key={`qa-${i.key}`}
                    value={`${i.label} quick action`}
                    onSelect={() => run(() => onNavigate(i.key))}
                    className="gap-2.5"
                  >
                    {i.key === "night-audit" && <MoonStar className="h-4 w-4 text-pine-700" />}
                    {i.key === "billing" && <ReceiptIndianRupee className="h-4 w-4 text-brass" />}
                    {i.key === "whatsapp" && <MessageCircle className="h-4 w-4 text-ok" />}
                    {i.key === "pos" && <ConciergeBell className="h-4 w-4 text-brass" />}
                    <span>{i.label}</span>
                    <span className="ml-auto text-[11px] text-muted-ink">jump</span>
                  </CommandItem>
                ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}

        <CommandGroup heading="Go to">
          {items.map((i) => {
            const goKey = Object.entries(GO_KEYS).find(([, v]) => v === i.key)?.[0];
            return (
              <CommandItem
                key={i.key}
                value={`${VIEW_TITLES[i.key]} ${i.label}`}
                onSelect={() => run(() => onNavigate(i.key))}
                className="gap-2.5"
                data-active-view={view === i.key || undefined}
              >
                <i.icon className="h-4 w-4 text-pine-700" />
                <span>{VIEW_TITLES[i.key]}</span>
                {view === i.key && <span className="text-[10px] font-semibold uppercase tracking-wider text-brass">current</span>}
                {goKey && <kbd className="cmd-kbd ml-auto">g {goKey.toUpperCase()}</kbd>}
              </CommandItem>
            );
          })}
        </CommandGroup>

        <CommandSeparator />
        <CommandGroup heading="Help">
          <CommandItem
            value="keyboard shortcuts help"
            onSelect={() => run(() => window.dispatchEvent(new CustomEvent("velurex:shortcuts-help")))}
            className="gap-2.5"
          >
            <LogIn className="h-4 w-4 rotate-90 text-muted-ink" />
            <span>Keyboard shortcuts</span>
            <kbd className="cmd-kbd ml-auto">?</kbd>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <div className="border-t border-line px-4 py-2.5 flex items-center justify-between text-[11px] text-muted-ink bg-plaster/50">
        <span>
          <kbd className="cmd-kbd">↑↓</kbd> navigate · <kbd className="cmd-kbd">↵</kbd> select · <kbd className="cmd-kbd">esc</kbd> close
        </span>
        <span className="font-display italic text-brass">Velurex</span>
      </div>
    </CommandDialog>
  );
}

interface ShortcutRow {
  keys: string[];
  action: string;
}

const SHORTCUT_GROUPS: { heading: string; rows: ShortcutRow[] }[] = [
  {
    heading: "Workspace",
    rows: [
      { keys: ["Ctrl", "K"], action: "Open / close the command palette" },
      { keys: ["?"], action: "Show this shortcuts help" },
      { keys: ["N"], action: "New reservation" },
    ],
  },
  {
    heading: "Go to module (press G, then the key)",
    rows: [
      { keys: ["G", "D"], action: "Dashboard" },
      { keys: ["G", "R"], action: "Reservations" },
      { keys: ["G", "C"], action: "Availability Calendar" },
      { keys: ["G", "G"], action: "Guests" },
      { keys: ["G", "M"], action: "Rooms" },
      { keys: ["G", "B"], action: "Billing & Folio" },
      { keys: ["G", "H"], action: "Housekeeping" },
      { keys: ["G", "K"], action: "Kitchen (KOT)" },
      { keys: ["G", "P"], action: "POS Terminal" },
      { keys: ["G", "N"], action: "Night Audit" },
      { keys: ["G", "S"], action: "Settings" },
    ],
  },
];

/** Brand-styled shortcuts cheat-sheet, opened via ? or the palette Help group. */
export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Keyboard shortcuts" description="Velurex HMS shortcut reference" showCloseButton className="command-palette">
      <CommandList className="max-h-[70vh] scroll-slim">
        {SHORTCUT_GROUPS.map((group) => (
          <div key={group.heading} className="px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink px-2 py-1.5">{group.heading}</p>
            {group.rows.map((row) => (
              <div key={row.action} className="flex items-center justify-between gap-4 rounded-md px-2 py-2 hover:bg-plaster/60">
                <span className="text-[13px] text-ink">{row.action}</span>
                <span className="flex items-center gap-1 shrink-0">
                  {row.keys.map((k, idx) => (
                    <span key={idx} className="flex items-center gap-1">
                      {idx > 0 && <span className="text-[10px] text-muted-ink">then</span>}
                      <kbd className="cmd-kbd">{k}</kbd>
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
