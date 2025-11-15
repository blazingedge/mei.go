import { Injectable } from '@angular/core';
import { BehaviorSubject, combineLatest, map } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { SessionService } from './session.service';

@Injectable({ providedIn: 'root' })
export class TermsCoordinatorService {
  private manualVisible$ = new BehaviorSubject(false);
  private pendingResolver: ((accepted: boolean) => void) | null = null;
  private confirming = false;

  readonly showModal$ = combineLatest([
    this.auth.needsTerms$,
    this.manualVisible$,
  ]).pipe(map(([needs, manual]) => needs || manual));

  constructor(private auth: AuthService, private session: SessionService) {}

  openManual(): void {
    this.manualVisible$.next(true);
  }

  openManualForResult(): Promise<boolean> {
    this.openManual();
    return new Promise(resolve => {
      this.pendingResolver = resolve;
    });
  }

  closeManual(): void {
    this.manualVisible$.next(false);
    if (this.pendingResolver) {
      this.pendingResolver(false);
      this.pendingResolver = null;
    }
  }

  async confirmFromModal(): Promise<boolean> {
    if (this.confirming) return false;
    this.confirming = true;
    try {
      const ok = await this.auth.markTermsAcceptedRemote();
      if (!ok) {
        return false;
      }
      this.manualVisible$.next(false);
      if (this.pendingResolver) {
        this.pendingResolver(true);
        this.pendingResolver = null;
      }
      await this.session.validate(true);
      return true;
    } finally {
      this.confirming = false;
    }
  }
}
