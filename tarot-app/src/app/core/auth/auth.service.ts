// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

import {
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  User,
  onAuthStateChanged
} from '@angular/fire/auth';
import { browserLocalPersistence, setPersistence } from 'firebase/auth';

export type PlanId = 'luz' | 'sabiduria' | 'quantico';

export interface SessionSnapshot {
  user?: { uid: string; email: string; plan: PlanId };
  quota?: { monthly: number; used: number; remaining: number; period: string };
  drucoins?: number;
}

@Injectable({ providedIn: 'root' })
export class AuthService {

  // -----------------------
  // FLAGS Y ESTADO
  // -----------------------
  public authFlowStarted = false;   // <-- CORREGIDO Y ESTANDARIZADO
  private workerToken: string | null = null;

  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  private userSubject = new BehaviorSubject<{ uid: string; email: string; plan: PlanId } | null>(null);
  user$ = this.userSubject.asObservable();

  private planSubject = new BehaviorSubject<PlanId | null>(null);
  plan$ = this.planSubject.asObservable();

  private quotaSubject = new BehaviorSubject<{ monthly: number; used: number; remaining: number; period: string } | null>(null);
  quota$ = this.quotaSubject.asObservable();

  private quotaRemainingSubject = new BehaviorSubject<number>(0);
  quotaRemaining$ = this.quotaRemainingSubject.asObservable();

  private drucoinBalanceSubject = new BehaviorSubject<number>(0);
  drucoinBalance$ = this.drucoinBalanceSubject.asObservable();

  private needsTermsSubject = new BehaviorSubject<boolean>(false);
  needsTerms$ = this.needsTermsSubject.asObservable();

  constructor(private http: HttpClient, private auth: Auth) {

    setPersistence(this.auth, browserLocalPersistence).catch(err =>
      console.warn('No se pudo configurar la persistencia de Firebase:', err)
    );

    onAuthStateChanged(this.auth, async (user) => {
      if (!user) {
        this.clearSessionState();
        this.termsAcceptedSubject.next(false);
        return;
      }

      const accepted = await this.checkTerms(user.uid);
      this.termsAcceptedSubject.next(accepted);
    });
  }

  // -----------------------
  // Utils
  // -----------------------
  get currentUser(): User | null {
    return this.auth.currentUser ?? null;
  }

  async getIdToken(): Promise<string | null> {
    const user = this.currentUser;

    if (user) {
      try {
        return await user.getIdToken();
      } catch (err) {
        console.warn('âš ï¸ No se pudo obtener token Firebase:', err);
      }
    }

    return this.workerToken;
  }

  // -----------------------
  // LOGIN WORKER
  // -----------------------
  async login(email: string, password: string): Promise<boolean> {
    try {
      const res = await this.http
        .post<{ ok: boolean; token?: string }>(
          `${environment.API_BASE}/auth/login`,
          { email, password },
          { withCredentials: true }
        )
        .toPromise();

      if (res?.ok && res.token) {
        this.workerToken = res.token;
        return true;
      }
      return false;

    } catch (err) {
      console.error('âŒ Error en login:', err);
      return false;
    }
  }

  // -----------------------
  // REGISTER WORKER
  // -----------------------
  async register(email: string, password: string): Promise<boolean> {
    try {
      const res = await this.http
        .post<{ ok: boolean }>(
          `${environment.API_BASE}/auth/register`,
          { email, password },
          { withCredentials: true }
        )
        .toPromise();

      return !!res?.ok;

    } catch (err) {
      console.error('âŒ Error en register:', err);
      return false;
    }
  }

  // -----------------------
  // LOGIN GOOGLE
  // -----------------------
  async loginWithGoogle(): Promise<User | null> {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);

      // Guardar token Firebase como token worker temporal
      const token = await result.user.getIdToken();
      this.workerToken = token;

      return result.user;

    } catch (err) {
      console.error('âŒ Error Google Auth:', err);
      return null;
    }
  }

  // -----------------------
  // CHECK TERMS
  // -----------------------
  async checkTerms(uid: string): Promise<boolean> {
    try {
      const res = await fetch(`${environment.API_BASE}/terms/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });

      if (!res.ok) {
        console.warn('âš ï¸ /api/terms/check â†’ status', res.status);
        return false;
      }

      const j = await res.json().catch(() => null);
      return !!j?.accepted;

    } catch (err) {
      console.error('ðŸ’¥ Error en checkTerms:', err);
      return false;
    }
  }

  // -----------------------
  // REGISTER TERMS ACCEPT
  // -----------------------
  async markTermsAcceptedRemote(): Promise<boolean> {
    try {
      const token = await this.getIdToken();
      if (!token) {
        console.warn('âš ï¸ No hay token para registrar T&C');
        return false;
      }

      const res = await fetch(`${environment.API_BASE}/terms/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          version: '1.0',
          acceptedAt: Date.now()
        })
      });

      const data = await res.json();
      if (!data.ok) return false;

      this.markTermsAccepted();
      return true;

    } catch (err) {
      console.error('ðŸ’¥ markTermsAcceptedRemote error:', err);
      return false;
    }
  }

  markTermsAccepted() {
    this.termsAcceptedSubject.next(true);
    this.needsTermsSubject.next(false);
  }

  async syncTermsStatus(): Promise<boolean> {
    try {
      const token = await this.getIdToken();
      if (!token) return false;

      const res = await fetch(`${environment.API_BASE}/terms/needs`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) return false;

      const data = await res.json().catch(() => null);
      if (data?.needs) {
        this.needsTermsSubject.next(true);
        this.termsAcceptedSubject.next(false);
        return true;
      } else {
        this.needsTermsSubject.next(false);
        this.termsAcceptedSubject.next(true);
        return false;
      }
    } catch (err) {
      console.error('syncTermsStatus error:', err);
      return false;
    }
  }

  applySessionSnapshot(snapshot: SessionSnapshot | null) {
    if (!snapshot || !snapshot.user) {
      this.clearSessionState();
      return;
    }

    this.userSubject.next(snapshot.user);
    this.planSubject.next(snapshot.user.plan);

    if (snapshot.quota) {
      this.quotaSubject.next(snapshot.quota);
      this.quotaRemainingSubject.next(snapshot.quota.remaining);
    } else {
      this.quotaSubject.next(null);
      this.quotaRemainingSubject.next(0);
    }

    if (typeof snapshot.drucoins === 'number') {
      this.drucoinBalanceSubject.next(snapshot.drucoins);
    } else {
      this.drucoinBalanceSubject.next(0);
    }
  }

  clearSessionState() {
    this.userSubject.next(null);
    this.planSubject.next(null);
    this.quotaSubject.next(null);
    this.quotaRemainingSubject.next(0);
    this.drucoinBalanceSubject.next(0);
  }

  requireTermsAcceptance() {
    this.authFlowStarted = true;
    this.needsTermsSubject.next(true);
    this.termsAcceptedSubject.next(false);
  }

  // -----------------------
  // LOGOUT
  // -----------------------
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
    this.termsAcceptedSubject.next(false);
    this.needsTermsSubject.next(false);
    this.clearSessionState();
  }
}

