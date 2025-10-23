// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';
import { Auth, GoogleAuthProvider, signInWithPopup, signOut } from '@angular/fire/auth';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private accessToken: string | null = null;

  constructor(private http: HttpClient, private auth: Auth) {}

  getAccessToken() {
    return this.accessToken;
  }

  // --- LOGIN clásico (tu Worker)
  async login(email: string, password: string) {
    const res = await this.http
      .post<{ ok: boolean; access?: string }>(
        `${environment.API_BASE}/auth/login`,
        { email, password },
        { withCredentials: true }
      )
      .toPromise();

    if (res?.ok && res.access) this.accessToken = res.access;
    return !!this.accessToken;
  }

  // --- REGISTER clásico (tu Worker)
  async register(email: string, password: string) {
    const res = await this.http
      .post<{ ok: boolean }>(
        `${environment.API_BASE}/auth/register`,
        { email, password },
        { withCredentials: true }
      )
      .toPromise();
    return !!res?.ok;
  }

  // --- LOGIN con Google (Firebase popup)
  async loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(this.auth, provider);

    const token = await result.user.getIdToken();
    this.accessToken = token;

    // (opcional) registra en tu API
    await this.http
      .post(`${environment.API_BASE}/auth/firebase`, { token })
      .toPromise()
      .catch(() => {});

    return result.user;
  }

  async logout() {
    this.accessToken = null;
    await signOut(this.auth);
  }
}
