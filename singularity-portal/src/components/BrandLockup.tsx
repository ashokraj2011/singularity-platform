import { cn } from '@/lib/cn'

/**
 * Singularity brand lockup — silver swirl + "Singularity / Governed Agentic
 * Delivery" wordmark. Two variants:
 *   compact  — sidebar header
 *   hero     — login pages, marketing surfaces
 *
 * Asset path: /singularity-logo.png  (full lockup)
 *             /singularity-mark.png  (swirl only — preferred when we render
 *                                     the wordmark in HTML for crisper text)
 *
 * Run ./bin/sync-branding.sh from the repo root to refresh the assets.
 */
export function BrandLockup({
  variant = 'compact',
  className,
}: {
  variant?: 'compact' | 'hero'
  className?: string
}) {
  const isHero = variant === 'hero'
  const markSize = isHero ? 56 : 36

  return (
    <div className={cn('flex items-center gap-3', isHero && 'flex-col gap-4', className)}>
      <img
        src="/singularity-mark.png"
        alt="Singularity"
        width={markSize}
        height={markSize}
        className="shrink-0 select-none"
        style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.25))' }}
        // Fall back to the full lockup if the mark-only file isn't synced yet
        onError={(e) => { (e.currentTarget as HTMLImageElement).src = '/singularity-logo.png' }}
      />
      <div className={isHero ? 'text-center' : 'leading-tight'}>
        <div
          className="brand-wordmark leading-none"
          style={{ fontSize: isHero ? 22 : 14 }}
        >
          Singularity
        </div>
        <div
          className="brand-tagline mt-1 leading-none"
          style={{ fontSize: isHero ? 11 : 9 }}
        >
          Governed Agentic Delivery
        </div>
      </div>
    </div>
  )
}
