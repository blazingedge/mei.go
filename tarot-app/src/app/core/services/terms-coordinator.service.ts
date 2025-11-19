import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class TermsCoordinatorService {

  private _visible = new BehaviorSubject<boolean>(false);
  visible$ = this._visible.asObservable();

  private resolver: ((value: boolean) => void) | null = null;
  private pendingPromise: Promise<boolean> | null = null;

  constructor() {}

  openForResult(): Promise<boolean> {
    if (this.pendingPromise) {
      return this.pendingPromise;
    }

    this._visible.next(true);

    this.pendingPromise = new Promise(resolve => {
      this.resolver = (value: boolean) => {
        this.pendingPromise = null;
        resolve(value);
      };
    });

    return this.pendingPromise;
  }

  /** Compatibilidad con botones manuales */
  openManualForResult(): Promise<boolean> {
    return this.openForResult();
  }

  resolveAccept() {
    this.resolve(true);
  }

  resolveCancel() {
    this.resolve(false);
  }

  close() {
    this.resolve(false);
  }

  private resolve(result: boolean) {
    if (this.resolver) {
      const cb = this.resolver;
      this.resolver = null;
      cb(result);
    } else {
      this.pendingPromise = null;
    }
    this._visible.next(false);
  }
}
