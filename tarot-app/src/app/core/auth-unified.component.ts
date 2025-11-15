import { Component, AfterViewInit, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from './logo.component';
import { AuthService } from './auth/auth.service';
import { IntroParticlesComponent } from './intro-particles/intro-partilces.component';
import { environment } from '../../environments/environment';
import { TermsModalComponent } from '../components/terms-modal.component';
import { Subject, takeUntil } from 'rxjs';
import { SessionService } from './services/session.service';

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
export class AuthUnifiedComponent implements AfterViewInit, OnInit, OnDestroy {

  // ----------------------------------------------------
  // Estado
  // ----------------------------------------------------
  showIntro = true;
  showTerms = false;
  acceptedTerms = false;

  loading = false;
  loginError = '';
  regError = '';

  login = { email: '', password: '' };
  register = { email: '', password: '', confirm: '' };
  private destroy$ = new Subject<void>();

  constructor(
    private auth: AuthService,
    private router: Router,
    private sessionService: SessionService
  ) {}

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
    }, 7500);
  }

  async playIntro() {
    const audio = new Audio('assets/audio/el-meigo.mp3');
    audio.volume = 0.55;
    try {
      await audio.play();
    } catch {
      console.warn('Autoplay bloqueado');
    }
  }

  // ============================================================================
  // ⭐ ngOnInit — SOLO reacciona si authFlowStarted = true
  // ============================================================================
  ngOnInit() {
    this.auth.termsAccepted$
      .pipe(takeUntil(this.destroy$))
      .subscribe((accepted) => {
        if (!this.auth.authFlowStarted) {
          this.showTerms = false;
          return;
        }

        if (accepted) {
          this.showTerms = false;
          this.finishAuthFlow();
        } else {
          this.showTerms = true;
        }
      });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }




  // ============================================================================
  // 🔐 LOGIN CLÁSICO
  // ============================================================================
  async onLogin() {
    this.auth.authFlowStarted = true;
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
      if (!this.auth.currentUser) {
        this.auth.authFlowStarted = false;
      }
    }
  }

  // ============================================================================
  // 🌟 FUNCIÓN CENTRAL — MANEJA FLUJO TRAS LOGIN
  // ============================================================================
  private async afterAuth() {
    const status = await this.sessionService.validate(true);
    const needsTerms = status === 'needs-terms' || (await this.auth.syncTermsStatus());

    if (!needsTerms && status === 'valid') {
      this.finishAuthFlow();
      return;
    }

    if (needsTerms) {
      this.auth.authFlowStarted = true;
      this.showTerms = true;
      return;
    }

    this.auth.authFlowStarted = false;
  }

  private finishAuthFlow() {
    this.auth.authFlowStarted = false;
    if (this.router.url !== '/spreads') {
      this.router.navigate(['/spreads']);
    }
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
    this.auth.authFlowStarted = true;
    this.loading = true;

    try {
      const user = await this.auth.loginWithGoogle();
      if (!user) {
        this.auth.authFlowStarted = false;
        return;
      }

      await this.afterAuth();
    } finally {
      this.loading = false;
      if (!this.auth.currentUser) {
        this.auth.authFlowStarted = false;
      }
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
    await this.sessionService.validate(true);
    this.finishAuthFlow();
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
