import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';
import { TermsCoordinatorService } from './terms-coordinator.service';
import { getAuth } from '@angular/fire/auth';

export type SessionCheckResult = 'ok' | 'needs-terms' | 'invalid';

@Injectable({ providedIn: 'root' })
export class SessionService {

  private pendingValidation: Promise<SessionCheckResult> | null = null;

  constructor(private terms: TermsCoordinatorService) {}

  // =========================================================================
  // PUBLIC VALIDATE WRAPPER
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
  // REAL VALIDATION — now with Firebase token
  // =========================================================================
  private async performValidation(): Promise<SessionCheckResult> {
    const url = `${environment.API_BASE}/session/validate`;

    try {
      // 🔥 1. Obtener token Firebase
      const auth = getAuth();
      const user = auth.currentUser;

      if (!user) {
        console.warn('⚠️ No Firebase user yet — invalid session.');
        return 'invalid';
      }

      const token = await user.getIdToken(true);

      // 🔥 2. Enviar token a tu backend
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        }
      });

      // 🔥 3. Backend dice "no autorizado"
      if (res.status === 401) return 'invalid';

      // 🔥 4. Verificar que de verdad es JSON
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
  // ACCEPT TERMS
  // =========================================================================
  async ensureTermsAcceptance(): Promise<boolean> {
    console.log('[SessionService] Opening terms modal…');

    const accepted = await this.terms.openForResult();
    if (!accepted) return false;

    try {
      const auth = getAuth();
      const token = await auth.currentUser?.getIdToken(true);

      const res = await fetch(`${environment.API_BASE}/terms/accept`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      return res.ok;

    } catch (err) {
      console.error('Error aceptando términos', err);
      return false;
    }
  }
}
