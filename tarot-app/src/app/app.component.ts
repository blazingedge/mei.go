import { Component, OnInit, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { CommonModule } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { SessionService } from './core/services/session.service';
import { TermsModalComponent } from './components/terms-modal.component';
import { TermsCoordinatorService } from './core/services/terms-coordinator.service';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [
    CommonModule,   // 👈 NECESARIO PARA *ngIf
    RouterOutlet,
    TermsModalComponent
  ],
  template: `
    <router-outlet></router-outlet>
    <app-terms-modal *ngIf="termsVisible"></app-terms-modal>
  `
})
export class AppComponent implements OnInit {
  private destroyRef = inject(DestroyRef);
  termsVisible = false;

  constructor(
    private session: SessionService,
    public termsCoordinator: TermsCoordinatorService
  ) {}

  ngOnInit(): void {
    this.session.bootstrap();

    this.termsCoordinator.visible$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((visible) => {
        this.termsVisible = visible;
      });
  }
}
