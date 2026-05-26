/**
 * Shared API client for the Admin Dashboard.
 * Handles JWT authentication, automatic token refresh on 401,
 * and attaches Authorization headers to all requests.
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

/** Parse JWT payload without verification (for reading claims client-side). */
function parseJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  const payload = parts[1];
  if (!payload) throw new Error('Invalid JWT format');
  const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded) as Record<string, unknown>;
}

const TOKEN_STORAGE_KEY = 'admin_tokens';

function getStoredTokens(): TokenPair | null {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TokenPair;
  } catch {
    return null;
  }
}

function storeTokens(tokens: TokenPair): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

function clearTokens(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Check if the stored access token belongs to an admin role. */
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

/** Get the current access token (if any). */
export function getAccessToken(): string | null {
  return getStoredTokens()?.accessToken ?? null;
}

/** Check if the access token is expired (with 30s buffer). */
function isTokenExpired(token: string): boolean {
  try {
    const payload = parseJwtPayload(token);
    const exp = payload.exp as number | undefined;
    if (!exp) return true;
    return Date.now() / 1000 > exp - 30;
  } catch {
    return true;
  }
}

let refreshPromise: Promise<TokenPair | null> | null = null;

/** Attempt to refresh the access token using the stored refresh token. */
async function refreshAccessToken(): Promise<TokenPair | null> {
  const tokens = getStoredTokens();
  if (!tokens?.refreshToken) {
    clearTokens();
    return null;
  }

  // Deduplicate concurrent refresh attempts
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });

      if (!response.ok) {
        clearTokens();
        return null;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token: string;
      };

      const newTokens: TokenPair = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      };

      // Verify the refreshed token still has admin role
      const payload = parseJwtPayload(newTokens.accessToken);
      if (payload.role !== 'admin') {
        clearTokens();
        return null;
      }

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

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Make an authenticated request to the Backend API.
 * Automatically attaches the Authorization header and handles 401 refresh.
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', headers = {}, body, signal } = options;

  let tokens = getStoredTokens();

  // Proactively refresh if token is about to expire
  if (tokens && isTokenExpired(tokens.accessToken)) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      window.location.href = '/login';
      throw new ApiClientError(401, {
        code: 'unauthenticated',
        message: 'Session expired. Please sign in again.',
      });
    }
    tokens = refreshed;
  }

  const requestHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...headers,
  };

  if (tokens?.accessToken) {
    requestHeaders['Authorization'] = `Bearer ${tokens.accessToken}`;
  }

  const fetchOptions: RequestInit = {
    method,
    headers: requestHeaders,
    signal,
  };

  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  let response = await fetch(`${API_BASE_URL}${path}`, fetchOptions);

  // Handle 401 - attempt token refresh and retry once
  if (response.status === 401 && tokens?.refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      requestHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;
      response = await fetch(`${API_BASE_URL}${path}`, {
        method,
        headers: requestHeaders,
        body: fetchOptions.body,
        signal,
      });
    } else {
      clearTokens();
      window.location.href = '/login';
      throw new ApiClientError(401, {
        code: 'unauthenticated',
        message: 'Session expired. Please sign in again.',
      });
    }
  }

  if (!response.ok) {
    let errorBody: { error?: ApiError } | undefined;
    try {
      errorBody = (await response.json()) as { error?: ApiError };
    } catch {
      // Response may not be JSON
    }

    const apiError: ApiError = errorBody?.error ?? {
      code: 'unknown_error',
      message: `Request failed with status ${response.status}`,
    };

    throw new ApiClientError(response.status, apiError);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

/**
 * Login to the admin dashboard.
 * Stores tokens and validates admin role.
 */
export async function login(
  email: string,
  password: string,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    // Generate a stable client_id for this browser (persisted in localStorage)
    let clientId = localStorage.getItem('admin_client_id');
    if (!clientId) {
      clientId = crypto.randomUUID();
      localStorage.setItem('admin_client_id', clientId);
    }

    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: clientId }),
    });

    if (!response.ok) {
      const errorBody = (await response.json()) as { error?: ApiError };
      return {
        success: false,
        error: errorBody?.error?.message ?? 'Login failed',
      };
    }

    const data = (await response.json()) as {
      access_token: string;
      refresh_token: string;
    };

    const payload = parseJwtPayload(data.access_token);
    if (payload.role !== 'admin') {
      return {
        success: false,
        error: 'Access denied. Admin role required.',
      };
    }

    storeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    });

    return { success: true };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

/**
 * Logout from the admin dashboard.
 * Revokes the refresh token and clears local storage.
 */
export async function logout(): Promise<void> {
  const tokens = getStoredTokens();
  if (tokens?.refreshToken) {
    try {
      await fetch(`${API_BASE_URL}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      });
    } catch {
      // Best-effort logout; clear tokens regardless
    }
  }
  clearTokens();
}
