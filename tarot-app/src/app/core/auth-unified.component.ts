// src/app/auth/auth-unified.component.ts
import { Component, AfterViewInit, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { LogoComponent } from './logo.component';
import { IntroParticlesComponent } from './intro-particles/intro-partilces.component';
import { TermsModalComponent } from '../components/terms-modal.component';

import { AuthService } from './auth/auth.service';
import { environment } from '../../environments/environment';

@Component({
  standalone: true,
  selector: 'app-auth-unified',
  imports: [
    CommonModule,
    FormsModule,
    LogoComponent,
    IntroParticlesComponent,
    TermsModalComponent
  ],
  templateUrl: './auth-unified.component.html',
  styleUrls: ['./auth-unified.component.scss']
})
export class AuthUnifiedComponent implements AfterViewInit, OnInit {

  showIntro = true;
  showTerms = false;
  acceptedTerms = false;

  loading = false;
  loginError = '';
  regError = '';

  login = { email: '', password: '' };
  register = { email: '', password: '', confirm: '' };

  constructor(private auth: AuthService, private router: Router) {}

  // ======================================================
  // 🎬 INTRO EFECTO
  // ======================================================
  ngAfterViewInit() {
    this.playIntro();

    const intro = document.querySelector('.intro-overlay') as HTMLElement | null;

    if (intro) {
      intro.addEventListener('animationend', () => {
        intro.style.display = 'none';
        intro.style.pointerEvents = 'none';
        this.showIntro = false;
      });
    }

    setTimeout(() => {
      const el = document.querySelector('.intro-overlay') as HTMLElement | null;
      if (el) {
        el.style.display = 'none';
        el.style.pointerEvents = 'none';
      }
      this.showIntro = false;
    }, 6000);
  }

  async playIntro() {
    const audio = new Audio('assets/audio/el-meigo.mp3');
    audio.volume = 0.55;

    try {
      await audio.play();
    } catch {
      console.warn('🔇 Autoplay bloqueado');
    }
  }

  // ======================================================
  // 🔄 OBSERVADOR DE TERMS (solo para redirecciones)
  // ======================================================
  ngOnInit() {
  
  }

  // ======================================================
  // 🔐 LOGIN CLÁSICO
  // ======================================================
  async onLogin() {
    this.loginError = '';
    if (!this.login.email || !this.login.password) {
      this.loginError = 'Completa todos los campos';
      return;
    }

    this.loading = true;

    try {
      const ok = await this.auth.login(this.login.email, this.login.password);
      if (!ok) throw new Error('Credenciales inválidas');

      const user = this.auth.currentUser;
      const uid = user?.uid ?? null;

      if (uid) {
        const accepted = await this.auth.checkTerms(uid);

        if (!accepted) {
          this.showTerms = true;
          return;
        }
      }

      this.router.navigate(['/spreads']);
    } catch (e: any) {
      this.loginError = e.message ?? 'Error al iniciar sesión';
    } finally {
      this.loading = false;
    }
  }

  // ======================================================
  // 🪶 TÉRMINOS Y CONDICIONES
  // ======================================================
  openTerms() {
    this.showTerms = true;
  }

  async onTermsAccepted() {
    const ok = await this.auth.markTermsAcceptedRemote();

    if (!ok) {
      alert('No se pudieron guardar los términos.');
      return;
    }

    this.auth.markTermsAccepted();
    this.acceptedTerms = true;

    this.showTerms = false;
    this.router.navigate(['/spreads']);
  }

  onTermsClosed() {
    this.showTerms = false;
  }

  // ======================================================
  // 🧾 REGISTRO
  // ======================================================
  async onRegister() {
    if (!this.acceptedTerms) {
      alert('Debes aceptar los términos antes de registrarte.');
      return;
    }

    this.regError = '';

    const tokenEl = document.querySelector(
      'input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | null;
    const turnstileToken = tokenEl?.value ?? '';

    if (!turnstileToken) {
      this.regError = 'Completa el desafío "No soy un robot".';
      return;
    }

    this.loading = true;

    try {
      const vr = await fetch(`${environment.API_BASE}/captcha/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: turnstileToken })
      });

      if (!vr.ok) throw new Error('Captcha inválido');

      const ok = await this.auth.register(this.register.email, this.register.password);
      if (!ok) throw new Error('No se pudo registrar');

      alert('Registro completado. Ahora puedes iniciar sesión.');
    } catch (e: any) {
      this.regError = e.message ?? 'Error al registrar';
    } finally {
      this.loading = false;
    }
  }

  // ======================================================
  // 🔑 LOGIN CON GOOGLE
  // ======================================================
  async authGoogle() {
  this.loading = true;

  try {
    // 1. Login con Google
    const result = await this.auth.loginWithGoogle();
    if (!result) return;

    // 👉 Usa el UID directamente del resultado del popup
    const uid = result.uid;

    // 2. Preguntar al backend si ya aceptó T&C
    const accepted = await this.auth.checkTerms(uid);

    // 3. Si NO ha aceptado → mostrar modal
    if (!accepted) {
      this.showTerms = true;
      return;
    }

    // 4. Si ya aceptó → continuar al dashboard
    this.router.navigate(['/spreads']);

  } finally {
    this.loading = false;
  }
}



  // ======================================================
  // ⚙️ Otros
  // ======================================================
  authFacebook() {
    alert('Login con Facebook no implementado.');
  }
}

// ======================================================
// 🌐 CALLBACK GLOBAL TURNSTILE
// ======================================================
declare global {
  interface Window {
    onCaptchaVerified: (token: string) => void;
  }
}

window.onCaptchaVerified = async (token: string) => {
  console.log('Token Turnstile recibido:', token);

  try {
    const res = await fetch(`${environment.API_BASE}/captcha/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Verificación CAPTCHA fallida.');
    }
  } catch (err) {
    console.error('Error verificando Turnstile:', err);
  }
};
