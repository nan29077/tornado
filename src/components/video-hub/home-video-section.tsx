export function HomeVideoPaneSkeleton({ inDialog = false }: { inDialog?: boolean }) {
  return (
    <div className={inDialog ? undefined : 'rounded-[22px] border border-white/80 bg-white/90 p-3.5'} aria-hidden>
      {inDialog ? null : <div className="h-10 w-36 animate-pulse rounded-lg bg-ink-100" />}
      <div className={inDialog ? 'mb-3 h-28 animate-pulse rounded-xl bg-ink-100' : 'mb-3 mt-3 h-12 animate-pulse rounded-xl bg-ink-100'} />
      <div className="aspect-video animate-pulse rounded-xl bg-ink-100" />
      <div className="mt-3 h-12 animate-pulse rounded-lg bg-ink-100" />
      <div className="mt-3 h-10 animate-pulse rounded-lg bg-ink-50" />
    </div>
  );
}

