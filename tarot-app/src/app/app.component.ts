import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],        // 👈 quita RouterLink
  template: `<router-outlet></router-outlet>`,
})
export class AppComponent {}
