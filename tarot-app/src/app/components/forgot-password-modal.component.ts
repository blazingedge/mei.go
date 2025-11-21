import { Component, EventEmitter, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth/auth.service';

@Component({
  selector: 'app-forgot-password-modal',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './forgot-password-modal.html',
  styleUrls: ['./forgot-password.component.scss']
})
export class ForgotPasswordModalComponent {
  email = '';

  @Output() closed = new EventEmitter<void>();

  constructor(private auth: AuthService) {}

  async submit() {
    if (!this.email.trim()) {
      alert('Por favor ingresa tu email.');
      return;
    }

    const ok = await this.auth.resetPassword(this.email.trim());

    if (ok) {
      alert('Te enviamos un enlace para restablecer tu contraseña.');
      this.close();
    } else {
      alert('No se pudo enviar el correo. Intenta nuevamente.');
    }
  }

  close() {
    this.closed.emit();
  }
}
