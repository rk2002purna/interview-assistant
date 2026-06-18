/**
 * Shared API client for the Web App.
 * Handles JWT authentication, automatic refresh on 401, and
 * attaches Authorization headers to all requests.
 */

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = error.code;
    this.details = error.details;
  }
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  const payload = parts[1];
  if (!payload) throw new Error('Invalid JWT format');
  const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded) as Record<string, unknown>;
}

const TOKEN_KEY = 'auth_tokens';
const USER_KEY = 'auth_user';
const CLIENT_ID_KEY = 'web_client_id';

export function getStoredTokens(): TokenPair | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as TokenPair) : null;
  } catch {
    return null;
  }
}

function storeTokens(tokens: TokenPair): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
}

interface StoredUser {
  sub: string;
  role: string;
  displayName: string | null;
}

function storeUser(user: StoredUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function getStoredUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StoredUser) : null;
  } catch {
    return null;
  }
}

export function getDisplayName(): string | null {
  return getStoredUser()?.displayName ?? null;
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export function isAuthSession(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  try {
    const payload = parseJwtPayload(tokens.accessToken);
    return typeof payload.sub === 'string';
  } catch {
    return false;
  }
}

export function isAdminSession(): boolean {
  const tokens = getStoredTokens();
  if (!tokens) return false;
  try {
    const payload = parseJwtPayload(tokens.accessToken);
    return payload.role === 'admin';
  } catch {
    return false;
  }
}

export function getCurrentUser(): { sub: string; role: string } | null {
  const tokens = getStoredTokens();
  if (!tokens) return null;
  try {
    const payload = parseJwtPayload(tokens.accessToken);
    return { sub: payload.sub as string, role: payload.role as string };
  } catch {
    return null;
  }
}

function isTokenExpired(token: string): boolean {
  try {
    const payload = parseJwtPayload(token);
    const exp = payload.exp as number | undefined;
    return !exp || Date.now() / 1000 > exp - 30;
  } catch {
    return true;
  }
}

let refreshPromise: Promise<TokenPair | null> | null = null;

async function refreshAccessToken(): Promise<TokenPair | null> {
  const tokens = getStoredTokens();
  if (!tokens?.refreshToken) {
    clearTokens();
    return null;
  }
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const resp = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
      if (!resp.ok) { clearTokens(); return null; }
      const data = await resp.json() as { access_token: string; refresh_token: string };
      const newTokens: TokenPair = { accessToken: data.access_token, refreshToken: data.refresh_token };
      storeTokens(newTokens);
      return newTokens;
    } catch {
      clearTokens();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body, signal } = options;
  let tokens = getStoredTokens();

  if (tokens && isTokenExpired(tokens.accessToken)) {
    tokens = await refreshAccessToken();
  }

  const reqHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (tokens?.accessToken) {
    reqHeaders['Authorization'] = `Bearer ${tokens.accessToken}`;
  }

  const fetchOpts: RequestInit = { method, headers: reqHeaders, signal };
  if (body !== undefined) fetchOpts.body = JSON.stringify(body);

  let resp = await fetch(`${API_BASE_URL}${path}`, fetchOpts);

  if (resp.status === 401 && tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      reqHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;
      resp = await fetch(`${API_BASE_URL}${path}`, { ...fetchOpts, headers: reqHeaders });
    }
  }

  if (!resp.ok) {
    let errorBody: { error?: ApiError } | undefined;
    try { errorBody = await resp.json() as { error?: ApiError }; } catch { /* not JSON */ }
    throw new ApiClientError(resp.status, errorBody?.error ?? { code: 'unknown', message: `Request failed (${resp.status})` });
  }

  if (resp.status === 204) return undefined as T;
  return resp.json() as Promise<T>;
}

/** Login and store tokens. Returns success/error. Also checks admin role for admin login. */
export async function login(
  email: string,
  password: string,
  requireAdmin = false,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const resp = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: getClientId() }),
    });
    if (!resp.ok) {
      const err = await resp.json() as { error?: ApiError };
      return { success: false, error: err.error?.message ?? 'Login failed' };
    }
    const data = await resp.json() as { access_token: string; refresh_token: string; expires_in: number; role: string; display_name: string | null };
    if (requireAdmin && data.role !== 'admin') {
      return { success: false, error: 'Admin access required.' };
    }
    storeTokens({ accessToken: data.access_token, refreshToken: data.refresh_token });
    const payload = parseJwtPayload(data.access_token);
    storeUser({ sub: payload.sub as string, role: data.role, displayName: data.display_name ?? null });
    return { success: true };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/** Register a new account. */
export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const resp = await fetch(`${API_BASE_URL}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, display_name: displayName || undefined, client_id: getClientId() }),
    });
    if (!resp.ok) {
      const err = await resp.json() as { error?: ApiError };
      return { success: false, error: err.error?.message ?? 'Registration failed' };
    }
    return { success: true };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/** Logout: revoke token and clear storage. */
export async function logout(): Promise<void> {
  const tokens = getStoredTokens();
  if (tokens?.refreshToken) {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
    } catch { /* best effort */ }
  }
  clearTokens();
}

/** Fetch packs for display on landing page. */
export async function listPacks(): Promise<any[]> {
  try {
    return await apiRequest<any[]>('/packs');
  } catch {
    return [];
  }
}
