import { BRAND } from '../../config/brand';

interface LogoProps {
  className?: string;
  /** Show the wordmark text next to the mark (used where the image may not load). */
  withText?: boolean;
}

/**
 * Full የኛ bingo logo. Falls back to a styled text wordmark if the image
 * asset is missing (placeholder art ships in the repo — see
 * docs/YENA_BINGO_LOGO_PLACEMENT.md).
 */
export function Logo({ className = 'h-10 w-auto' }: LogoProps) {
  return (
    <img
      src={BRAND.assets.logo}
      alt={`${BRAND.fullName} logo`}
      className={className}
      onError={(e) => {
        const el = e.currentTarget;
        el.style.display = 'none';
        const sib = el.nextElementSibling as HTMLElement | null;
        if (sib) sib.style.display = '';
      }}
    />
  );
}

/** Square icon-only mark. */
export function LogoMark({ className = 'h-8 w-8' }: LogoProps) {
  return (
    <img
      src={BRAND.assets.logoMark}
      alt={`${BRAND.fullName}`}
      className={className}
    />
  );
}

/** Text-only wordmark, for tight spots and as the <Logo/> fallback. */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      <span className="text-emerald-500">የኛ</span>{' '}
      <span className="text-amber-500">bingo</span>
    </span>
  );
}
