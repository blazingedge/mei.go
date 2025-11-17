import { Component, AfterViewInit, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from './logo.component';
import { AuthService, GoogleLoginResult } from './auth/auth.service';
import { IntroParticlesComponent } from './intro-particles/intro-partilces.component';
import { environment } from '../../environments/environment';
import { Subject, takeUntil } from 'rxjs';
import { SessionService } from './services/session.service';
import { TermsCoordinatorService } from './services/terms-coordinator.service';

@Component({
  standalone: true,
  selector: 'app-auth-unified',
  imports: [
    CommonModule,
    FormsModule,
    LogoComponent,
    IntroParticlesComponent
  ],
  templateUrl: './auth-unified.component.html',
  styleUrls: ['./auth-unified.component.scss']
})
export class AuthUnifiedComponent implements AfterViewInit, OnInit, OnDestroy {

  // ----------------------------------------------------
  // Estado
  // ----------------------------------------------------
  showIntro = true;
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
    private sessionService: SessionService,
    private termsCoordinator: TermsCoordinatorService
  ) {}

  // ============================================================================
  // 🎬 INTRO
  // ============================================================================
  ngAfterViewInit() {
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

  // ============================================================================
  // ⭐ ngOnInit — SOLO reacciona si authFlowStarted = true
  // ============================================================================
  ngOnInit() {
    this.resumeGoogleRedirect();
    this.auth.termsAccepted$
      .pipe(takeUntil(this.destroy$))
      .subscribe((accepted) => {
        if (accepted) {
          this.acceptedTerms = true;
          if (this.auth.authFlowStarted) {
            this.finishAuthFlow();
          }
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
      const accepted = await this.termsCoordinator.openManualForResult();
      if (!accepted) {
        this.auth.authFlowStarted = false;
      }
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
    this.loginError = '';

    try {
      const user: GoogleLoginResult = await this.auth.loginWithGoogle();
      if (user === 'redirect') {
        this.loginError = 'Redirigiendo a Google...';
        return;
      }
      if (!user) {
        this.auth.authFlowStarted = false;
        return;
      }

      await this.afterAuth();
    } catch (err: any) {
      this.loginError = this.describeFirebaseError(err);
      this.auth.authFlowStarted = false;
    } finally {
      this.loading = false;
      if (!this.auth.currentUser) {
        this.auth.authFlowStarted = false;
      }
    }
  }

  private async resumeGoogleRedirect() {
    this.loading = true;
    const user = await this.auth.completeGoogleRedirect();
    if (user) {
      this.auth.authFlowStarted = true;
      await this.afterAuth();
    }
    this.loading = false;
  }

  private describeFirebaseError(err: any): string {
    const code: string = err?.code || err?.message || '';
    if (code.includes('popup-blocked') || code.includes('popup-closed')) {
      return 'El navegador bloqueó la ventana de Google. Activa las ventanas emergentes o inténtalo desde un modo sin bloqueadores.';
    }

    if (code.includes('unauthorized-domain')) {
      return 'Google rechazó el dominio actual. Ve a Firebase > Authentication > Domains y añade "mei-go.pages.dev".';
    }

    if (code.includes('cross-origin')) {
      return 'Otra cabecera (COOP/COEP) está bloqueando la comunicación con Google. Quita esas cabeceras o usa autenticación por redirección.';
    }

    return err?.message || 'No se pudo iniciar sesión con Google.';
  }

  // ============================================================================
  // ?? Terminos y Condiciones
  // ============================================================================
  async openTerms() {
    const accepted = await this.termsCoordinator.openManualForResult();
    if (accepted) {
      this.acceptedTerms = true;
    }
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
