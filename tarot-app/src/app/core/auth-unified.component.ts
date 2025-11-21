import { Component, AfterViewInit, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from './logo.component';
import { AuthService, GoogleLoginResult } from './auth/auth.service';
import { IntroParticlesComponent } from './intro-particles/intro-partilces.component';
import { environment } from '../../environments/environment';
import { async, Subject, takeUntil } from 'rxjs';
import { SessionService } from './services/session.service';
import { TermsCoordinatorService } from './services/terms-coordinator.service';
import { TermsModalComponent } from '../components/terms-modal.component';
import { ForgotPasswordModalComponent } from '../components/forgot-password-modal.component';


declare global {
  interface Window {
    turnstile?: any;
  }
}

@Component({
  standalone: true,
  selector: 'app-auth-unified',
  imports: [
    CommonModule,
    FormsModule,
    LogoComponent,
    IntroParticlesComponent,
    TermsModalComponent,
    ForgotPasswordModalComponent
  ],
  templateUrl: './auth-unified.component.html',
  styleUrls: [
    './auth-unified.component.scss',
    '../components/forgot-password.component.scss'
  ]
})

export class AuthUnifiedComponent implements AfterViewInit, OnInit, OnDestroy {

  showIntro = true;
  acceptedTerms = false;
  forgotEmail = false;
  showForgotModal = false;

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
) {

  // 🔮 Callback global de Turnstile → Angular lo recibe aquí
 

}
  turnstileToken: string = '';


  

  ngAfterViewInit() {
    const intro = document.querySelector('.intro-overlay') as HTMLElement | null;

    if (intro) {
      intro.addEventListener('animationend', () => {
        intro.style.display = 'none';
        intro.style.pointerEvents = 'none';
        this.showIntro = false;
      });

      this.initTurnstile();
    }

    setTimeout(() => {
      const el = document.querySelector('.intro-overlay') as HTMLElement | null;
      if (el) {
        el.style.display = 'none';
        el.style.pointerEvents = 'none';
      }
      this.showIntro = false;
    }, 7500);

     (window as any).onCaptchaVerified = (token: string) => {
    console.log("Captcha token recibido:", token);
    this.turnstileToken = token;
     };
  }
 
  async onForgotPassword() {
  const email = this.login.email.trim();

  if (!email) {
    alert('Por favor ingresa tu email en el campo de inicio de sesión.');
    return;
  }

  const ok = await this.auth.resetPassword(email);

  if (ok) {
    alert('Te hemos enviado un correo para restablecer tu contraseña.');
  } else {
    alert('No se pudo enviar el correo de recuperación.');
  }
}




  private initTurnstile() {
  const render = () => {
    if (window.turnstile && document.getElementById('cf-turnstile')) {
      window.turnstile.render("#cf-turnstile", {
        sitekey: "0x4AAAAAACAX4mmeQUvYpIQr",
        theme: "auto",
        callback: (token: string) => {
          console.log("Token recibido:", token);
          this.turnstileToken = token;
        }
      });
      return true;
    }
    return false;
  };

 


  if (!render()) {
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (render() || tries > 10) {
        clearInterval(timer);
      }
    }, 300);
  }
}

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

  private async afterAuth() {
    try {
      const status = await this.sessionService.validate(true);

      if (status === 'invalid') {
        this.auth.authFlowStarted = false;
        this.loginError = 'No pudimos validar tu sesión. Intenta nuevamente.';
        return;
      }

      if (status === 'needs-terms') {
        const accepted = await this.sessionService.ensureTermsAcceptance();
        if (!accepted) {
          this.loginError = 'Debes aceptar los Términos y Condiciones.';
          this.auth.authFlowStarted = false;
          return;
        }
      }

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

  async onRegister() {
    if (!this.acceptedTerms) {
      alert('Debes aceptar los Términos y Condiciones antes de registrarte.');
      return;
    }

    this.regError = '';

    const turnstileToken = this.turnstileToken;

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
      this.regError = e?.error ?? e?.message ?? 'Error al registrar';

    } finally {
      this.loading = false;
    }
  }

  async authGoogle() {
    this.auth.authFlowStarted = true;
    this.loading = true;
    this.loginError = '';

    try {
      const user: GoogleLoginResult = await this.auth.loginWithGoogle();

      if (user === 'redirect') {
        this.loginError =
          'Tu navegador bloqueó la ventana de Google. Permite las ventanas emergentes para este sitio.';
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
      return 'El navegador bloqueó la ventana de Google. Activa las ventanas emergentes.';
    }

    if (code.includes('unauthorized-domain')) {
      return 'Google rechazó el dominio actual. Añade "mei-go.pages.dev" en Firebase > Authentication > Domains.';
    }

    if (code.includes('cross-origin')) {
      return 'Una cabecera COOP/COEP bloquea la autenticación. Usa redirect o elimina esas cabeceras.';
    }

    return err?.message || 'No se pudo iniciar sesión con Google.';
  }

  async openTerms() {
    const accepted = await this.termsCoordinator.openForResult();
    if (accepted) {
      this.acceptedTerms = true;
    }
  }

  authFacebook() {
    alert('Aún no está implementado 😅');
  }

  openForgotPassword() {
  this.showForgotModal = true;
}
  closeForgotPassword() {
  this.showForgotModal = false;

  }
}


