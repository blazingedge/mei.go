import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from '@angular/fire/auth';

export const AuthGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const auth = inject(Auth);

  return new Promise<boolean>((resolve) => {
    const unsub = auth.onAuthStateChanged((user) => {
      unsub();
      if (user) {
        resolve(true); // ✅ acceso permitido
      } else {
        router.navigate(['/login']); // 🚫 redirige al login
        resolve(false);
      }
    });
  });
};
