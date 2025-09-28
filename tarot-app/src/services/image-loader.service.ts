import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ImageLoaderService {
  preloadAll(
    urls: string[],
    timeoutMs = 30000,
    opts: { ignoreErrors?: boolean } = { ignoreErrors: true }
  ): Promise<{ ok: string[]; fail: Array<[string, any]> }> {
    const tasks = urls.map((u) =>
      this.preload(u, timeoutMs)
        .then(() => ({ ok: u }))
        .catch((err) => (opts.ignoreErrors ? { fail: [u, err] as [string, any] } : Promise.reject(err)))
    );

    return Promise.all(tasks).then((res: any[]) => {
      const ok = res.filter((r) => 'ok' in r).map((r) => r.ok as string);
      const fail = res.filter((r) => 'fail' in r).map((r) => r.fail as [string, any]);
      return { ok, fail };
    });
  }

  preload(url: string, timeoutMs = 30000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const img = new Image();
      let done = false;
      const finish = (ok: boolean, err?: any) => { if (done) return; done = true; clearTimeout(timer); ok ? resolve() : reject(err); };
      const timer = setTimeout(() => finish(false, new Error('img timeout')), timeoutMs);

      const a = document.createElement('a'); a.href = url;
      const isSameOrigin = !a.origin || a.origin === window.location.origin;
      if (!isSameOrigin) img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';

      img.onload = () => {
        if ('decode' in img) (img as any).decode().then(() => finish(true)).catch(() => finish(true));
        else finish(true);
      };
      img.onerror = (e) => finish(false, e);
      img.src = url;
    });
  }
}
