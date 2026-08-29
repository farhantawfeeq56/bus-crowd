'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Band } from '@/lib/client';

const BAND_BAR: Record<Band, string> = {
  ok:   'bg-gradient-to-r from-[#1f9e68] to-ok',
  warn: 'bg-gradient-to-r from-[#c98c1c] to-warn',
  crit: 'bg-gradient-to-r from-[#c2313f] to-crit',
};

const PILL_TONE: Record<string, string> = {
  ok:     'text-ok border-ok/35 bg-ok/10',
  warn:   'text-warn border-warn/35 bg-warn/10',
  crit:   'text-crit border-crit/35 bg-crit/10',
  accent: 'text-accent border-accent/35 bg-accent/10',
  muted:  'text-ink-2 border-line',
};

export function Pill({ tone = 'muted', children }: { tone?: string; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px]
        font-mono text-[10.5px] uppercase tracking-[0.06em] ${PILL_TONE[tone] ?? PILL_TONE.muted}`}
    >
      {children}
    </span>
  );
}

/** Occupancy bar. Width animates so a transfer is visible from the back row. */
export function LoadBar({ pct, band }: { pct: number; band: Band }) {
  return (
    <div className="h-[9px] overflow-hidden rounded-full bg-panel-2">
      <div
        className={`h-full rounded-full transition-[width,background] duration-500 ease-out ${BAND_BAR[band]}`}
        style={{ width: `${Math.min(100, (pct ?? 0) * 100)}%` }}
      />
    </div>
  );
}

export function Card({
  title, children, className = '', bodyClassName = '',
}: { title?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-panel p-4 ${className}`}>
      {title && (
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-ink-2">
          {title}
        </h2>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function TopBar({
  tag, live, children,
}: { tag?: string; live: boolean; children?: ReactNode }) {
  return (
    <header className="flex items-center gap-3.5 border-b border-line bg-panel px-4.5 py-3">
      <Link href="/" className="text-base font-bold tracking-tight">
        Bus<span className="text-accent">Mesh</span>
      </Link>
      {tag && <Tag>{tag}</Tag>}
      {children}
      <div className="flex-1" />
      <div className="flex items-center gap-2 font-mono text-[11px] text-ink-2">
        <span
          className={`size-[7px] rounded-full ${live ? 'bg-ok animate-pulse-ring' : 'bg-crit'}`}
        />
        <span>{live ? 'live' : 'connecting'}</span>
      </div>
    </header>
  );
}

export function Tag({ children, href }: { children: ReactNode; href?: string }) {
  const cls =
    'whitespace-nowrap rounded-full border border-line px-2.5 py-[3px] font-mono text-[11px] text-ink-2';
  return href
    ? <Link href={href} className={`${cls} transition hover:border-accent hover:text-accent`}>{children}</Link>
    : <span className={cls}>{children}</span>;
}

export function Toast({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      className="animate-pop-in fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full
        bg-ok px-5 py-2.5 text-[13px] font-bold text-[#04070c] shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
      role="status"
    >
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-3.5 text-center text-[13px] text-ink-3">{children}</div>;
}

export const inputClass =
  'w-full rounded-lg border border-line bg-panel-2 px-3 py-2.5 text-ink outline-none ' +
  'focus:border-accent';

export const btnClass =
  'rounded-[10px] border border-line bg-panel-2 px-4 py-2.5 text-center text-sm font-semibold ' +
  'transition hover:enabled:border-accent hover:enabled:text-accent ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

export const btnPrimaryClass =
  'rounded-[10px] border border-accent bg-accent px-4 py-2.5 text-center text-sm font-semibold ' +
  'text-[#04070c] transition hover:enabled:brightness-110 disabled:cursor-not-allowed disabled:opacity-40';
