import { HttpInterceptorFn } from '@angular/common/http';
import { environment } from '../../environments/environment';

export const apiPrefixInterceptor: HttpInterceptorFn = (req, next) => {
  // Prefija solo rutas relativas que empiecen por /api
  if (req.url.startsWith('/api/')) {
    req = req.clone({ url: environment.API_BASE + req.url });
  }

  // (Opcional) añade token si existe
  const token = localStorage.getItem('token');
  if (token) {
    req = req.clone({ setHeaders: { Authorization: `Bearer ${token}` } });
  }

  return next(req);
};
