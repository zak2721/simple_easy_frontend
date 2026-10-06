import { useEffect, useState } from 'react';
import { adminApi, adminToken, AdminMe } from './adminApi';
import { Wordmark } from '../components/common/Logo';
import { AdminDashboard } from './views/AdminDashboard';
import { AdminDeposits } from './views/AdminDeposits';
import { AdminWithdrawals } from './views/AdminWithdrawals';
import { AdminCartelas } from './views/AdminCartelas';
import { AdminTransactions } from './views/AdminTransactions';
import { AdminAudit } from './views/AdminAudit';
import { AdminSettings } from './views/AdminSettings';
import { AdminManagement } from './views/AdminManagement';
import { FinancialControlCenter } from './views/FinancialControlCenter';
import { AdminBonusSettings } from './views/AdminBonusSettings';
import { AdminReferralReports } from './views/AdminReferralReports';
import { AdminGameRules } from './views/AdminGameRules';
import { AdminContactCenter } from './views/AdminContactCenter';
import { AdminThemes } from './views/AdminThemes';
import { AdminPlayers } from './views/AdminPlayers';
import { PlatformOperators } from './views/PlatformOperators';
import { PlatformApprovalsQueue, OperatorApprovals } from './views/ApprovalsQueue';
import { OperatorBot } from './views/OperatorBot';
import { OperatorRooms } from './views/OperatorRooms';
import { OperatorBranding } from './views/OperatorBranding';
import { OperatorStaff } from './views/OperatorStaff';
import { OperatorGames } from './views/OperatorGames';
import { SupportTicketsAdmin } from './views/SupportTicketsAdmin';
import { AdminFaq } from './views/AdminFaq';
import { AdminSecurity } from './views/AdminSecurity';
import { NotificationsBell } from './components/NotificationsBell';
import { SubscriptionManagement } from './views/SubscriptionManagement';
import { SecurityEvents } from './views/SecurityEvents';
import { SystemHealth } from './views/SystemHealth';
import { GlobalSearch } from './views/GlobalSearch';
import { PlatformActivityTimeline } from './views/PlatformActivityTimeline';
import { AdminContentPages } from './views/AdminContentPages';

type View =
  | 'dashboard' | 'deposits' | 'withdrawals' | 'players' | 'cartelas' | 'transactions' | 'audit' | 'settings' | 'admins'
  | 'finance' | 'bonus' | 'referralReports' | 'gameRules' | 'contact' | 'themes'
  | 'operators' | 'approvals' | 'myApprovals' | 'operatorBot' | 'operatorRooms' | 'operatorBranding' | 'operatorStaff' | 'operatorGames' | 'supportTickets' | 'faq'
  | 'security'
  | 'subscriptions' | 'securityEvents' | 'systemHealth' | 'globalSearch' | 'activityTimeline'
  | 'contentPages';

interface NavItem { key: View; label: string; superAdminOnly?: boolean; requiresPermission?: string; platformOnly?: boolean; operatorOnly?: boolean }

const NAV: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'operators', label: 'Operators', platformOnly: true, requiresPermission: 'MANAGE_OPERATORS' },
  { key: 'approvals', label: 'Approvals Queue', platformOnly: true, requiresPermission: 'APPROVE_OPERATOR_CHANGES' },
  { key: 'operatorBot', label: 'My Bot', operatorOnly: true },
  { key: 'operatorRooms', label: 'My Rooms', operatorOnly: true, requiresPermission: 'MANAGE_ROOMS' },
  { key: 'operatorBranding', label: 'My Branding', operatorOnly: true, requiresPermission: 'MANAGE_BRANDING' },
  { key: 'operatorStaff', label: 'My Staff', operatorOnly: true, requiresPermission: 'MANAGE_STAFF' },
  { key: 'operatorGames', label: 'My Games', operatorOnly: true, requiresPermission: 'VIEW_GAMES' },
  { key: 'myApprovals', label: 'My Approvals', operatorOnly: true },
  { key: 'supportTickets', label: 'Support Tickets', requiresPermission: 'VIEW_SUPPORT_TICKETS' },
  { key: 'faq', label: 'FAQ' },
  { key: 'deposits', label: 'Deposits' },
  { key: 'withdrawals', label: 'Withdrawals' },
  { key: 'players', label: 'Players', requiresPermission: 'VIEW_USERS' },
  { key: 'cartelas', label: 'Cartelas' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'finance', label: 'Financial Control Center', superAdminOnly: true },
  { key: 'bonus', label: 'Welcome Bonus' },
  { key: 'referralReports', label: 'Referral Reports' },
  { key: 'gameRules', label: 'Game Rules' },
  { key: 'contact', label: 'Contact Center' },
  { key: 'themes', label: 'Themes' },
  { key: 'audit', label: 'Audit log' },
  { key: 'settings', label: 'Settings' },
  { key: 'admins', label: 'Admins', superAdminOnly: true },
  { key: 'security', label: 'Account Security' },
  { key: 'activityTimeline', label: 'Activity Timeline', platformOnly: true, requiresPermission: 'MANAGE_OPERATORS' },
  { key: 'subscriptions', label: 'Subscriptions', platformOnly: true, requiresPermission: 'MANAGE_OPERATORS' },
  { key: 'securityEvents', label: 'Security Events', platformOnly: true, superAdminOnly: true },
  { key: 'systemHealth', label: 'System Health', superAdminOnly: true },
  { key: 'globalSearch', label: 'Global Search', platformOnly: true },
  { key: 'contentPages', label: 'Content Pages', requiresPermission: 'MANAGE_SETTINGS' },
];

export function AdminApp() {
  const [admin, setAdmin] = useState<AdminMe | null>(null);
  const [checking, setChecking] = useState(true);
  const [view, setView] = useState<View>('dashboard');
  const [returnToken, setReturnToken] = useState<string | null>(null);
  const [mustChangePw, setMustChangePw] = useState(false);

  useEffect(() => {
    if (!adminToken.get()) { setChecking(false); return; }
    adminApi.me()
      .then((r) => setAdmin(r.admin))
      .catch((e) => {
        if (e instanceof Error && e.message === 'MUST_CHANGE_PASSWORD') {
          setMustChangePw(true);
        } else {
          adminToken.clear();
        }
      })
      .finally(() => setChecking(false));
  }, []);

  const startImpersonation = async (adminId: string, reason?: string) => {
    const current = adminToken.get();
    await adminApi.impersonate(adminId, reason);
    setReturnToken(current);
    const me = await adminApi.me();
    setAdmin(me.admin);
    setView('dashboard');
  };

  const exitImpersonation = async () => {
    await adminApi.exitImpersonation().catch(() => {});
    if (returnToken) {
      adminToken.set(returnToken);
      setReturnToken(null);
      const me = await adminApi.me();
      setAdmin(me.admin);
    } else {
      adminToken.clear();
      setAdmin(null);
    }
    setView('dashboard');
  };

  if (checking) return <div className="eds-admin min-h-screen bg-slate-100 p-10 text-slate-500">Loading…</div>;
  if (mustChangePw) return <ForcedPasswordChange onChanged={() => { setMustChangePw(false); adminToken.clear(); }} />;
  if (!admin) return <AdminLogin onAuthed={setAdmin} />;

  const isSuperAdmin = admin.role === 'SUPER_ADMIN';
  const isOperatorAccount = admin.operatorId !== null;
  const visibleNav = NAV.filter((n) => {
    if (n.superAdminOnly && !isSuperAdmin) return false;
    if (n.platformOnly && isOperatorAccount) return false;
    if (n.operatorOnly && !isOperatorAccount) return false;
    if (n.requiresPermission && !isSuperAdmin && !admin.permissions.includes(n.requiresPermission)) return false;
    return true;
  });

  return (
    <div className="eds-admin min-h-screen bg-slate-100 text-slate-900">
      {admin.impersonating && (
        <div className="flex items-center justify-between bg-orange-500 px-4 py-2 text-sm text-white">
          <span>Viewing as {admin.fullName || admin.username} ({admin.role})</span>
          <button onClick={exitImpersonation} className="rounded bg-white/20 px-2 py-1 text-xs font-semibold hover:bg-white/30">Exit</button>
        </div>
      )}
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <Wordmark className="text-sm" />
          <span className="text-xs text-slate-400">Admin</span>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <NotificationsBell />
          <span className="text-slate-500">{admin.fullName || admin.username} · {admin.role}</span>
          <button onClick={() => { adminApi.logout().catch(() => {}); adminToken.clear(); setAdmin(null); }} className="text-red-500">
            Log out
          </button>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl gap-4 p-4">
        <nav className="w-44 shrink-0 space-y-1">
          {visibleNav.map((n) => (
            <button
              key={n.key}
              onClick={() => setView(n.key)}
              className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${view === n.key ? 'bg-emerald-600 text-white' : 'text-slate-600 hover:bg-white'}`}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <main className="min-w-0 flex-1">
          {view === 'dashboard' && <AdminDashboard />}
          {view === 'operators' && !isOperatorAccount && <PlatformOperators onImpersonate={startImpersonation} />}
          {view === 'approvals' && !isOperatorAccount && <PlatformApprovalsQueue />}
          {view === 'operatorBot' && isOperatorAccount && <OperatorBot />}
          {view === 'operatorRooms' && isOperatorAccount && <OperatorRooms />}
          {view === 'operatorBranding' && isOperatorAccount && <OperatorBranding />}
          {view === 'operatorStaff' && isOperatorAccount && <OperatorStaff />}
          {view === 'operatorGames' && isOperatorAccount && <OperatorGames />}
          {view === 'myApprovals' && isOperatorAccount && <OperatorApprovals />}
          {view === 'supportTickets' && <SupportTicketsAdmin role={admin.role} permissions={admin.permissions} />}
          {view === 'faq' && <AdminFaq role={admin.role} permissions={admin.permissions} />}
          {view === 'deposits' && <AdminDeposits role={admin.role} permissions={admin.permissions} />}
          {view === 'withdrawals' && <AdminWithdrawals role={admin.role} permissions={admin.permissions} />}
          {view === 'players' && <AdminPlayers role={admin.role} permissions={admin.permissions} />}
          {view === 'cartelas' && <AdminCartelas />}
          {view === 'transactions' && <AdminTransactions />}
          {view === 'finance' && isSuperAdmin && <FinancialControlCenter />}
          {view === 'bonus' && <AdminBonusSettings role={admin.role} permissions={admin.permissions} />}
          {view === 'referralReports' && <AdminReferralReports role={admin.role} permissions={admin.permissions} />}
          {view === 'gameRules' && <AdminGameRules role={admin.role} permissions={admin.permissions} />}
          {view === 'contact' && <AdminContactCenter role={admin.role} permissions={admin.permissions} />}
          {view === 'themes' && <AdminThemes role={admin.role} permissions={admin.permissions} />}
          {view === 'audit' && <AdminAudit />}
          {view === 'settings' && <AdminSettings role={admin.role} />}
          {view === 'admins' && isSuperAdmin && <AdminManagement />}
          {view === 'security' && <AdminSecurity me={admin} onChanged={() => adminApi.me().then((r) => setAdmin(r.admin))} />}
          {view === 'activityTimeline' && !isOperatorAccount && <PlatformActivityTimeline />}
          {view === 'subscriptions' && !isOperatorAccount && <SubscriptionManagement />}
          {view === 'securityEvents' && isSuperAdmin && <SecurityEvents />}
          {view === 'systemHealth' && isSuperAdmin && <SystemHealth />}
          {view === 'globalSearch' && !isOperatorAccount && <GlobalSearch />}
          {view === 'contentPages' && <AdminContentPages isPlatformAdmin={!isOperatorAccount} operatorId={admin.operatorId ?? undefined} />}
        </main>
      </div>
    </div>
  );
}

function AdminLogin({ onAuthed }: { onAuthed: (a: AdminMe) => void }) {
  const [mode, setMode] = useState<'login' | 'bootstrap' | 'change_password'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [adminKey, setAdminKey] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  const finish = async () => {
    const me = await adminApi.me();
    onAuthed(me.admin);
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'bootstrap') {
        await adminApi.bootstrap(username, password, fullName, adminKey);
        await finish();
        return;
      }
      await adminApi.login(username, password);
      // After a successful login, me() may return MUST_CHANGE_PASSWORD
      try {
        await finish();
      } catch (meErr) {
        if (meErr instanceof Error && meErr.message === 'MUST_CHANGE_PASSWORD') {
          setMode('change_password');
        } else {
          throw meErr;
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const submitChangePassword = async () => {
    setError(null);
    if (newPassword.length < 10) return setError('New password must be at least 10 characters');
    if (newPassword !== confirmPassword) return setError('Passwords do not match');
    if (newPassword === password) return setError('New password must differ from the temporary one');
    setBusy(true);
    try {
      await adminApi.changePassword(password, newPassword);
      // All sessions revoked — log in fresh with new password
      setPassword(newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setMode('login');
      setError(null);
      alert('Password changed. Please sign in with your new password.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setBusy(false);
    }
  };


  if (mode === 'change_password') {
    return (
      <div className="eds-admin flex min-h-screen items-center justify-center bg-slate-100 p-4">
        <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
          <Wordmark className="text-lg" />
          <p className="mt-2 text-sm font-semibold text-amber-600">Your account was created with a temporary password. Please set a permanent one to continue.</p>
          <div className="mt-4 space-y-3">
            <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="New password (min 10 characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus />
            <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Confirm new password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <button onClick={submitChangePassword} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
              {busy ? '…' : 'Set permanent password'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="eds-admin flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
        <Wordmark className="text-lg" />
        <p className="mt-1 text-sm text-slate-500">Admin panel</p>
        <div className="mt-4 space-y-3">
          <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
          {mode === 'bootstrap' && (
            <>
              <input className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} />
              <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="ADMIN_KEY (bootstrap secret)" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} />
            </>
          )}
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? '…' : mode === 'bootstrap' ? 'Create owner & sign in' : 'Sign in'}
          </button>
          <button onClick={() => setMode(mode === 'login' ? 'bootstrap' : 'login')} className="w-full text-xs text-slate-400">
            {mode === 'login' ? 'First time? Create the owner account' : 'Back to sign in'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ForcedPasswordChange({ onChanged }: { onChanged: () => void }) {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (!currentPw) return setError('Current (temporary) password is required');
    if (newPw.length < 10) return setError('New password must be at least 10 characters');
    if (newPw !== confirmPw) return setError('Passwords do not match');
    if (newPw === currentPw) return setError('New password must differ from the temporary one');
    setBusy(true);
    try {
      await adminApi.changePassword(currentPw, newPw);
      onChanged();
      alert('Password changed. Please sign in with your new password.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to change password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eds-admin flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow">
        <Wordmark className="text-lg" />
        <p className="mt-2 text-sm font-semibold text-amber-600">Your account was created with a temporary password. Set a permanent one to continue.</p>
        <div className="mt-4 space-y-3">
          <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Temporary password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} autoFocus />
          <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="New password (min 10 characters)" value={newPw} onChange={(e) => setNewPw(e.target.value)} />
          <input type="password" className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" placeholder="Confirm new password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} />
          {error && <p className="text-sm text-red-500">{error}</p>}
          <button onClick={submit} disabled={busy} className="w-full rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white disabled:opacity-50">
            {busy ? '…' : 'Set permanent password'}
          </button>
        </div>
      </div>
    </div>
  );
}
