"use client";

import React, { useEffect } from "react";
import { Keyboard, X } from "lucide-react";

/**
 * Returns true when focus is inside a text-entry or form control where
 * single-key shortcuts (/, ?, n, Space, arrows, digits) must not fire.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

interface ShortcutItem {
  keys: string[];
  description: string;
}

interface ShortcutSection {
  title: string;
  items: ShortcutItem[];
}

const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Global & Search",
    items: [
      { keys: ["Ctrl", "F"], description: "Focus search bar (/, /targets, /tv)" },
      { keys: ["/"], description: "Quick-focus search bar" },
      {
        keys: ["Esc"],
        description: "Clear search text → blur search, or close active modal / drawer",
      },
      { keys: ["?"], description: "Toggle this keyboard shortcuts cheatsheet" },
    ],
  },
  {
    title: "Targets, Probes & Alerts",
    items: [
      { keys: ["n"], description: "New Target (/targets) or Register Probe (/probes)" },
      { keys: ["Esc"], description: "Close modal or cancel inline rule / channel edit" },
    ],
  },
  {
    title: "NOC TV Display (/tv)",
    items: [
      { keys: ["←", "→"], description: "Previous / Next carousel slide" },
      { keys: ["Space"], description: "Play / Pause auto-rotation (Slides mode)" },
      { keys: ["f"], description: "Toggle Fullscreen" },
      { keys: ["a"], description: "Toggle impaired targets filter (Warn / Alert)" },
      {
        keys: ["1", "–", "9"],
        description: "Switch graph window (15m, 1h, 3h, 6h, 12h, 24h, 3d, 7d, 30d)",
      },
    ],
  },
];

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsModal({
  open,
  onClose,
}: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      // Prevent background page shortcuts from firing while cheatsheet modal is open
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
      data-testid="keyboard-shortcuts-modal"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-emerald-500/15 border border-emerald-500/40 text-emerald-400">
              <Keyboard className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <h2
              id="shortcuts-modal-title"
              className="text-sm font-bold tracking-wide text-zinc-100"
            >
              Keyboard Shortcuts
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            className="rounded p-1 text-zinc-400 hover:bg-elevated hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto px-5 py-4 space-y-4">
          {SHORTCUT_SECTIONS.map((sec) => (
            <div key={sec.title} className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                {sec.title}
              </h3>
              <div className="divide-y divide-border/60 rounded-md border border-border bg-canvas/70">
                {sec.items.map((item) => (
                  <div
                    key={item.description}
                    className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                  >
                    <span className="text-zinc-200">{item.description}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {item.keys.map((k, idx) =>
                        k === "–" ? (
                          <span key={idx} className="text-zinc-500 text-[10px]">
                            –
                          </span>
                        ) : (
                          <kbd
                            key={`${k}-${idx}`}
                            className="inline-flex min-w-[22px] items-center justify-center rounded border border-border bg-elevated px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-zinc-100 shadow-sm"
                          >
                            {k}
                          </kbd>
                        )
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-canvas/50 px-5 py-2.5 text-[11px] text-zinc-400">
          <span>Shortcuts automatically pause while typing in forms or modals.</span>
          <span className="font-mono text-zinc-500">Esc to close</span>
        </div>
      </div>
    </div>
  );
}
