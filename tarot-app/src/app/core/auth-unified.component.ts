import { Component, AfterViewInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from "./logo.component";
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
export class AuthUnifiedComponent implements AfterViewInit {
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
  // 🎬 INTRO CONTROL (sin bloqueo del blur)
  // ======================================================
  ngAfterViewInit() {
  this.playIntro();

  const intro = document.querySelector('.intro-overlay') as HTMLElement | null;

if (intro) {
  intro.addEventListener('animationend', () => {
    intro.style.display = 'none'; // 💥 desaparece físicamente
    intro.style.pointerEvents = 'none';
    this.showIntro = false;
  });
}

// seguridad adicional por si algo falla
setTimeout(() => {
  const el = document.querySelector('.intro-overlay') as HTMLElement | null;
  if (el) {
    el.style.display = 'none';
    el.style.pointerEvents = 'none';
  }
  this.showIntro = false;
}, 6000);


  // Seguridad extra por si el evento no dispara

}


  async playIntro() {
    const audio = new Audio('assets/audio/el-meigo.mp3');
    audio.volume = 0.55;
    try {
      await audio.play();
    } catch {
      console.warn('🔇 Autoplay bloqueado, esperando interacción del usuario');
    }
  }

  // ======================================================
  // 🔐 LOGIN
  // ======================================================
  async onLogin() {
    this.loginError = '';
    if (!this.login.email || !this.login.password) {
      this.loginError = 'Completa todos los campos';
      return;
    }

    if (!this.acceptedTerms) {
      alert('Debes aceptar los términos antes de continuar.');
      return;
    }

    this.loading = true;
    try {
      const ok = await this.auth.login(this.login.email, this.login.password);
      if (!ok) throw new Error('Credenciales inválidas');
      await this.router.navigate(['/spreads']);
    } catch (e: any) {
      this.loginError = e.message || 'Error al iniciar sesión';
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
    this.showTerms = false;
    this.acceptedTerms = true;
    try {
      const user = this.auth.currentUser;
      const uid = user?.uid ?? 'guest';
      const token = user ? await user.getIdToken() : '';
      await fetch(`${environment.API_BASE}/api/terms/accept`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : ''
        },
        body: JSON.stringify({ acceptedAt: Date.now() })
      });
      console.log('✅ Términos aceptados y registrados');
    } catch (err) {
      console.warn('⚠️ No se pudo registrar la aceptación:', err);
    }
  }

  
onTermsClosed() {
  this.showTerms = false;
}

  // ======================================================
  // 🧾 REGISTRO
  // ======================================================
  async onRegister() {
    if (!this.acceptedTerms) {
      alert('Debes aceptar los Términos y Condiciones antes de registrarte.');
      return;
    }

    this.regError = '';
    const tokenEl = document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null;
    const turnstileToken = tokenEl?.value || '';

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
      if (!vr.ok) throw new Error('Captcha inválido.');

      const ok = await this.auth.register(this.register.email, this.register.password);
      if (!ok) throw new Error('No se pudo registrar');
      alert('✅ Registro completado. Ahora puedes iniciar sesión.');
    } catch (e: any) {
      this.regError = e.message || 'Error al registrar';
    } finally {
      this.loading = false;
    }
  }

  // ======================================================
  // 🔑 LOGIN CON GOOGLE
  // ======================================================
  async authGoogle() {
    if (!this.acceptedTerms) {
      alert('Debes aceptar los Términos y Condiciones antes de continuar.');
      return;
    }

    this.loading = true;
    try {
      const user = await this.auth.loginWithGoogle();
      console.log('✅ Login con Google:', user);
      await this.router.navigate(['/spreads']);
    } catch (e) {
      console.error('❌ Error Google Auth:', e);
      this.loginError = 'Error al iniciar con Google';
    } finally {
      this.loading = false;
    }
  }

  // ======================================================
  // ⚙️ OTROS
  // ======================================================
  authFacebook() {
    alert('Aún no está implementado el login con Facebook 😅');
  }
}

declare global {
  interface Window {
    onCaptchaVerified: (token: string) => void;
  }
}

window.onCaptchaVerified = async (token: string) => {
  console.log('✅ Turnstile token recibido:', token);
  try {
    const res = await fetch(`${environment.API_BASE}/captcha/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    const data = await res.json();
    if (data.ok) {
      console.log('✅ Verificación CAPTCHA exitosa');
    } else {
      console.warn('❌ Falló la verificación CAPTCHA');
      alert('Verifica que no eres un robot e inténtalo de nuevo.');
    }
  } catch (err) {
    console.error('💥 Error verificando Turnstile:', err);
  }
};
