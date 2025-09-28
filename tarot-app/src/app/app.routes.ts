import { Routes } from '@angular/router';
import { AuthUnifiedComponent } from './core/auth-unified.component';
import { provideHttpClient, withFetch } from '@angular/common/http';

export const routes: Routes = [
  // páginas específicas primero

    {
    path: 'spreads',
    providers: [provideHttpClient(withFetch())],
    loadComponent: () => import('./spreads.component').then(m => m.SpreadsComponent)
  },
  { path: 'auth',    loadComponent: () => import('./core/auth-unified.component').then(m => m.AuthUnifiedComponent) },

  // redirección por defecto (mientras pruebas, arrancar en spreads)
  { path: '', redirectTo: 'spreads', pathMatch: 'full' },

  // comodín siempre al final
  { path: '**', redirectTo: 'spreads' }
];