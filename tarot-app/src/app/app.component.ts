import { Component, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionService } from './core/services/session.service';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `<router-outlet></router-outlet>`,
})
export class AppComponent implements OnInit {
  constructor(private session: SessionService) {}

  ngOnInit(): void {
    this.session.bootstrap();
  }
}
