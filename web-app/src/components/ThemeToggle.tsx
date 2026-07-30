import { useEffect, useState } from 'react';

type ColorTheme = 'dark' | 'light';

const THEME_STORAGE_KEY = 'upnod-theme';
const THEME_COLORS: Record<ColorTheme, string> = {
  dark: '#070a0e',
  light: '#f8faff',
};

function getSystemTheme(): ColorTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function getStoredTheme(): ColorTheme | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : null;
  } catch {
    return null;
  }
}

function getInitialTheme(): ColorTheme {
  if (typeof document !== 'undefined') {
    const documentTheme = document.documentElement.dataset.theme;
    if (documentTheme === 'dark' || documentTheme === 'light') return documentTheme;
  }
  return getStoredTheme() ?? getSystemTheme();
}

function applyDocumentTheme(theme: ColorTheme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme]);
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<ColorTheme>(getInitialTheme);

  useEffect(() => {
    applyDocumentTheme(theme);
  }, [theme]);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = (event: MediaQueryListEvent) => {
      if (!getStoredTheme()) setTheme(event.matches ? 'dark' : 'light');
    };
    media.addEventListener('change', handleSystemChange);
    return () => media.removeEventListener('change', handleSystemChange);
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setTheme(getStoredTheme() ?? getSystemTheme());
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  const nextTheme = theme === 'dark' ? 'light' : 'dark';

  function toggleTheme() {
    const root = document.documentElement;
    root.classList.add('theme-changing');
    applyDocumentTheme(nextTheme);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
    } catch {
      // The active tab still changes theme when storage is unavailable.
    }
    setTheme(nextTheme);
    window.setTimeout(() => root.classList.remove('theme-changing'), 280);
  }

  return (
    <button
      type="button"
      className={`theme-toggle is-${theme}`}
      onClick={toggleTheme}
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
    >
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.2 15.2A8.5 8.5 0 0 1 8.8 3.8 8.5 8.5 0 1 0 20.2 15.2Z" />
        </svg>
      )}
    </button>
  );
}
