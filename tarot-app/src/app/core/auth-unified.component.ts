import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LogoComponent } from "./logo.component";
import { AuthService } from './auth/auth.service';

@Component({
  standalone: true,
  selector: 'app-auth-unified',
  imports: [CommonModule, FormsModule, LogoComponent],
  templateUrl: './auth-unified.component.html',
  styleUrls: ['./auth-unified.component.scss']
})
export class AuthUnifiedComponent {
  loading = false;
  loginError = '';
  regError = '';

  login = { email: '', password: '' };
  register = { email: '', password: '', confirm: '' };

  constructor(private auth: AuthService, private router: Router) {}

  // --- LOGIN normal
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
      await this.router.navigate(['/spreads']);
    } catch (e: any) {
      this.loginError = e.message || 'Error al iniciar sesión';
    } finally {
      this.loading = false;
    }
  }

  // --- REGISTRO
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
      const ok = await this.auth.register(this.register.email, this.register.password);
      if (!ok) throw new Error('No se pudo registrar');
      alert('✅ Registro completado. Ahora puedes iniciar sesión.');
    } catch (e: any) {
      this.regError = e.message || 'Error al registrar';
    } finally {
      this.loading = false;
    }
  }

  // --- GOOGLE AUTH (Firebase)
  async authGoogle() {
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

  authFacebook() {
    alert('Aún no está implementado el login con Facebook 😅');
  }
}
