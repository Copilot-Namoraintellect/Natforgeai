export interface PublicImageUrlResult {
  publicUrl: string | null;
  isAbsoluteUrl: boolean;
  valid: boolean;
}

/**
 * Resolve an image URL into an absolute public HTTPS URL suitable for external APIs
 * such as the Facebook Graph API.
 *
 * Rejects local/dev-only URLs (localhost, blob, data, Windows paths, etc.).
 */
export function resolvePublicImageUrl(
  rawUrl: string | null | undefined,
  baseUrl: string
): PublicImageUrlResult {
  if (!rawUrl) {
    return { publicUrl: null, isAbsoluteUrl: false, valid: true };
  }

  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { publicUrl: null, isAbsoluteUrl: false, valid: true };
  }

  // Reject blob, data URIs, and Windows/local file paths.
  if (/^(blob|data):/i.test(trimmed)) {
    return { publicUrl: null, isAbsoluteUrl: false, valid: false };
  }
  if (/^[a-zA-Z]:[\\/]|^\\\\/.test(trimmed)) {
    return { publicUrl: null, isAbsoluteUrl: false, valid: false };
  }

  // Already absolute HTTP(S) URL.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const host = url.hostname.toLowerCase();
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") {
        return { publicUrl: null, isAbsoluteUrl: true, valid: false };
      }
      return { publicUrl: trimmed, isAbsoluteUrl: true, valid: true };
    } catch {
      return { publicUrl: null, isAbsoluteUrl: false, valid: false };
    }
  }

  // Relative path: prepend the public app base URL.
  // We only accept paths that clearly start with /, ./, or ../.
  if (!/^\//.test(trimmed) && !/^\.\//.test(trimmed) && !/^\.\.\//.test(trimmed)) {
    return { publicUrl: null, isAbsoluteUrl: false, valid: false };
  }

  const base = baseUrl.replace(/\/+$/, "");
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const resolved = `${base}${path}`;

  try {
    new URL(resolved);
    return { publicUrl: resolved, isAbsoluteUrl: false, valid: true };
  } catch {
    return { publicUrl: null, isAbsoluteUrl: false, valid: false };
  }
}
