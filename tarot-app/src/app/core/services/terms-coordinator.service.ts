import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class TermsCoordinatorService {

  private visibleSubject = new BehaviorSubject<boolean>(false);
  visible$ = this.visibleSubject.asObservable();

  private resolver: ((value: boolean) => void) | null = null;
  private promise: Promise<boolean> | null = null;

  constructor() {}

  // ======================================================
  // 🌟 ABRIR MODAL Y ESPERAR RESULTADO
  // ======================================================
  openForResult(): Promise<boolean> {
    console.group('%c[TermsCoordinator] openForResult()', 'color:#f7d774');

    // Si ya hay un flujo activo → devuélvelo
    if (this.promise) {
      console.log('→ Reutilizando promesa existente');
      console.groupEnd();
      return this.promise;
    }

    // Crear nueva promesa de espera
    this.promise = new Promise<boolean>(resolve => {
      this.resolver = (result: boolean) => {
        console.log('→ Resolviendo con:', result);

        this.resolver = null;
        this.promise = null;

        resolve(result);
      };
    });

    console.log('→ Mostrando modal');
    this.visibleSubject.next(true);

    console.groupEnd();
    return this.promise;
  }

  // ======================================================
  // 🌟 MÉTODOS DE RESOLUCIÓN
  // ======================================================
  accept() {
    console.log('[TermsCoordinator] ACCEPT');
    this.resolve(true);
  }

  cancel() {
    console.log('[TermsCoordinator] CANCEL');
    this.resolve(false);
  }

  close() {
    console.log('[TermsCoordinator] CLOSE');
    this.resolve(false);
  }

  private resolve(result: boolean) {
    console.group('%c[TermsCoordinator] resolve()', 'color:#96f');

    // Ocultar modal inmediatamente
    this.visibleSubject.next(false);

    if (this.resolver) {
      console.log('→ Resolviendo promesa pendiente');
      const cb = this.resolver;
      this.resolver = null;
      this.promise = null;
      cb(result);
    } else {
      console.warn('⚠ resolve() llamado sin promesa');
      this.promise = null;
    }

    console.groupEnd();
  }

  // ======================================================
  // 🌟 Compatibilidad (por si lo usas en otros contextos)
  // ======================================================
  openManualForResult(): Promise<boolean> {
    return this.openForResult();
  }
}
