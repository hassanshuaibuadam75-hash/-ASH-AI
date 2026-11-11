// #ash Mesh — published site configuration (the Founder App Editor's live output).
//
// The provider fetches the LIVE configuration once at startup and applies it to the real
// interface: theme tokens become the same CSS variables the design system already uses,
// and page slots render as real content blocks on the real pages. When the API is
// unreachable it falls back to the last cached copy, then to built-in defaults, so the app
// never breaks because configuration is missing.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from './api.js';

const CACHE_KEY = 'ash:site-config:v1';

const FONTS = {
  system: "'Inter', 'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'SFMono-Regular', ui-monospace, Menlo, Consolas, monospace",
  rounded: "'Nunito', 'Segoe UI', system-ui, sans-serif",
};

export const PAGE_ROUTES = {
  home: '/',
  market: '/market',
  academy: '/academy',
  heritage: '/heritage',
  messages: '/messages',
  profile: '/profile',
  settings: '/settings',
  support: '/menu',
  friends: '/friends',
  notifications: '/notifications',
  ai: '/ai',
};

const SiteConfigContext = createContext({
  config: null,
  version: null,
  preview: false,
  loading: false,
  reload: () => {},
});

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(config) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(config));
  } catch {
    /* private mode / quota — defaults still render */
  }
}

export function previewVersionId() {
  try {
    return new URLSearchParams(window.location.search).get('preview');
  } catch {
    return null;
  }
}

export function SiteConfigProvider({ children }) {
  const [config, setConfig] = useState(readCache);
  const [version, setVersion] = useState(null);
  const [preview, setPreview] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    const versionId = previewVersionId();
    const path = versionId ? `/site-config?version=${encodeURIComponent(versionId)}` : '/site-config';
    setLoading(true);
    try {
      const data = await api(path);
      if (data && data.config) {
        setConfig(data.config);
        setVersion(data.version || null);
        setPreview(!!data.preview);
        if (!data.preview) writeCache(data.config);
      }
    } catch {
      // Keep whatever we already have: cached config, or built-in defaults.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Theme tokens → the live CSS variables used by every component.
  useEffect(() => {
    const theme = config && config.theme;
    if (!theme) return;
    const root = document.documentElement;
    const vars = {
      accent: '--accent',
      accentSoft: '--accent-soft',
      bg: '--bg',
      surface: '--card',
      text: '--text',
      muted: '--muted',
    };
    Object.entries(vars).forEach(([key, cssVar]) => {
      if (theme[key]) root.style.setProperty(cssVar, theme[key]);
    });
    if (theme.radius !== undefined && theme.radius !== null) root.style.setProperty('--radius', `${theme.radius}px`);
    if (theme.font) root.style.setProperty('--ash-font', FONTS[theme.font] || FONTS.system);
  }, [config]);

  const value = useMemo(
    () => ({ config, version, preview, loading, reload: load }),
    [config, version, preview, loading, load]
  );

  return <SiteConfigContext.Provider value={value}>{children}</SiteConfigContext.Provider>;
}

export function useSiteConfig() {
  return useContext(SiteConfigContext);
}

/**
 * Renders the published (or previewed) heading, description and added sections for a page.
 * Renders nothing when the Founder has not customised that page, so the built-in UI is
 * untouched by default.
 */
export function PageIntro({ page }) {
  const { config } = useSiteConfig();
  const slots = config && config.pages ? config.pages[page] : null;
  if (!slots) return null;

  const sections = Array.isArray(slots.sections) ? slots.sections : [];
  const hasContent = !!(slots.heading || slots.subheading || sections.length);
  if (!hasContent) return null;

  return (
    <section className="card page-intro">
      {slots.heading ? <h2 className="page-intro-title">{slots.heading}</h2> : null}
      {slots.subheading ? <p className="page-intro-sub">{slots.subheading}</p> : null}
      {sections.map((section) => (
        <div className="page-intro-section" key={section.id}>
          {section.title ? <h3 className="page-intro-section-title">{section.title}</h3> : null}
          {section.body ? <p className="page-intro-body">{section.body}</p> : null}
          {section.ctaLabel ? (
            <Link className="btn primary sm" to={section.ctaHref || '/'}>
              {section.ctaLabel}
            </Link>
          ) : null}
        </div>
      ))}
    </section>
  );
}
