import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from '../app/core/services/session.service';
import { TermsCoordinatorService } from '../app/core/services/terms-coordinator.service';

export const AuthGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const session = inject(SessionService);
  const terms = inject(TermsCoordinatorService);

  const status = await session.validate();

  // Usuario válido → pasa normal
  if (status === 'ok') {
    return true;
  }

  // Falta aceptar términos → abrir modal y NO bloquear la ruta
  if (status === 'needs-terms') {
    terms.show();   // 🔥 activa el modal
    return true;     // 🔥 permite cargar la página actual
  }

  // Sesión inválida
  router.navigate(['/login']);
  return false;
};
