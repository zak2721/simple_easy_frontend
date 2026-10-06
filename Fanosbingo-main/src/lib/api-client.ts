// Replaces src/lib/supabase.ts's createClient() — plain REST via Axios
// against the NestJS backend. No Supabase SDK, no Supabase URL/keys.
import axios, { AxiosError } from 'axios';

export const API_BASE_URL: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000/api';

const PLAYER_ACCESS_KEY = 'yena_player_access_token';
const ADMIN_ACCESS_KEY = 'yena_admin_access_token';

// The player refresh token is now an httpOnly cookie (yena_player_rt, set by
// the backend — see auth.controller.ts), the same pattern already used for
// the admin refresh token. Production Readiness Audit (High): this was the
// one credential still readable by JavaScript (and so by any future XSS) on
// the side of the app that actually moves money — only the short-lived
// access token stays here now, same blast radius as the admin side.
export const playerTokens = {
  getAccess: () => safeGet(PLAYER_ACCESS_KEY),
  setAccess: (access: string) => safeSet(PLAYER_ACCESS_KEY, access),
  clear: () => safeRemove(PLAYER_ACCESS_KEY),
};

export const adminToken = {
  get: () => safeGet(ADMIN_ACCESS_KEY),
  set: (t: string) => safeSet(ADMIN_ACCESS_KEY, t),
  clear: () => safeRemove(ADMIN_ACCESS_KEY),
};

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}
function safeRemove(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// withCredentials on both: each has its own httpOnly refresh cookie (player: yena_player_rt scoped to /api/auth; admin: yena_admin_rt scoped to /api/auth/admin).
export const playerApi = axios.create({ baseURL: API_BASE_URL, withCredentials: true });
export const adminApiClient = axios.create({ baseURL: API_BASE_URL, withCredentials: true });

/** Stable random id for this browser, persisted under `storageKey`. */
function stableDeviceId(storageKey: string): string {
  let id = safeGet(storageKey);
  if (!id) {
    id = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    safeSet(storageKey, id);
  }
  return id;
}

/** Lets login history and new-device alerts tell admin devices apart. */
function adminDeviceId(): string {
  return stableDeviceId('yena_admin_device_id');
}

/**
 * Sybil/bonus-farming defense (Production Readiness Audit — "Sybil/multi-
 * account defense"): sent as X-Device-Id on every player request so
 * BonusService can group accounts created from the same device, on top of
 * IP, before capping SIGNUP/REFERRAL_* payouts — see
 * backend/src/bonus/bonus.service.ts's exceedsFingerprintCap. Trivially
 * reset by clearing site data, same limitation the admin device id already
 * has; this is a casual-abuse deterrent, not identity verification.
 */
function playerDeviceId(): string {
  return stableDeviceId('yena_player_device_id');
}

playerApi.interceptors.request.use((config) => {
  const token = playerTokens.getAccess();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['X-Device-Id'] = playerDeviceId();
  return config;
});

adminApiClient.interceptors.request.use((config) => {
  const token = adminToken.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  config.headers['X-Device-Id'] = adminDeviceId();
  return config;
});

// Admin access tokens live 15 minutes; the httpOnly refresh cookie renews them.
// Single-flight, like the player refresh below.
let adminRefreshPromise: Promise<string | null> | null = null;

function refreshAdminAccessToken(): Promise<string | null> {
  if (!adminRefreshPromise) {
    adminRefreshPromise = axios
      .post(`${API_BASE_URL}/auth/admin/refresh`, null, { withCredentials: true, headers: { 'X-Device-Id': adminDeviceId() } })
      .then((res) => {
        adminToken.set(res.data.token);
        return res.data.token as string;
      })
      .catch(() => {
        adminToken.clear();
        return null;
      })
      .finally(() => {
        adminRefreshPromise = null;
      });
  }
  return adminRefreshPromise;
}

adminApiClient.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    const isAuthCall = original?.url?.includes('/auth/admin/login') || original?.url?.includes('/auth/admin/refresh');
    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      const newToken = await refreshAdminAccessToken();
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return adminApiClient(original);
      }
    }
    return Promise.reject(error);
  },
);

// Single-flight refresh: concurrent 401s share one refresh call instead of racing.
let refreshPromise: Promise<string | null> | null = null;

function refreshPlayerAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post(`${API_BASE_URL}/auth/refresh`, null, { withCredentials: true })
      .then((res) => {
        playerTokens.setAccess(res.data.accessToken);
        return res.data.accessToken as string;
      })
      .catch(() => {
        playerTokens.clear();
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

playerApi.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    const isAuthCall = original?.url?.includes('/auth/telegram') || original?.url?.includes('/auth/refresh');
    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      const newToken = await refreshPlayerAccessToken();
      if (newToken) {
        original.headers = original.headers ?? {};
        original.headers.Authorization = `Bearer ${newToken}`;
        return playerApi(original);
      }
    }
    return Promise.reject(error);
  },
);

/** Normalizes Axios errors into the same shape callers previously got from the Supabase edge-function fetch wrapper. */
export function apiErrorMessage(e: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(e)) {
    return (e.response?.data as { error?: string } | undefined)?.error ?? e.message ?? fallback;
  }
  return e instanceof Error ? e.message : fallback;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}
