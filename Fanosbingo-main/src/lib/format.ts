/** የኛ money formatting. Balances are whole/half ETB — never divide. */
export function formatEtb(amount: number | string | null | undefined, opts: { symbol?: boolean } = {}): string {
  const n = Number(amount ?? 0);
  const s = (Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  return opts.symbol === false ? s : `${s} ETB`;
}

export function bingoLetter(num: number): string {
  if (num >= 1 && num <= 15) return 'B';
  if (num >= 16 && num <= 30) return 'I';
  if (num >= 31 && num <= 45) return 'N';
  if (num >= 46 && num <= 60) return 'G';
  if (num >= 61 && num <= 75) return 'O';
  return '';
}
