'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { refreshSession } from '@/lib/api';

/**
 * Holds the access token in memory and restores it on load.
 *
 * Still never localStorage: anything JS can read, an XSS payload can
 * exfiltrate. What changed in Step 9 is only that a reload no longer loses the
 * session — on mount we ask /auth/refresh, and the browser supplies the
 * httpOnly cookie by itself. The cookie remains unreadable to JS; the access
 * token still dies with the tab.
 *
 * This adds no new credential and no new storage. It uses the refresh endpoint
 * that has existed since Step 5, exactly as designed.
 */
type Status = 'loading' | 'authenticated' | 'anonymous';

type AuthState = {
  accessToken: string | null;
  status: Status;
  setAccessToken: (token: string | null) => void;
  clear: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('loading');

  // React 18+ StrictMode mounts effects twice in development. Without this
  // guard the second run sends the already-rotated refresh token back, which
  // the server correctly reads as reuse and revokes the entire family —
  // logging the user out on every dev page load.
  const bootstrapped = useRef(false);

  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    refreshSession()
      .then(({ accessToken }) => {
        setAccessToken(accessToken);
        setStatus('authenticated');
      })
      .catch(() => {
        // No cookie, expired, or revoked. All mean the same thing to the UI.
        setAccessToken(null);
        setStatus('anonymous');
      });
  }, []);

  const set = useCallback((token: string | null) => {
    setAccessToken(token);
    setStatus(token ? 'authenticated' : 'anonymous');
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    setStatus('anonymous');
  }, []);

  return (
    <AuthContext.Provider
      value={{ accessToken, status, setAccessToken: set, clear }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
