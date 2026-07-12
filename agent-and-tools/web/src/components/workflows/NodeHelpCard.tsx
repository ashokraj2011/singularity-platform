import Link from "next/link";
import { BookOpen, CheckCircle2, Clock3, Info, Settings2, Sparkles } from "lucide-react";
import { guideNode } from "@/lib/platformGuide";

export function NodeHelpCard({ nodeType, compact = false }: { nodeType: string; compact?: boolean }) {
  const guide = guideNode(nodeType);
  return (
    <div
      style={{
        border: "1px solid var(--color-outline-variant)",
        borderRadius: 8,
        padding: compact ? 11 : 13,
        background: "var(--color-surface-container)",
        display: "grid",
        gap: compact ? 7 : 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0 }}>
          <span style={{ color: "var(--accent-workflow)", marginTop: 1 }} aria-hidden><Info size={15} /></span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 850, fontSize: compact ? 12 : 13, color: "var(--color-on-surface)" }}>{guide.label}</div>
            <div style={{ color: "var(--color-outline)", fontSize: 11, lineHeight: 1.45 }}>{guide.summary}</div>
          </div>
        </div>
        <Link
          href={`/help#node-${guide.key}`}
          className="btn-secondary text-xs"
          style={{ flexShrink: 0, padding: "5px 7px" }}
          title={`Open full help for ${guide.label}`}
        >
          <BookOpen size={12} />
          {compact ? "Details" : "Guide"}
        </Link>
      </div>
      {!compact && (
        <>
          <div style={{ display: "grid", gap: 6, fontSize: 11, lineHeight: 1.45, color: "var(--color-outline)" }}>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}><Sparkles size={13} style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-workflow)" }} /><span><strong style={{ color: "var(--color-on-surface)" }}>Use it when:</strong> {guide.whenToUse}</span></div>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}><Clock3 size={13} style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-workflow)" }} /><span><strong style={{ color: "var(--color-on-surface)" }}>Runs:</strong> {guide.execution}</span></div>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start" }}><CheckCircle2 size={13} style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-evidence)" }} /><span><strong style={{ color: "var(--color-on-surface)" }}>Produces:</strong> {guide.output}</span></div>
          </div>
          <div style={{ display: "flex", gap: 7, alignItems: "flex-start", paddingTop: 8, borderTop: "1px solid var(--color-outline-variant)", color: "var(--color-outline)", fontSize: 11, lineHeight: 1.45 }}>
            <Settings2 size={13} style={{ flexShrink: 0, marginTop: 1, color: "var(--accent-workflow)" }} />
            <span><strong style={{ color: "var(--color-on-surface)" }}>Configure:</strong> {guide.configuration.join(" · ")}</span>
          </div>
          {guide.caution && <div style={{ color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "7px 8px", fontSize: 11, lineHeight: 1.45 }}><strong>Watch for:</strong> {guide.caution}</div>}
        </>
      )}
    </div>
  );
}
