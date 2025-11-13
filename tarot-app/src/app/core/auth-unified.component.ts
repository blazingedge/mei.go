import { Component, AfterViewInit, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from './logo.component';
import { AuthService } from './auth/auth.service';
import { IntroParticlesComponent } from './intro-particles/intro-partilces.component';
import { environment } from '../../environments/environment';
import { TermsModalComponent } from '../components/terms-modal.component';

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

  // ============================================================================
  // 🎬 INTRO
  // ============================================================================
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

  // ============================================================================
  // ⭐ ngOnInit — CORREGIDO Y FINAL
  // SOLO ACTÚA SI HAY USUARIO DE FIREBASE
  // ============================================================================

  ngOnInit() {
    this.auth.termsAccepted$.subscribe((accepted) => {
      const user = this.auth.currentUser;

      if (!user) return;  // 🔥 SI NO HAY USUARIO → NO HACER NADA

      if (this.auth.authFlowstarted && !accepted) {
        // usuario logueado, pero sin términos aceptados
        this.showTerms = true;
      }
    });
  }

  // ============================================================================
  // 🔐 LOGIN CLÁSICO
  // ============================================================================

  async onLogin() {
    this.auth.authFlowstarted = true;
    this.loginError = '';
    if (!this.login.email || !this.login.password) {
      this.loginError = 'Completa todos los campos';
      return;
    }

    this.loading = true;

    try {
      const ok = await this.auth.login(this.login.email, this.login.password);
      if (!ok) throw new Error('Credenciales inválidas');

      await this.afterAuth();
    } catch (e: any) {
      this.loginError = e.message || 'Error al iniciar sesión';
    } finally {
      this.loading = false;
    }
  }

  // ============================================================================
  // 🌟 FUNCIÓN CENTRAL — MANEJA TODO EL FLUJO DE TÉRMINOS
  // ============================================================================

  private async afterAuth() {
    // esperar a que Firebase actualice currentUser
    await new Promise(res => setTimeout(res, 250));

    const user = this.auth.currentUser;
    if (!user) return;

    const accepted = await this.auth.checkTerms(user.uid);

    if (!accepted) {
      // ❗ mostrar modal de términos
      this.showTerms = true;
      return;
    }

    // ✔ ya aceptados → entrar
    this.router.navigate(['/spreads']);
  }

  // ============================================================================
  // 📝 REGISTRO
  // ============================================================================
  async onRegister() {
    if (!this.acceptedTerms) {
      alert('Debes aceptar los Términos y Condiciones antes de registrarte.');
      return;
    }

    this.regError = '';

    const tokenEl = document.querySelector(
      'input[name="cf-turnstile-response"]'
    ) as HTMLInputElement | null;

    const turnstileToken = tokenEl?.value || '';

    if (!turnstileToken) {
      this.regError = 'Debes completar el CAPTCHA.';
      return;
    }

    this.loading = true;
    try {
      const vr = await fetch(`${environment.API_BASE}/captcha/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: turnstileToken })
      });
      if (!vr.ok) throw new Error('Captcha inválido.');

      const ok = await this.auth.register(
        this.register.email,
        this.register.password
      );
      if (!ok) throw new Error('No se pudo registrar');

      alert('Registro completado. Ahora puedes iniciar sesión.');
    } catch (e: any) {
      this.regError = e.message || 'Error al registrar';
    } finally {
      this.loading = false;
    }
  }

  // ============================================================================
  // 🔑 LOGIN GOOGLE
  // ============================================================================

  async authGoogle() {
    this.auth.authFlowstarted = true;
    this.loading = true;

    try {
      const user = await this.auth.loginWithGoogle();
      if (!user) return;

      await this.afterAuth();
    } finally {
      this.loading = false;
    }
  }

  // ============================================================================
  // 📜 TÉRMINOS Y CONDICIONES
  // ============================================================================

  openTerms() {
    this.showTerms = true;
  }

  async onTermsAccepted() {
    const ok = await this.auth.markTermsAcceptedRemote();

    if (!ok) {
      alert('No se pudieron guardar los términos. Intenta de nuevo.');
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

  // ============================================================================
  // FACEBOOK
  // ============================================================================
  authFacebook() {
    alert('Aún no está implementado 😅');
  }
}

// ======================================================
// 🌐 CALLBACK TURNSTILE
// ======================================================
declare global {
  interface Window {
    onCaptchaVerified: (token: string) => void;
  }
}

window.onCaptchaVerified = async (token: string) => {
  console.log('Turnstile token:', token);
  try {
    const res = await fetch(`${environment.API_BASE}/captcha/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });

    const data = await res.json();
    if (!data.ok) {
      alert('Verifica que no eres un robot.');
    }
  } catch (err) {
    console.error('Turnstile error:', err);
  }
};
