import { Component, OnInit, DestroyRef, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SessionService } from './core/services/session.service';
import { TermsModalComponent } from './components/terms-modal.component';
import { TermsCoordinatorService } from './core/services/terms-coordinator.service';

@Component({
  standalone: true,
  selector: 'app-root',
  imports: [RouterOutlet, TermsModalComponent],
  template: `
    <router-outlet></router-outlet>
    <app-terms-modal
      *ngIf="termsVisible"
      [visible]="termsVisible"
      (accepted)="onTermsAccepted()"
      (closed)="onTermsClosed()">
    </app-terms-modal>
  `,
})
export class AppComponent implements OnInit {
  private destroyRef = inject(DestroyRef);
  termsVisible = false;

  constructor(
    private session: SessionService,
    private termsCoordinator: TermsCoordinatorService
  ) {}

  ngOnInit(): void {
    this.session.bootstrap();
    this.termsCoordinator.showModal$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(visible => {
        this.termsVisible = visible;
      });
  }

  async onTermsAccepted() {
    const ok = await this.termsCoordinator.confirmFromModal();
    if (!ok) {
      alert('No se pudieron guardar los términos. Intenta de nuevo.');
    }
  }

  onTermsClosed() {
    this.termsCoordinator.closeManual();
  }
}
