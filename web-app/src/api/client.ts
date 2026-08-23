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
        headers: {
          'Content-Type': 'application/json',
          // Required: the backend binds each refresh token to the client_id
          // captured at login. Without this header the server sees an empty
          // client_id, treats it as a mismatch, and revokes the token —
          // which was forcing a logout ~1h after login.
          'X-Client-Id': getClientId(),
        },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
      if (!resp.ok) { clearTokens(); return null; }
      // /auth/refresh returns only a new access token (refresh tokens are not
      // rotated), so preserve the existing refresh token rather than
      // overwriting it with undefined.
      const data = await resp.json() as { access_token: string; refresh_token?: string };
      const newTokens: TokenPair = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? tokens.refreshToken,
      };
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

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Client-Id': getClientId(),
    ...headers,
  };
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

/**
 * Sign in with a Google ID token obtained from Google Identity Services.
 * The user never types a password: the backend verifies the token and issues
 * our access + refresh tokens. Mirrors {@link login}.
 */
export async function loginWithGoogle(
  idToken: string,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const resp = await fetch(`${API_BASE_URL}/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken, client_id: getClientId() }),
    });
    if (!resp.ok) {
      const errBody = (await resp.json().catch(() => null)) as { error?: ApiError } | null;
      return { success: false, error: errBody?.error?.message ?? 'Google sign-in failed' };
    }
    const data = (await resp.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      role: string;
      display_name: string | null;
    };
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

/** Request a password reset email. Always resolves ok (server hides whether the email exists). */
export async function requestPasswordReset(
  email: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await fetch(`${API_BASE_URL}/auth/password-reset/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }
}

/** Confirm a password reset with the emailed token and a new password. */
export async function confirmPasswordReset(
  token: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const resp = await fetch(`${API_BASE_URL}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    if (!resp.ok) {
      const err = (await resp.json().catch(() => null)) as { error?: ApiError } | null;
      return { ok: false, error: err?.error?.message ?? 'Could not reset password. The link may have expired.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, error: 'Network error. Please try again.' };
  }
}

/** Wallet balance for the authenticated user. */
export interface WalletInfo {
  balance_paise: number;
  rate_per_minute_paise: number;
  estimated_minutes_remaining: number;
}

export interface WelcomeCreditNotice {
  show_banner: boolean;
  amount_paise: number;
}

export async function claimWelcomeCreditNotice(claimToken: string): Promise<WelcomeCreditNotice | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await apiRequest<WelcomeCreditNotice>('/me/welcome-credit-notice/claim', {
        method: 'POST',
        body: { claim_token: claimToken },
      });
    } catch {
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return null;
}

export async function acknowledgeWelcomeCreditNotice(claimToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await apiRequest<{ acknowledged: boolean }>('/me/welcome-credit-notice/acknowledge', {
        method: 'POST',
        body: { claim_token: claimToken },
      });
      return result.acknowledged;
    } catch {
      if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
  }
  return false;
}

export async function getWallet(): Promise<WalletInfo | null> {
  try {
    return await apiRequest<WalletInfo>('/me/wallet');
  } catch {
    return null;
  }
}

/** A single wallet top-up record. */
export interface TopupItem {
  id: string;
  amount_paise: number;
  status: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export async function listTopups(): Promise<TopupItem[]> {
  try {
    const r = await apiRequest<{ topups: TopupItem[] }>('/me/topups');
    return r.topups ?? [];
  } catch {
    return [];
  }
}

/** A Razorpay top-up order created by the backend for wallet recharge. */
export interface TopupOrder {
  topup_id: string;
  order_id: string;
  key_id: string;
  amount: number; // paise
  currency: string;
  checkout_url: string;
}

/**
 * Create a Razorpay order for a wallet top-up of `amountPaise`. The backend
 * persists a pending wallet_topups row; the wallet is credited by the Razorpay
 * webhook once payment is captured. Throws ApiClientError on failure.
 */
export async function createWalletTopup(amountPaise: number): Promise<TopupOrder> {
  return apiRequest<TopupOrder>('/wallet/topup/checkout', {
    method: 'POST',
    body: { amount_paise: amountPaise },
  });
}

/** Result of verifying a Razorpay payment signature. */
export interface VerifyPaymentResult {
  verified: boolean;
  balance_paise: number;
}

/**
 * Verify a completed Razorpay Standard Checkout payment. The backend checks the
 * HMAC-SHA256 signature and, if valid, credits the wallet (idempotent with the
 * webhook). Throws ApiClientError on a signature mismatch or missing fields.
 */
export async function verifyPayment(params: {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}): Promise<VerifyPaymentResult> {
  return apiRequest<VerifyPaymentResult>('/payments/verify', {
    method: 'POST',
    body: params,
  });
}
