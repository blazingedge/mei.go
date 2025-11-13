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
  // 🔐 token del worker para login clásico
  private workerToken: string | null = null;

  // 🔮 estado reactivo de T&C
  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  constructor(private http: HttpClient, private auth: Auth) {

    // ⭐ Escucha cambios de sesión Firebase
    onAuthStateChanged(this.auth, async (user) => {
      if (!user) return;

      // Cuando el usuario inicia sesión en Firebase (Google)
      const accepted = await this.checkTerms(user.uid);
      this.termsAcceptedSubject.next(accepted);
    });
  }

  // ======================================================
  // 🚀 UTILIDADES
  // ======================================================

  get currentUser(): User | null {
    return this.auth.currentUser ?? null;
  }

  async getIdToken(): Promise<string | null> {
    const user = this.currentUser;

    // 🟢 Firebase login (Google)
    if (user) {
      try {
        return await user.getIdToken();
      } catch (err) {
        console.warn('⚠️ No se pudo obtener token Firebase:', err);
      }
    }

    // 🟡 Login clásico (worker)
    return this.workerToken;
  }

  // ======================================================
  // 🔐 LOGIN CLÁSICO (worker)
  // ======================================================
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

  // ======================================================
  // 📝 REGISTRO CLÁSICO (worker)
  // ======================================================
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

  // ======================================================
  // 🔑 LOGIN CON GOOGLE (Firebase)
  // ======================================================
  async loginWithGoogle(): Promise<User | null> {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);

      // Guardamos token Firebase como "token worker"
      const token = await result.user.getIdToken();
      this.workerToken = token;

      return result.user;
    } catch (err) {
      console.error('❌ Error Google Auth:', err);
      return null;
    }
  }

  // ======================================================
  // 📘 CHECK TÉRMINOS
  // ======================================================
  async checkTerms(uid: string): Promise<boolean> {
    try {
      const res = await fetch(`${environment.API_BASE}/terms/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid })
      });

      if (!res.ok) {
        console.warn('⚠️ /api/terms/check →', res.status);
        return false;
      }

      const j = await res.json().catch(() => null);
      return !!j?.accepted;

    } catch (err) {
      console.error('💥 Error en checkTerms:', err);
      return false;
    }
  }

  // ======================================================
  // 🖋️ REGISTRO DE TÉRMINOS (Worker)
  // ======================================================
  async markTermsAcceptedRemote(): Promise<boolean> {
    try {
      const token = await this.getIdToken();

      if (!token) {
        console.warn('⚠️ No hay token Firebase ni Worker → no puedo registrar T&C');
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

      if (!data.ok) {
        console.error('❌ Error registrando T&C:', data);
        return false;
      }

      // Notificar a la app que ya fue aceptado
      this.termsAcceptedSubject.next(true);
      return true;

    } catch (err) {
      console.error('💥 markTermsAcceptedRemote error:', err);
      return false;
    }
  }

  // ======================================================
  // 🌙 MARCA INTERNA (solo frontend)
  // ======================================================
  markTermsAccepted() {
    this.termsAcceptedSubject.next(true);
  }

  // ======================================================
  // 🚪 LOGOUT UNIVERSAL
  // ======================================================
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
    this.termsAcceptedSubject.next(false);
  }
}
