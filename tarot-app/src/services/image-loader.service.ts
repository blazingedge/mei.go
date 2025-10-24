import { Injectable } from '@angular/core';


@Injectable({ providedIn: 'root' })
export class ImageLoaderService {
  private cache = new Map<string, boolean>();

  async preloadAll(urls: string[], timeoutMs = 30000, opts = { ignoreErrors: true }) {
    const uncached = urls.filter(u => !this.cache.has(u));
    const results = await Promise.allSettled(uncached.map(u => this.preload(u, timeoutMs)));
    results.forEach((r, i) => this.cache.set(uncached[i], r.status === 'fulfilled'));
    const ok = uncached.filter(u => this.cache.get(u));
    const fail = uncached.filter(u => !this.cache.get(u));
    return { ok, fail: fail.map(f => [f, 'fail']) };
  }

private preload(url: string, timeoutMs = 30000): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const img = new Image();

    const timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);

    img.crossOrigin = 'use-credentials';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'eager';
    img.decoding = 'async';

    img.onload = () => {
      clearTimeout(timer);
      this.cache.set(url, true);
      resolve();
    };

    img.onerror = (e) => {
      clearTimeout(timer);
      reject(e);
    };

    img.src = url;
  });
 }
}

