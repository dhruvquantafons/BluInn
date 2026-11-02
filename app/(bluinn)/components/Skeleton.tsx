/** Shared shimmer block used by the admin loading states. */
export function Bar({ className = "" }: { className?: string }) {
  return <div className={`bg-slate-100 rounded animate-pulse ${className}`} />;
}

/** The page's hero banner, faded, with a title and description placeholder. */
export function HeroSkeleton() {
  return (
    <div className="admin-hero mb-6 px-6 sm:px-7 py-6 opacity-60">
      <div className="h-7 w-56 rounded bg-white/25 animate-pulse" />
      <div className="h-4 w-80 max-w-full rounded bg-white/20 animate-pulse mt-3" />
    </div>
  );
}

/** Placeholder matching the shape of a list or table page: hero banner, then a card of rows. */
export function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <>
      <HeroSkeleton />

      <div className="bg-white border border-slate-200 rounded-xl shadow-sm divide-y divide-slate-100">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Bar className="w-7 h-7 rounded-full" />
            <div className="flex-1 space-y-2">
              <Bar className="h-4 w-1/3" />
              <Bar className="h-3 w-24" />
            </div>
            <Bar className="h-4 w-40 hidden sm:block" />
            <Bar className="h-6 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </>
  );
}
