import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';
import { TermsCoordinatorService } from './terms-coordinator.service';

export type SessionCheckResult = 'ok' | 'needs-terms' | 'invalid';

@Injectable({ providedIn: 'root' })
export class SessionService {

  private pendingValidation: Promise<SessionCheckResult> | null = null;

  constructor(private terms: TermsCoordinatorService) {}

  // =========================================================================
  // VALIDATE — Maneja duplicados y errores silenciosos
  // =========================================================================
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

  // =========================================================================
  // VALIDACIÓN REAL — con protección contra HTML (errores Cloudflare)
  // =========================================================================
  private async performValidation(): Promise<SessionCheckResult> {
    const url = `${environment.API_BASE}/session/validate`;

    try {
      const res = await fetch(url, {
        method: 'GET',
        credentials: 'include'
      });

      // 401 → Sesión inválida
      if (res.status === 401) return 'invalid';

      // Si NO es JSON → Cloudflare devolvió HTML por errores MIME
      const type = res.headers.get('Content-Type') || '';
      if (!type.includes('application/json')) {
        console.error('❌ validate(): Server returned HTML instead of JSON');
        return 'invalid';
      }

      const data = await res.json();

      if (data.needsTerms === true) return 'needs-terms';
      if (data.ok === true) return 'ok';

      return 'invalid';

    } catch (err) {
      console.error('validate exception:', err);
      return 'invalid';
    }
  }

  // =========================================================================
  // ACEPTAR TÉRMINOS
  // =========================================================================
  async ensureTermsAcceptance(): Promise<boolean> {
    console.log('[SessionService] Soliciting terms modal…');

    const accepted = await this.terms.openForResult();
    if (!accepted) return false;

    try {
      const res = await fetch(`${environment.API_BASE}/terms/accept`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });

      return res.ok;
    } catch (err) {
      console.error('Error aceptando términos', err);
      return false;
    }
  }
}
