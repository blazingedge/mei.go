// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import {
  Auth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  User,
  getAuth
} from '@angular/fire/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private workerToken: string | null = null;

  constructor(private http: HttpClient, private auth: Auth) {}

  // ✅ Devuelve el usuario actual de Firebase (si existe)
  get currentUser(): User | null {
    // @ts-ignore — AngularFire Auth tiene esta propiedad en runtime
    return this.auth.currentUser ?? null;
  }

  // ✅ Devuelve el token que corresponda (Firebase o Worker)
  async getIdToken(): Promise<string | null> {
    const user = this.currentUser;
    if (user) {
      try {
        const firebaseToken = await user.getIdToken();
        return firebaseToken;
      } catch (err) {
        console.warn('⚠️ No se pudo obtener token Firebase:', err);
      }
    }
    return this.workerToken;
  }

  // ✅ Login clásico (API Worker)
  async login(email: string, password: string): Promise<boolean> {
    try {
      const res = await this.http
        .post<{ ok: boolean; access?: string }>(
          `${environment.API_BASE}/auth/login`,
          { email, password },
          { withCredentials: true }
        )
        .toPromise();

      if (res?.ok && res.access) {
        this.workerToken = res.access;
        return true;
      }
      return false;
    } catch (err) {
      console.error('❌ Error en login:', err);
      return false;
    }
  }

  // ✅ Registro clásico (API Worker)
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

  // ✅ Login con Google (Firebase)
  async loginWithGoogle(): Promise<User | null> {
    try {
      const provider = new GoogleAuthProvider();
      const result = await signInWithPopup(this.auth, provider);

      const token = await result.user.getIdToken();
      this.workerToken = token; // reusamos estructura

      // (opcional) sincroniza con tu Worker si quieres validarlo allá
      await this.http
        .post(`${environment.API_BASE}/auth/firebase`, { token })
        .toPromise()
        .catch(() => {});

      return result.user;
    } catch (err) {
      console.error('❌ Error Google Auth:', err);
      return null;
    }
  }

  checkTerms(uid: string) {
  return fetch(`${environment.API_BASE}/terms/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  })
  .then(r => r.json())
  .then(j => j.accepted === true);
}


  // ✅ Logout universal
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
  }
}
