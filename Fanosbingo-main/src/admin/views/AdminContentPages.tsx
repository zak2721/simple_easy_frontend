import { useCallback, useEffect, useState } from 'react';
import { adminApi, ContentPageRow } from '../adminApi';

type PageType = 'ABOUT' | 'TERMS_AND_CONDITIONS' | 'RESPONSIBLE_GAMING' | 'GAME_INSTRUCTIONS';

const PAGE_LABELS: Record<PageType, string> = {
  ABOUT: 'About',
  TERMS_AND_CONDITIONS: 'Terms & Conditions',
  RESPONSIBLE_GAMING: 'Responsible Gaming',
  GAME_INSTRUCTIONS: 'Game Instructions',
};

const APPROVAL_REQUIRED: PageType[] = ['TERMS_AND_CONDITIONS', 'RESPONSIBLE_GAMING'];

function PageEditor({
  pageType,
  isPlatformAdmin,
  operatorId,
}: {
  pageType: PageType;
  isPlatformAdmin: boolean;
  operatorId?: string;
}) {
  const [page, setPage] = useState<ContentPageRow | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    const req = isPlatformAdmin && !operatorId
      ? adminApi.getPlatformContentPage(pageType)
      : adminApi.getContentPage(pageType, operatorId);
    req
      .then((p) => {
        setPage(p);
        setTitle(p.title);
        setBody(p.bodyMarkdown);
      })
      .catch(() => { setTitle(''); setBody(''); setPage(null); })
      .finally(() => setLoading(false));
  }, [pageType, isPlatformAdmin, operatorId]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!title.trim()) return setMsg({ type: 'err', text: 'Title is required' });
    if (!body.trim()) return setMsg({ type: 'err', text: 'Body is required' });
    setSaving(true);
    setMsg(null);
    try {
      const req = isPlatformAdmin && !operatorId
        ? adminApi.upsertPlatformContentPage(pageType, { title: title.trim(), bodyMarkdown: body.trim() })
        : adminApi.upsertContentPage(pageType, { title: title.trim(), bodyMarkdown: body.trim() }, operatorId);
      const result = await req;
      const wasQueued = (result as { status?: string }).status === 'pending';
      setMsg({ type: 'ok', text: wasQueued ? 'Submitted for Super Admin approval.' : 'Saved.' });
      if (!wasQueued) load();
    } catch (e) {
      setMsg({ type: 'err', text: e instanceof Error ? e.message : 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const needsApproval = !isPlatformAdmin && APPROVAL_REQUIRED.includes(pageType);

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>;

  return (
    <div className="space-y-3">
      {needsApproval && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Changes to this page require Super Admin approval before going live.
        </p>
      )}
      <div>
        <label className="mb-1 block text-xs font-semibold text-slate-500">Title</label>
        <input
          className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold text-slate-500">Body (Markdown)</label>
        <textarea
          className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
          rows={16}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={100_000}
        />
        <p className="mt-1 text-xs text-slate-400">{body.length.toLocaleString()} / 100,000 characters</p>
      </div>
      {page && (
        <p className="text-xs text-slate-400">
          Last updated: {new Date(page.updatedAt).toLocaleString()}
        </p>
      )}
      {msg && (
        <p className={`rounded-lg px-3 py-2 text-sm ${msg.type === 'ok' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
          {msg.text}
        </p>
      )}
      <button
        onClick={save}
        disabled={saving}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        {saving ? 'Saving…' : needsApproval ? 'Submit for approval' : 'Save'}
      </button>
    </div>
  );
}

export function AdminContentPages({
  isPlatformAdmin,
  operatorId,
}: {
  isPlatformAdmin: boolean;
  operatorId?: string;
}) {
  const [tab, setTab] = useState<PageType>('ABOUT');
  const pages = Object.keys(PAGE_LABELS) as PageType[];

  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">Content Pages</h1>
      <div className="mb-4 flex flex-wrap gap-2 border-b border-slate-100 pb-3">
        {pages.map((p) => (
          <button
            key={p}
            onClick={() => setTab(p)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === p ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
          >
            {PAGE_LABELS[p]}
            {APPROVAL_REQUIRED.includes(p) && !isPlatformAdmin && (
              <span className="ml-1 text-xs opacity-70">*</span>
            )}
          </button>
        ))}
        {!isPlatformAdmin && (
          <span className="self-center text-xs text-slate-400">* requires approval</span>
        )}
      </div>
      <PageEditor
        key={tab + (operatorId ?? 'platform')}
        pageType={tab}
        isPlatformAdmin={isPlatformAdmin}
        operatorId={operatorId}
      />
    </div>
  );
}
