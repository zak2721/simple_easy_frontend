/**
 * Telebirr payment-method badge, shown above the Deposit/Withdraw forms.
 *
 * `public/telebirr-logo.svg` is a hand-recreated approximation of the
 * Telebirr mark (flag + spiral), not the original licensed artwork — no
 * source file for that asset was available to embed pixel-perfectly. Drop
 * the real file at the same path (same name, .svg or .png) to replace it;
 * no code change is needed since this just references that path.
 */
export function TelebirrBrandBar() {
  return (
    <div className="mb-3 flex justify-center">
      <div className="flex items-center gap-2 rounded-full border border-[var(--eds-border)] bg-white/5 px-3 py-1.5">
        <img src="/telebirr-logo.svg" alt="telebirr" className="h-7 w-7 rounded-md" />
        <span className="text-sm font-bold tracking-wide text-sky-300">telebirr</span>
      </div>
    </div>
  );
}
