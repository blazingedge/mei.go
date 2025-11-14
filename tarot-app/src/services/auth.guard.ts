import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SessionService } from '../app/core/services/session.service';

export const AuthGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const session = inject(SessionService);

  const status = await session.validate();
  if (status === 'valid') {
    return true;
  }

  router.navigate(['/login']);
  return false;
};

