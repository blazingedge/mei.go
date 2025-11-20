import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';
import { TermsCoordinatorService } from './terms-coordinator.service';
import { getAuth } from '@angular/fire/auth';

export type SessionCheckResult = 'ok' | 'needs-terms' | 'invalid';

@Injectable({ providedIn: 'root' })
export class SessionService {

  private pendingValidation: Promise<SessionCheckResult> | null = null;

  constructor(private terms: TermsCoordinatorService) {}


   private state: SessionSnapshot = {
    uid: null,
    email: null,
    drucoins: 0,
    needsTerms: true
  };

  get snapshot() {
    return this.state;
  }

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
    const auth = getAuth();
    const token = await auth.currentUser?.getIdToken(true);

    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token ?? ''}`
      }
    });

    // Unauthorized
    if (res.status === 401) {
      this.state = { uid:null, email:null, drucoins:0, needsTerms:true };
      return 'invalid';
    }

    const type = res.headers.get('content-type') || '';
    if (!type.includes('application/json')) return 'invalid';

    const data = await res.json();

    this.state = {
      uid: data.uid,
      email: data.email,
      drucoins: data.drucoins ?? 0,
      needsTerms: data.needsTerms
    };

    if (data.needsTerms) return 'needs-terms';
    return 'ok';

  } catch (err) {
    console.error("validate error:", err);
    this.state = { uid:null, email:null, drucoins:0, needsTerms:true };
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

export interface SessionSnapshot {
  uid: string | null;
  email: string | null;
  drucoins: number;
  needsTerms: boolean;
}

