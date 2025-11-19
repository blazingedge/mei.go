import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class TermsCoordinatorService {

  // Estado del modal (visible / no visible)
  private visibleSubject = new BehaviorSubject<boolean>(false);
  visible$ = this.visibleSubject.asObservable();

  // Resolver de la promesa actual
  private resolver: ((value: boolean) => void) | null = null;

  constructor() {}

  // ======================================================
  // 🌟 ABRIR MODAL Y ESPERAR RESULTADO
  // ======================================================
  openForResult(): Promise<boolean> {
    console.log('%c[TermsCoordinator] openForResult()', 'color:#6ff');

    // SIEMPRE crear una nueva promesa (clave para evitar bugs)
    return new Promise<boolean>((resolve) => {
      console.log('→ Mostrando modal');

      // Guardamos el resolve para usarlo después con accept() / cancel()
      this.resolver = resolve;

      // Mostramos el modal
      this.visibleSubject.next(true);
    });
  }

  // ======================================================
  // 🌟 MÉTODOS DE RESOLUCIÓN
  // ======================================================

  accept() {
    console.log('%c[TermsCoordinator] ACCEPT', 'color:#9f6');
    this.resolve(true);
  }

  cancel() {
    console.log('%c[TermsCoordinator] CANCEL', 'color:#f96');
    this.resolve(false);
  }

  close() {
    console.log('%c[TermsCoordinator] CLOSE', 'color:#f66');
    this.resolve(false);
  }

  // ======================================================
  // 🌟 Resolver promesa y limpiar estados
  // ======================================================
  private resolve(result: boolean) {
    console.group('%c[TermsCoordinator] resolve()', 'color:#96f');

    // Ocultamos el modal
    this.visibleSubject.next(false);

    if (this.resolver) {
      console.log('→ Resolviendo promesa pendiente');

      const cb = this.resolver;

      // Limpiar para evitar reusos accidentales
      this.resolver = null;

      // Disparamos la promesa
      cb(result);

    } else {
      console.warn('⚠ resolve() llamado sin promesa activa');
    }

    console.groupEnd();
  }

  // ======================================================
  // 🌟 Compatibilidad si lo llamas con otros nombres
  // ======================================================
  openManualForResult(): Promise<boolean> {
    return this.openForResult();
  }
}
