// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { environment } from '/../../environments/environment';

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

  private workerToken: string | null = null;

  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  public authFlowstarted = false; 

  constructor(private http: HttpClient, private auth: Auth) {

    // ⭐ Sincroniza sesión Firebase
    onAuthStateChanged(this.auth, async (user) => {
      if (!user) return;

      const accepted = await this.checkTerms(user.uid);
      this.termsAcceptedSubject.next(accepted);
    });
  }

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
  // Login clásico (Worker)
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
  // Registro Worker
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
  // Login con Google
  // -----------------------
  async loginWithGoogle(): Promise<User | null> {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);

      const token = await result.user.getIdToken();
      this.workerToken = token;

      return result.user;

    } catch (err) {
      console.error('❌ Error Google Auth:', err);
      return null;
    }
  }

  // -----------------------
  // Verificar términos
  // -----------------------
  async checkTerms(uid: string): Promise<boolean> {
    try {
      const res = await fetch(`${environment.API_BASE}/terms/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });

      if (!res.ok) return false;

      const j = await res.json().catch(() => null);
      return !!j?.accepted;

    } catch (err) {
      console.error('💥 Error en checkTerms:', err);
      return false;
    }
  }

  // -----------------------
  // Registrar aceptación
  // -----------------------
  async markTermsAcceptedRemote(): Promise<boolean> {
    try {
      const token = await this.getIdToken();
      if (!token) return false;

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

  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
    this.termsAcceptedSubject.next(false);
  }
}
