import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../../environments/environment';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private accessToken: string | null = null;

  constructor(private http: HttpClient) {}
  getAccessToken() { return this.accessToken; }

  async login(email: string, password: string) {
    const res = await this.http.post<{ ok: boolean; access?: string }>(
      `${environment.API_BASE}/auth/login`,
      { email, password },
      { withCredentials: true }   // cookie httpOnly de refresh
    ).toPromise();
    if (res?.ok && res.access) this.accessToken = res.access;
    return !!this.accessToken;
  }
}
