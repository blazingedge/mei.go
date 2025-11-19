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
  async ngOnInit() {
    this.resumeGoogleRedirect();
    this.auth.termsAccepted$
      .pipe(takeUntil(this.destroy$))
      .subscribe((accepted) => {
        this.acceptedTerms = accepted;
      });
  }

  private async resetPersistedSession() {
    try {
      await this.auth.logout();
      try {
        indexedDB.deleteDatabase('firebaseLocalStorageDb');
      } catch {}
    } catch (err) {
      console.warn('No se pudo limpiar la sesión previa:', err);
    }
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
    try {
      const status = await this.sessionService.validate(true);
      if (status === 'invalid') {
        this.auth.authFlowStarted = false;
        this.loginError = 'No pudimos validar tu sesión. Intenta nuevamente.';
        return;
      }

      const needsTerms =
        status === 'needs-terms' || (await this.auth.syncTermsStatus());

      if (!needsTerms) {
        this.finishAuthFlow();
        return;
      }

      const accepted = await this.termsCoordinator.openForResult();
      if (!accepted) {
        this.auth.authFlowStarted = false;
        return;
      }

      const registered = await this.auth.markTermsAcceptedRemote();
      if (!registered) {
        this.loginError =
          'No pudimos registrar tu aceptación de Términos. Intenta de nuevo.';
        this.auth.requireTermsAcceptance();
        this.auth.authFlowStarted = false;
        return;
      }

      await this.sessionService.validate(true);
      this.finishAuthFlow();
    } catch (err) {
      console.error('afterAuth error', err);
      this.loginError = 'Ocurrió un error al validar tu sesión.';
      this.auth.authFlowStarted = false;
    }
  }


  private finishAuthFlow() {
    this.auth.authFlowStarted = false;
    this.loginError = '';
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
        this.loginError =
          'Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio (icono de pop-ups junto a la barra de direcciones) o continúa en la pestaña nueva que se abrió.';
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
    try {
      const user = await this.auth.completeGoogleRedirect();
      if (user) {
        this.auth.authFlowStarted = true;
        await this.afterAuth();
      }
    } finally {
      this.loading = false;
      if (!this.auth.currentUser) {
        this.auth.authFlowStarted = false;
      }
    }
  }

  private describeFirebaseError(err: any): string {
    const code: string = err?.code || err?.message || '';
    if (code.includes('popup-blocked') || code.includes('popup-closed')) {
      return 'El navegador bloqueó la ventana de Google. Activa las ventanas emergentes para este sitio (Chrome/Firefox) o usa el modo redirect.';
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
    const accepted = await this.termsCoordinator.openForResult();
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
