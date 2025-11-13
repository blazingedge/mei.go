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

@Injectable({ providedIn: 'root' })
export class AuthService {

  // -----------------------
  // FLAGS Y ESTADO
  // -----------------------
  public authFlowStarted = false;   // <-- CORREGIDO Y ESTANDARIZADO
  private workerToken: string | null = null;

  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  constructor(private http: HttpClient, private auth: Auth) {

    // ⭐ Listener de Firebase
    onAuthStateChanged(this.auth, async (user) => {
      if (!user) return;

      // Cuando Firebase cambia de usuario, verificamos términos
      const accepted = await this.checkTerms(user.uid);

      // Emitimos resultado al flujo
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
        console.warn('⚠️ No se pudo obtener token Firebase:', err);
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
      console.error('❌ Error en login:', err);
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
      console.error('❌ Error en register:', err);
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
      console.error('❌ Error Google Auth:', err);
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
        console.warn('⚠️ /api/terms/check → status', res.status);
        return false;
      }

      const j = await res.json().catch(() => null);
      return !!j?.accepted;

    } catch (err) {
      console.error('💥 Error en checkTerms:', err);
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
        console.warn('⚠️ No hay token para registrar T&C');
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

      this.termsAcceptedSubject.next(true);
      return true;

    } catch (err) {
      console.error('💥 markTermsAcceptedRemote error:', err);
      return false;
    }
  }

  markTermsAccepted() {
    this.termsAcceptedSubject.next(true);
  }

  // -----------------------
  // LOGOUT
  // -----------------------
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
    this.termsAcceptedSubject.next(false);
  }
}
