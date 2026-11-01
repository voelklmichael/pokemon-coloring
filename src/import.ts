/** Thrown when an image URL can't be read, typically because the site doesn't allow cross-origin loading. */
export class ImportError extends Error {}

/** Extracts http(s) and data:image URLs from free text (one or many, any whitespace-separated). */
export function parseUrls(text: string): string[] {
  const urls = text
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s) || /^data:image\//i.test(s));
  return [...new Set(urls)];
}

export function nameFromUrl(url: string): string {
  if (url.startsWith('data:')) return 'pasted image';
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').filter(Boolean).slice(-2).join('/')) || url;
  } catch {
    return url;
  }
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new ImportError(`HTTP ${res.status}`);
  return res.blob();
}

/**
 * Downloads an image. If the direct request fails (usually CORS) and a proxy
 * template like "https://proxy.example/?url={url}" is configured, retries through it.
 */
export async function fetchImage(url: string, proxyTemplate: string): Promise<Blob> {
  try {
    return await fetchBlob(url);
  } catch (err) {
    if (!proxyTemplate.includes('{url}')) {
      throw new ImportError(
        'the website does not allow loading its images directly. ' +
          'Right-click the image → "Copy image", then press Ctrl+V here — or download it and upload the file.',
      );
    }
    try {
      return await fetchBlob(proxyTemplate.replace('{url}', encodeURIComponent(url)));
    } catch (proxyErr) {
      throw new ImportError(`loading failed, also through the proxy (${(proxyErr as Error).message}).`);
    }
  }
}

export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new ImportError('this is not an image the browser can read.');
  }
}
