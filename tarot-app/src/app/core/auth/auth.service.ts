// src/app/core/services/auth.service.ts
import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { onAuthStateChanged } from '@angular/fire/auth';
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
  
  private termsAcceptedSubject = new BehaviorSubject<boolean>(false);
  termsAccepted$ = this.termsAcceptedSubject.asObservable();

  constructor(private http: HttpClient, private auth: Auth) {

  // 👇 SE AGREGA AQUÍ — sin crear otro constructor
  onAuthStateChanged(this.auth, async (user) => {
    if (!user) return;

    // ⚡ cuando Firebase autentica (incluso con Google redirect)
    const accepted = await this.checkTerms(user.uid);

    // guarda en un BehaviorSubject que debes crear
    this.termsAcceptedSubject.next(accepted);
  });
}
  

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
     

      return result.user;
    } catch (err) {
      console.error('❌ Error Google Auth:', err);
      return null;
    }
  }

async checkTerms(uid: string): Promise<boolean> {
  try {
    const res = await fetch(`${environment.API_BASE}/api/terms/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid })
    });

    if (!res.ok) {
      console.warn('⚠️ /api/terms/check respondió', res.status);
      return false; // si hay error, forzamos a mostrar modal
    }

    const j = await res.json().catch(() => null);
    return !!j?.accepted;
  } catch (err) {
    console.error('💥 Error en checkTerms:', err);
    return false; // en duda → obligamos a aceptar otra vez
  }
}

markTermsAccepted() {
  this.termsAcceptedSubject.next(true);
}

  // ✅ Logout universal
  async logout(): Promise<void> {
    this.workerToken = null;
    await signOut(this.auth);
  }
}
