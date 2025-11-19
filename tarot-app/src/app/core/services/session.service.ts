// src/app/core/services/session.service.ts
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
import { TermsCoordinatorService } from './terms-coordinator.service';

type SessionCheckResult = 'valid' | 'needs-terms' | 'invalid';

interface SessionValidateResponse {
  ok: boolean;
  user?: { uid: string; email: string; plan: PlanId };
  drucoins?: number;
  needsTerms?: boolean;
}

@Injectable({ providedIn: 'root' })
export class SessionService {
  private base = environment.API_BASE;
  private pendingValidation: Promise<SessionCheckResult> | null = null;
  private termsFlowPromise: Promise<boolean> | null = null;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private router: Router,
    private terms: TermsCoordinatorService
  ) {}

  // ============================================================
  // BOOTSTRAP GENERAL
  // ============================================================
  async bootstrap() {
    const result = await this.validate();

    if (result === 'valid') {
      if (this.router.url === '/' || this.router.url === '/login') {
        this.router.navigate(['/spreads']);
      }
      return;
    }

    if (result === 'needs-terms') {
      const accepted = await this.ensureTermsAcceptance();
      if (accepted) {
        if (this.router.url === '/' || this.router.url === '/login') {
          this.router.navigate(['/spreads']);
        }
      } else if (this.router.url !== '/login') {
        this.router.navigate(['/login']);
      }
      return;
    }

    // invalid
    if (this.router.url !== '/login') {
      this.router.navigate(['/login']);
    }
  }

  // ============================================================
  // VALIDACIÓN DE SESIÓN
  // ============================================================
  async validate(force = false): Promise<SessionCheckResult> {
    if (!force && this.pendingValidation) {
      return this.pendingValidation;
    }

    const task = this.performValidation();
    if (!force) this.pendingValidation = task;

    try {
      return await task;
    } finally {
      if (!force) this.pendingValidation = null;
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

      // Aplicar snapshot a AuthService
      const snapshot: SessionSnapshot = {
        user: resp.user,
        drucoins: resp.drucoins ?? 0,
      };

      this.auth.applySessionSnapshot(snapshot);

      // Revisión de Términos
      if (resp.needsTerms === true) {
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

  // ============================================================
  // TÉRMINOS Y CONDICIONES
  // ============================================================
 async ensureTermsAcceptance(): Promise<boolean> {
  console.log('[SessionService] ensureTermsAcceptance()');

  // 1. Abrir modal y esperar resultado
  const accepted = await this.terms.openForResult();
  console.log('[SessionService] resultado del modal:', accepted);

  if (!accepted) return false;

  // 2. Registrar en backend
  try {
    const res = await fetch(`${environment.API_BASE}/terms/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });

    if (!res.ok) throw new Error('No se pudo registrar la aceptación');

    console.log('[SessionService] aceptación confirmada en backend');
    return true;

  } catch (err) {
    console.error('Error registrando términos:', err);
    return false;
  }
}


  private async runTermsFlow(): Promise<boolean> {
    try {
      const accepted = await this.terms.openForResult();

      if (!accepted) {
        return false;
      }

      const remote = await this.auth.ensureTermsAcceptance();

      if (!remote) {
        this.auth.requireTermsAcceptance();
        return false;
      }

      await this.validate(true);
      return true;

    } catch (err) {
      console.error('Terms flow error:', err);
      this.auth.requireTermsAcceptance();
      return false;
    }
  }
}
