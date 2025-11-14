// src/app/app.routes.ts
import { Routes } from '@angular/router';
import { AuthGuard } from '../services/auth.guard';

export const routes: Routes = [
  {
    path: 'login',
    loadComponent: () =>
      import('./core/auth-unified.component').then(m => m.AuthUnifiedComponent),
  },
  {
    path: 'spreads',
    canActivate: [AuthGuard],
    loadComponent: () =>
      import('./spreads.component').then(m => m.SpreadsComponent),
  },
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: '**', redirectTo: 'login' },
];
