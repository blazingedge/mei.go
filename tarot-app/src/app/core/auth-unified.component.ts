import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LogoComponent } from "./logo.component";

@Component({
  standalone: true,
  selector: 'app-auth-unified',
  imports: [CommonModule, FormsModule, LogoComponent],
  template: `
  <div class="auth-layout">
  <div class="auth-left">
    <app-logo></app-logo>
  </div>

    <div class="auth-layout">
      <div class="auth-card">

        <!-- LOGIN -->
        <section class="section">
          <h2>Iniciar sesión</h2>
          <form (ngSubmit)="onLogin()" #loginForm="ngForm">
            <input
              type="email"
              name="loginEmail"
              [(ngModel)]="login.email"
              required
              placeholder="email"
              [disabled]="loading"
            />
            <input
              type="password"
              name="loginPassword"
              [(ngModel)]="login.password"
              required
              placeholder="contraseña"
              [disabled]="loading"
            />
            @if (loginError) {
              <p class="error">{{ loginError }}</p>
            }
            <button type="submit" [disabled]="loginForm.invalid || loading">Entrar</button>
          </form>
        </section>

        <!-- SEPARADOR + SOCIAL -->
        <div class="divider">
          <span>ó</span>
        </div>
        <div class="social">
          <button class="social-btn google" type="button" (click)="authGoogle()" [disabled]="loading">
            <img src="assets/google.svg" alt="" />
          </button>
          <button class="social-btn facebook" type="button" (click)="authFacebook()" [disabled]="loading">
            <img src="assets/facebook.svg" alt="" />
          </button>
        </div>

        <!-- SEGUNDO SEPARADOR -->
        <div class="divider thin"></div>

        <!-- REGISTER -->
        <section class="section">
          <h2>Regístrate</h2>
          <form (ngSubmit)="onRegister()" #regForm="ngForm">
            <input
              type="email"
              name="regEmail"
              [(ngModel)]="register.email"
              required
              placeholder="email"
              [disabled]="loading"
            />
            <input
              type="password"
              name="regPassword"
              [(ngModel)]="register.password"
              required
              placeholder="contraseña"
              [disabled]="loading"
            />
            <input
              type="password"
              name="regConfirm"
              [(ngModel)]="register.confirm"
              required
              placeholder="repetir contraseña"
              [disabled]="loading"
            />
            @if (regError) {
              <p class="error">{{ regError }}</p>
            }
            <button type="submit" [disabled]="regForm.invalid || loading">Crear cuenta</button>
          </form>
        </section>

        <div class="corner" aria-hidden="true"></div>
      </div>
    </div>
  `,
  styles: [`
    .auth-layout {
  min-height: 100dvh;
  display: flex;                /* En lugar de grid */
  justify-content: flex-end;    /* Mueve al lado derecho */
  align-items: center;          /* Centra verticalmente */
  background: linear-gradient(180deg, #133d47, #0b2630 70%);
  padding: 12rem;
  padding-top: 1rem;
}

    .auth-card {
      position: relative;
      width: min(420px, 95vw);
      border-radius: 18px;
      padding: 20px 22px 24px;
      background: rgba(0,0,0,.35);
      color: #efe7d2;
      box-shadow: 0 10px 30px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.06);
      overflow: hidden;
    }
    .auth-card::before {
      content: "";
      position: absolute; inset: -8px;
      background:
        radial-gradient(120px 200px at -20% 120%, rgba(31,107,89,.5) 0, transparent 60%),
        radial-gradient(120px 200px at 120% -20%, rgba(79,47,74,.5) 0, transparent 60%),
        radial-gradient(140px 140px at 10% 10%, rgba(202,164,72,.25) 0, transparent 70%),
        radial-gradient(120px 120px at 90% 90%, rgba(202,164,72,.25) 0, transparent 70%);
      mix-blend-mode: soft-light;
      opacity: .6;
      pointer-events: none;
      border-radius: 22px;
    }
    .section { margin-bottom: 20px; }
    h2 {
      margin: 0 0 12px;
      font-size: 1.15rem;
      letter-spacing: .4px;
    }
    form {
      display: grid;
      gap: 12px;
    }
    input {
      appearance: none;
      border: 1px solid rgba(202,164,72,.45);
      background:
        linear-gradient(180deg, rgba(255,255,255,.04), rgba(0,0,0,.18)),
        linear-gradient(90deg, rgba(31,107,89,.15), rgba(79,47,74,.08));
      color: #efe7d2;
      border-radius: 12px;
      padding: 12px 14px;
      outline: none;
      box-shadow: inset 0 2px 6px rgba(0,0,0,.35);
      transition: box-shadow .2s ease, border-color .2s ease;
    }
    input::placeholder { color: rgba(239,231,210,.65); }
    input:focus {
      border-color: #caa448;
      box-shadow: 0 0 0 3px rgba(202,164,72,.18), inset 0 2px 6px rgba(0,0,0,.45);
    }
    .error {
      margin: 4px 0 0;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid rgba(255,84,84,.4);
      background: linear-gradient(180deg, rgba(255,84,84,.12), rgba(107,31,31,.12));
      color: #ffd9d9;
      font-size: .9rem;
    }
    button[type="submit"] {
      margin-top: 6px;
      padding: 12px 16px;
      border-radius: 14px;
      background: linear-gradient(180deg, #d6b15a, #b79034);
      border: 1px solid #8a6c22;
      color: #1a1405;
      font-weight: 700;
      letter-spacing: .4px;
      text-shadow: 0 1px 0 rgba(255,255,255,.35);
      box-shadow: 0 6px 14px rgba(202,164,72,.25), inset 0 1px 0 rgba(255,255,255,.3);
      cursor: pointer;
      transition: transform .05s ease, box-shadow .2s ease, filter .2s ease;
    }
    button[type="submit"]:hover {
      box-shadow: 0 10px 22px rgba(202,164,72,.35), inset 0 1px 0 rgba(255,255,255,.35);
      filter: saturate(110%);
    }
    button[type="submit"]:disabled {
      opacity: .6; cursor: default; filter: grayscale(.3);
    }

    .divider {
      position: relative;
      display: grid;
      place-items: center;
      margin: 10px 0 14px;
      height: 28px;
    }
    .divider::before,
    .divider::after {
      content: "";
      position: absolute;
      height: 1px;
      width: 40%;
      background: linear-gradient(90deg, rgba(255,255,255,.05), rgba(255,255,255,.25), rgba(255,255,255,.05));
      top: 50%;
      transform: translateY(-50%);
    }
    .divider::before { left: 0; }
    .divider::after  { right: 0; }
    .divider span {
      display: inline-grid; place-items: center;
      width: 28px; height: 28px; border-radius: 50%;
      background: rgba(255,255,255,.06);
      border: 1px solid rgba(255,255,255,.12);
      box-shadow: 0 2px 6px rgba(0,0,0,.35);
      font-weight: 700;
    }
    .divider.thin { height: 10px; margin: 6px 0 12px; }
    .divider.thin::before, .divider.thin::after { width: 100%; }

    .social {
      display: flex; gap: 14px; justify-content: center;
      margin-bottom: 10px;
    }
    .social-btn {
      width: 42px; height: 42px; border-radius: 12px; border: 1px solid rgba(255,255,255,.18);
      display: grid; place-items: center; background: rgba(255,255,255,.06);
      box-shadow: 0 6px 14px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.3);
      cursor: pointer;
      transition: transform .05s ease, box-shadow .2s ease, filter .2s ease;
    }
    .social-btn:hover { filter: saturate(110%); box-shadow: 0 10px 20px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.35); }
    .social-btn img { width: 22px; height: 22px; display: block; }
  `]
})
export class AuthUnifiedComponent {

  // Cambia por environment.apiBase si lo tienes
  apiBase = (window as any).API_BASE ?? 'http://127.0.0.1:8787';

  loading = false;

  login = { email: '', password: '' };
  register = { email: '', password: '', confirm: '' };

  loginError = '';
  regError = '';

  async onLogin() {
    this.loginError = '';
    if (!this.login.email || !this.login.password) {
      this.loginError = 'Completa todos los campos';
      return;
    }
    this.loading = true;
    try {
      const res = await fetch(`${this.apiBase}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(this.login),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'No se pudo iniciar sesión');
      // TODO: redirigir al dashboard
    } catch (e: any) {
      this.loginError = e?.message || 'Error de red';
    } finally {
      this.loading = false;
    }
  }

  async onRegister() {
    this.regError = '';
    if (!this.register.email || !this.register.password) {
      this.regError = 'Completa todos los campos';
      return;
    }
    if (this.register.password !== this.register.confirm) {
      this.regError = 'Las contraseñas no coinciden';
      return;
    }
    this.loading = true;
    try {
      const res = await fetch(`${this.apiBase}/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email: this.register.email, password: this.register.password }),
      });
      if (res.status === 409) {
        this.regError = 'Este correo ya está registrado';
        return;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'No se pudo registrar');
      // TODO: opcional: auto-login o scroll top
    } catch (e: any) {
      this.regError = e?.message || 'Error de red';
    } finally {
      this.loading = false;
    }
  }

  authGoogle() {
    window.location.href = `${this.apiBase}/oauth/google/start`;
  }
  authFacebook() {
    window.location.href = `${this.apiBase}/oauth/facebook/start`;
  }
}
