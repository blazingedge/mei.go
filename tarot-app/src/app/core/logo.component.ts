// src/app/core/logo.component.ts
import { Component } from '@angular/core';

@Component({
  selector: 'app-logo',
  standalone: true,
  template: `
    <div class="logo">
      <img src="assets/logo-meigo.png" alt="Logo Meigo.io" />
      <p></p>
    </div>
  `,
  styleUrls: ['./logo.component.scss']
})
export class LogoComponent {}
