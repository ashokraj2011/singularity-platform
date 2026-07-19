"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, ChevronRight, Circle, Compass, X } from "lucide-react";
import type { SynProject } from "@/components/synthesis/types";

/**
 * The guided path through Synthesis Studio.
 *
 * The nav offers 22 screens across five phases. That is right for someone who
 * already knows the model and wrong for a product owner opening it the first
 * time, who has no way to tell which of the 22 is the one to touch now. The
 * screens are not the problem; the absence of an order is.
 *
 * So this does not replace the nav or hide anything — it names the seven steps
 * that actually move an initiative from idea to generated work, in order, and
 * shows which one you are on. Everything else stays reachable for people who
 * know what they want.
 *
 * Completion is DERIVED from the project's own counters rather than stored. A
 * stored "wizard progress" flag would drift the moment someone did the work from
 * the normal nav — which is exactly what an experienced user will do — and then
 * the guide would be lying about a step that was finished days ago.
 */

export type HappyPathStep = {
  key: string;
  label: string;
  /** What this step is FOR, in the product owner's terms, not the system's. */
  purpose: string;
  href: (projectId: string) => string;
  /** Undefined = cannot be determined from what the hub already loads. */
  done?: boolean;
};

/**
 * The seven steps, in order.
 *
 * Deliberately not one step per nav item: Explore alone has five screens, and
 * listing them all would reproduce the problem this is meant to solve. Each step
 * is a decision a product owner actually makes; the screens under it are how.
 */
export function happyPathSteps(project: SynProject | null | undefined, objectiveCount?: number): HappyPathStep[] {
  const claims = project?.claimCount ?? 0;
  const work = project?.workItemCount ?? 0;
  return [
    {
      key: "frame",
      label: "Frame the initiative",
      purpose: "Say what changes for the business when this succeeds.",
      href: (id) => `/synthesis/overview?project=${id}`,
      done: Boolean(project?.mission && project.mission.trim()),
    },
    {
      key: "objective",
      label: "Fund an objective",
      purpose: "An objective with no work is unfunded intent — this is what everything later traces back to.",
      href: (id) => `/synthesis/business?project=${id}`,
      done: objectiveCount == null ? undefined : objectiveCount > 0,
    },
    {
      key: "intake",
      label: "Bring in what you already know",
      purpose: "Drop in documents or links so the agents start from your context, not a blank page.",
      href: (id) => `/synthesis/intake?project=${id}`,
      done: claims > 0,
    },
    {
      key: "explore",
      label: "Capture and challenge the facts",
      purpose: "Turn what you know into claims, then let the rooms contest the shaky ones.",
      href: (id) => `/synthesis/ideas?project=${id}`,
      done: claims > 0,
    },
    {
      key: "decide",
      label: "Choose an approach",
      purpose: "Compare options and record why you picked one, so the reasoning survives you.",
      href: (id) => `/synthesis/options?project=${id}`,
    },
    {
      key: "specify",
      label: "Write the specification",
      purpose: "State the requirements and tie each one to the objective that pays for it.",
      href: (id) => `/synthesis/spec?project=${id}`,
    },
    {
      key: "generate",
      label: "Generate the work",
      purpose: "Compile the specification into work items teams can pick up.",
      href: (id) => `/synthesis/generate?project=${id}`,
      done: work > 0,
    },
  ];
}

const DISMISS_KEY = "syn-happy-path-dismissed";

export function HappyPathGuide({ project, objectiveCount }: { project: SynProject | null | undefined; objectiveCount?: number }) {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setMounted(true);
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === "1");
    } catch {
      /* private mode — just show it */
    }
  }, []);

  if (!mounted || dismissed || !project) return null;

  const steps = happyPathSteps(project, objectiveCount);
  // "Current" is the first step not known to be done. A step whose state cannot
  // be determined does not block progress — better to point slightly too far
  // ahead than to park someone on a step they finished.
  const currentIndex = Math.max(0, steps.findIndex((step) => step.done !== true));
  const doneCount = steps.filter((step) => step.done === true).length;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* nothing to persist to; it will reappear next visit */
    }
  }

  return (
    <section className="mb-6 rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-secondary-container text-on-secondary-container">
          <Compass size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-display text-base font-semibold text-on-surface">The path through this initiative</h2>
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 rounded-md p-1 text-on-surface-variant transition-colors hover:text-on-surface"
              aria-label="Hide the guided path"
              title="Hide — the full menu is always in the sidebar"
            >
              <X size={14} />
            </button>
          </div>
          <p className="mt-0.5 text-sm text-on-surface-variant">
            Seven steps from idea to generated work. {doneCount} done. Every other screen stays in the sidebar.
          </p>

          <ol className="mt-4 grid gap-1.5">
            {steps.map((step, index) => {
              const isDone = step.done === true;
              const isCurrent = index === currentIndex && !isDone;
              return (
                <li key={step.key}>
                  <Link
                    href={step.href(project.id)}
                    className={`flex items-start gap-3 rounded-md px-3 py-2 transition-colors ${
                      isCurrent ? "bg-secondary-container/40 ring-1 ring-secondary" : "hover:bg-surface-container"
                    }`}
                  >
                    <span className={`mt-0.5 shrink-0 ${isDone ? "text-secondary" : isCurrent ? "text-secondary" : "text-on-surface-variant"}`}>
                      {isDone ? <Check size={15} /> : <Circle size={15} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm ${isDone ? "text-on-surface-variant line-through decoration-1" : "font-semibold text-on-surface"}`}>
                        {index + 1}. {step.label}
                      </span>
                      {!isDone ? <span className="mt-0.5 block text-xs text-on-surface-variant">{step.purpose}</span> : null}
                    </span>
                    {isCurrent ? (
                      <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs font-bold text-secondary">
                        Start here <ChevronRight size={13} />
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </section>
  );
}
