// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { sendEmailVerification } from '@angular/fire/auth';



import {
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
} from '@angular/fire/auth';

import { browserLocalPersistence, setPersistence } from 'firebase/auth';

export type PlanId = 'luz' | 'sabiduria' | 'quantico';
export type GoogleLoginResult = User | 'redirect';

export interface SessionSnapshot {
  user?: { uid: string; email: string; plan: PlanId };
  drucoins?: number;
}

@Injectable({ providedIn: 'root' })
export class AuthService {

  // -----------------------
  // ESTADO
  // -----------------------
  public authFlowStarted = false;
  private workerToken: string | null = null;

  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  private needsTermsSubject = new BehaviorSubject<boolean>(false);
  needsTerms$ = this.needsTermsSubject.asObservable();

  private drucoinBalanceSubject = new BehaviorSubject<number>(0);
  drucoinBalance$ = this.drucoinBalanceSubject.asObservable();

  private userSubject = new BehaviorSubject<{ uid: string; email: string; plan: PlanId } | null>(null);
  user$ = this.userSubject.asObservable();

  

  constructor(private http: HttpClient, private auth: Auth) {

    // Persistencia Firebase
    setPersistence(this.auth, browserLocalPersistence).catch(err =>
      console.warn('[Auth] Persistencia Firebase falló:', err)
    );

    // Listener de login Firebase
    onAuthStateChanged(this.auth, async (user) => {
      console.group('%c[AuthStateChanged]', 'color:#9cf');

      if (!user) {
        console.warn('→ Usuario null: limpiando sesión');
        this.clearSessionState();
        console.groupEnd();
        return;
      }

      const token = await user.getIdToken().catch(() => null);
      this.workerToken = token;

      console.log('→ Token obtenido');

      // NUEVO FLUJO: llamar /api/terms/needs
      const needs = await this.fetchNeedsTerms(token);
      console.log('→ NeedsTerms?', needs);

      this.needsTermsSubject.next(needs);
      this.termsAcceptedSubject.next(!needs);

      console.groupEnd();
    });
  }

  // -----------------------
  // UTILS
  // -----------------------
  get currentUser(): User | null {
    return this.auth.currentUser ?? null;
  }

  async getIdToken(): Promise<string | null> {
    const u = this.currentUser;
    if (!u) return this.workerToken;

    try {
      return await u.getIdToken(true);
    } catch {
      return this.workerToken;
    }
  }

  async syncTermsStatus(): Promise<boolean> {
  const token = await this.getIdToken();
  if (!token) {
    this.needsTermsSubject.next(true);
    return true;
  }

  try {
    const needs = await this.fetchNeedsTerms(token);
    this.needsTermsSubject.next(needs);
    this.termsAcceptedSubject.next(!needs);
    return needs;
  } catch {
    this.needsTermsSubject.next(true);
    return true;
  }
}

      //
  // LOGIN TRADICIONAL
  // -----------------------
  async login(email: string, password: string): Promise<boolean> {
  try {
    const result = await signInWithEmailAndPassword(this.auth, email, password);
    const token = await result.user.getIdToken(true);
    this.workerToken = token;
    return true;
  } catch (err) {
    console.error('[Auth] login error Firebase:', err);
    return false;
  }
}

  // -----------------------
  // REGISTRO TRADICIONAL
  // -----------------------
  async register(email: string, password: string): Promise<boolean> {
  try {
    const res = await this.http
      .post<{ ok: boolean; error?: string; message?: string }>(
        `${environment.API_BASE}/auth/register`,
        { email, password },
        { withCredentials: true }
      )
      .toPromise();

    if (!res?.ok) {
      console.error('[Auth] register backend error:', res);
      // Lanzamos un error con el mensaje humano si viene
      throw new Error(res?.message || res?.error || 'No se pudo registrar');
    }

    // 🔥 Hacemos login para obtener User (si quieres mantenerlo)
    const loginRes = await this.http
      .post<{ ok: boolean; token?: string }>(
        `${environment.API_BASE}/auth/login`,
        { email, password },
        { withCredentials: true }
      )
      .toPromise();

    if (!loginRes?.ok) {
      console.warn('[Auth] login tras registro falló:', loginRes);
      // Aquí puedes decidir si consideras el registro OK igualmente
      // o lanzas un error también.
    }

    const user = this.auth.currentUser;
    if (user) {
      console.log('📧 Enviando correo de verificación…');
      await sendEmailVerification(user);
    }

    return true;

  } catch (err: any) {
    console.error('[Auth] register error:', err);
    // Propagamos mensaje hacia el componente
    throw err;
  }
}


  // -----------------------
  // GOOGLE LOGIN
  // -----------------------
  async loginWithGoogle(): Promise<GoogleLoginResult> {
    const provider = new GoogleAuthProvider();

    try {
      const result = await signInWithPopup(this.auth, provider);
      this.workerToken = await result.user.getIdToken();
      return result.user;

    } catch (err: any) {
      const code = err?.code || '';

      if (
        code.includes('popup-blocked') ||
        code.includes('popup-closed') ||
        code.includes('third-party-cookie') ||
        code.includes('cors') ||
        code.includes('cross-origin')
      ) {
        await signInWithRedirect(this.auth, provider);
        return 'redirect';
      }

      console.error('[Auth] GoogleAuth error:', err);
      throw err;
    }
  }

  async completeGoogleRedirect(): Promise<User | null> {
    try {
      const result = await getRedirectResult(this.auth);
      if (result?.user) {
        this.workerToken = await result.user.getIdToken();
        return result.user;
      }
      return null;
    } catch (err) {
      console.error('[Auth] Redirect error:', err);
      return null;
    }
  }

  // ============================================================
  //          TERMS — AHORA CON LOS ENDPOINTS CORRECTOS
  // ============================================================

  // ---- NUEVO: GET /api/terms/needs ----
  private async fetchNeedsTerms(token: string | null): Promise<boolean> {
    if (!token) return true;

    try {
      const res = await fetch(`${environment.API_BASE}/terms/needs`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return true;

      const data = await res.json().catch(() => null);
      return !!data?.needs;

    } catch (err) {
      console.error('[Terms] fetchNeedsTerms error:', err);
      return true;
    }
  }

  // ---- NUEVO: POST /terms/accept ----
  async ensureTermsAcceptance(): Promise<boolean> {
    const token = await this.getIdToken();
    if (!token) return false;

    try {
      const res = await fetch(`${environment.API_BASE}/terms/accept`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      const data = await res.json().catch(() => null);

      if (data?.ok) {
        this.termsAcceptedSubject.next(true);
        this.needsTermsSubject.next(false);
        return true;
      }

      return false;

    } catch (err) {
      console.error('[Terms] ensureTermsAcceptance error:', err);
      return false;
    }
  }

  // ============================================================
  //               DRUCOINS + USER SNAPSHOT
  // ============================================================
  applySessionSnapshot(snapshot: SessionSnapshot | null) {
    if (!snapshot || !snapshot.user) {
      this.clearSessionState();
      return;
    }

    this.userSubject.next(snapshot.user);

    if (snapshot.drucoins !== undefined) {
      this.updateDrucoinBalance(snapshot.drucoins);
    }
  }

  updateDrucoinBalance(balance: number | null | undefined) {
    const n = typeof balance === 'number' ? balance : 0;
    this.drucoinBalanceSubject.next(Math.max(n, 0));
  }

  clearSessionState() {
    this.userSubject.next(null);
    this.updateDrucoinBalance(0);
    this.termsAcceptedSubject.next(false);
    this.needsTermsSubject.next(false);
  }

  // -----------------------
  // LOGOUT
  // -----------------------
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
    this.clearSessionState();
  }
  
  requireTermsAcceptance() {
    this.needsTermsSubject.next(true);
    this.termsAcceptedSubject.next(false);
  }

  markTermsAccepted() {
    this.needsTermsSubject.next(false);
    this.termsAcceptedSubject.next(true);
  }
// -----------------------
// RESET PASSWORD
// -----------------------
async resetPassword(email: string): Promise<boolean> {
  try {
    const res = await this.http
      .post<{ ok: boolean }>(
        `${environment.API_BASE}/auth/reset-password`,
        { email },
        { withCredentials: true }
      )
      .toPromise();

    return !!res?.ok;
  } catch (err) {
    console.error('[Auth] resetPassword error:', err);
    return false;
  }
}




}
