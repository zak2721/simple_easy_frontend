import { useState } from 'react';
import { adminApi, PlayerRow, OperatorRow } from '../adminApi';

type Category = 'ALL' | 'PLAYERS' | 'OPERATORS' | 'ADMINS';

interface SearchResult {
  type: 'player' | 'operator' | 'admin';
  id: string;
  name: string;
  subtitle: string;
  tenant?: string;
  status?: string;
}

function typeBadgeClass(type: SearchResult['type']): string {
  return {
    player: 'bg-blue-100 text-blue-700',
    operator: 'bg-purple-100 text-purple-700',
    admin: 'bg-slate-100 text-slate-700',
  }[type];
}

export function GlobalSearch() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('ALL');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const search = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setErr(null);
    setResults([]);
    setSearched(true);

    try {
      const out: SearchResult[] = [];

      if (category === 'ALL' || category === 'PLAYERS') {
        try {
          const r = await adminApi.listPlayers({ search: query, take: 20 });
          r.players.forEach((p: PlayerRow) => {
            out.push({
              type: 'player',
              id: String(p.telegram_user_id),
              name: p.first_name || p.username || `Player #${p.telegram_user_id}`,
              subtitle: `@${p.username ?? '—'} · Telegram ID ${p.telegram_user_id}`,
              status: p.status,
            });
          });
        } catch {
          // skip if endpoint unavailable
        }
      }

      if (category === 'ALL' || category === 'OPERATORS') {
        try {
          const ops = await adminApi.listOperators();
          const q = query.toLowerCase();
          ops
            .filter((o: OperatorRow) => o.name.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q))
            .slice(0, 20)
            .forEach((o: OperatorRow) => {
              out.push({
                type: 'operator',
                id: o.id,
                name: o.name,
                subtitle: `slug: ${o.slug} · ${o.players} players`,
                status: o.status,
              });
            });
        } catch {
          // skip if endpoint unavailable
        }
      }

      if (category === 'ALL' || category === 'ADMINS') {
        try {
          const admins = await adminApi.listAdmins();
          const q = query.toLowerCase();
          admins
            .filter((a) => a.username.toLowerCase().includes(q) || (a.fullName ?? '').toLowerCase().includes(q))
            .slice(0, 20)
            .forEach((a) => {
              out.push({
                type: 'admin',
                id: a.id,
                name: a.fullName || a.username,
                subtitle: `@${a.username} · ${a.role}`,
                status: a.status,
              });
            });
        } catch {
          // skip if endpoint unavailable
        }
      }

      setResults(out);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') search();
  };

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Global Search</h1>

      <div className="mb-4 flex gap-2">
        <div className="relative flex-1">
          <input
            className="w-full rounded-lg border border-slate-300 py-2.5 pl-10 pr-3 text-sm focus:border-emerald-500 focus:outline-none"
            placeholder="Search players, operators, admins…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
        </div>
        <select
          className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={category}
          onChange={(e) => setCategory(e.target.value as Category)}
        >
          <option value="ALL">All</option>
          <option value="PLAYERS">Players</option>
          <option value="OPERATORS">Operators</option>
          <option value="ADMINS">Admins</option>
        </select>
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {loading ? '…' : 'Search'}
        </button>
      </div>

      {err && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-600">{err}</p>}

      {!searched && !loading && (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
          <svg className="mx-auto mb-3 h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <p>Enter a search term above to find players, operators, and admins</p>
        </div>
      )}

      {searched && !loading && results.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-400">
          <p>No results found for <strong className="text-slate-600">"{query}"</strong></p>
          <p className="mt-1 text-xs">Try a different search term or category</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-slate-500">{results.length} result{results.length !== 1 ? 's' : ''} for "{query}"</p>
          {results.map((r) => (
            <div key={`${r.type}-${r.id}`} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold uppercase ${typeBadgeClass(r.type)}`}>
                {r.type}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{r.name}</p>
                <p className="truncate text-xs text-slate-400">{r.subtitle}</p>
              </div>
              {r.tenant && (
                <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{r.tenant}</span>
              )}
              {r.status && (
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium capitalize ${
                  r.status === 'active' ? 'bg-green-100 text-green-700'
                  : r.status === 'suspended' ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-red-100 text-red-700'
                }`}>{r.status}</span>
              )}
              <span className="shrink-0 font-mono text-xs text-slate-300">{r.id.slice(0, 8)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
