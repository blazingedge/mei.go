import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import { environment } from '../../../environments/environment';
import {
  AuthService,
  PlanId,
  SessionSnapshot,
} from '../auth/auth.service';

type SessionCheckResult = 'valid' | 'needs-terms' | 'invalid';

interface SessionValidateResponse {
  ok: boolean;
  user?: { uid: string; email: string; plan: PlanId };
  quota?: { monthly: number; used: number; remaining: number; period: string };
  drucoins?: number;
  needsTerms?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private base = environment.API_BASE;
  private pendingValidation: Promise<SessionCheckResult> | null = null;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private router: Router
  ) {}

  async bootstrap() {
    const result = await this.validate();
    if (result === 'valid' || result === 'needs-terms') {
      if (this.router.url === '/' || this.router.url === '/login') {
        this.router.navigate(['/spreads']);
      }
    } else {
      if (this.router.url !== '/login') {
        this.router.navigate(['/login']);
      }
    }
  }

  async validate(force = false): Promise<SessionCheckResult> {
    if (!force && this.pendingValidation) {
      return this.pendingValidation;
    }

    const task = this.performValidation();
    if (!force) {
      this.pendingValidation = task;
    }

    try {
      return await task;
    } finally {
      if (!force) {
        this.pendingValidation = null;
      }
    }
  }

  private async performValidation(): Promise<SessionCheckResult> {
    const token = await this.auth.getIdToken();
    if (!token) {
      await this.auth.logout();
      return 'invalid';
    }

    try {
      const resp = await firstValueFrom(
        this.http.get<SessionValidateResponse>(`${this.base}/session/validate`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      );

      if (!resp?.ok || !resp.user) {
        await this.auth.logout();
        return 'invalid';
      }

      const snapshot: SessionSnapshot = {
        user: resp.user,
        quota: resp.quota,
        drucoins: resp.drucoins ?? 0,
      };
      this.auth.applySessionSnapshot(snapshot);

      if (resp.needsTerms) {
        this.auth.requireTermsAcceptance();
        return 'needs-terms';
      }

      this.auth.markTermsAccepted();
      return 'valid';
    } catch (err: any) {
      if (err?.status === 401) {
        await this.auth.logout();
        return 'invalid';
      }
      console.error('Session validate error:', err);
      return 'invalid';
    }
  }
}
