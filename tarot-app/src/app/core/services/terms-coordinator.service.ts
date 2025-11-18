import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class TermsCoordinatorService {

  private _visible = new BehaviorSubject<boolean>(false);
  visible$ = this._visible.asObservable();

  private resolver: ((value: boolean) => void) | null = null;

  constructor() {}

  /** Abre el modal y devuelve promesa */
  openManualForResult(): Promise<boolean> {
    this._visible.next(true);

    return new Promise(resolve => {
      this.resolver = resolve;
    });
  }

  resolveAccept() {
    if (this.resolver) this.resolver(true);
    this.resolver = null;
    this._visible.next(false);
  }

  resolveCancel() {
    if (this.resolver) this.resolver(false);
    this.resolver = null;
    this._visible.next(false);
  }

  close() {
    this._visible.next(false);
  }
}
