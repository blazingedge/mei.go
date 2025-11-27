import { AuthService } from '../core/auth/auth.service';
import { SessionService } from '../core/services/session.service';
import { Component, ElementRef, EventEmitter, inject, OnDestroy, OnInit, Output, ViewChild } from '@angular/core';
import { environment } from '../../environments/environment';

declare global {
  interface Window {
    paypal?: any;
  }
}

@Component({
  selector: 'app-paypal-donation',
  standalone: true,
  templateUrl: './paypal-donation.component.html',
  styleUrls: ['./paypal-donation.component.scss'],
})
export class PaypalDonationComponent implements OnInit, OnDestroy {
  @Output() close = new EventEmitter<void>();
  @ViewChild('paypalButtons', { static: true })
  paypalButtonsRef!: ElementRef<HTMLDivElement>;

  private authService = inject(AuthService);
  private sessionService = inject(SessionService);

  loading = false;
  error: string | null = null;

  ngOnInit() {
    console.groupCollapsed('%c[PayPalCmp] ngOnInit', 'color:#0ff');
    console.log('[PayPalCmp] Iniciando componente PayPalDonationComponent');
    console.log('[PayPalCmp] API_BASE:', environment.API_BASE);
    console.log('[PayPalCmp] window.paypal presente al iniciar?', !!window.paypal);
    console.groupEnd();

    this.loadPaypalSdk();
  }

  ngOnDestroy() {
    console.log('[PayPalCmp] ngOnDestroy → componente destruido, botones se limpian solos');
  }

  onCloseClick() {
    console.log('[PayPalCmp] onCloseClick → emitiendo close');
    this.close.emit();
  }

  // ============================
  //   SDK DE PAYPAL
  // ============================
 // paypal-donation.component.ts

private loadPaypalSdk() {
  console.log('[PayPalCmp] loadPaypalSdk()');
  console.log('[PayPalCmp] CLIENT_ID desde env:', environment.PAY_PAL_CLIENT_ID);

  if (window.paypal) {
    console.log('[PayPalCmp] window.paypal ya existe, renderButtons()');
    this.renderButtons();
    return;
  }

  this.loading = true;

  const script = document.createElement('script');

  const src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(
    environment.PAY_PAL_CLIENT_ID
  )}&currency=EUR&components=buttons`;

  console.log('[PayPalCmp] src SDK:', src);

  script.src = src;
  script.async = true;

  script.onload = () => {
    console.log('[PayPalCmp] script.onload → SDK cargado');
    this.loading = false;
    this.renderButtons();
  };

  script.onerror = (err) => {
    console.error('[PayPalCmp] script.onerror → fallo al cargar PayPal', err);
    this.loading = false;
    this.error = 'No se pudo cargar PayPal. Intenta más tarde.';
  };

  document.body.appendChild(script);
}



  // ============================
  //   BOTONES PAYPAL
  // ============================
  private renderButtons() {
    console.groupCollapsed('%c[PayPalCmp] renderButtons', 'color:#fc0');
    console.log('[PayPalCmp] Intentando renderizar botones...');
    console.log('[PayPalCmp] window.paypal?', !!window.paypal);
    console.log('[PayPalCmp] paypalButtonsRef?', !!this.paypalButtonsRef);
    console.log('[PayPalCmp] paypalButtonsRef.nativeElement?', this.paypalButtonsRef?.nativeElement);

    if (!window.paypal || !this.paypalButtonsRef || !this.paypalButtonsRef.nativeElement) {
      this.error = 'PayPal no está disponible en este momento.';
      console.error('[PayPalCmp] No hay window.paypal o no existe paypalButtonsRef/nativeElement');
      console.groupEnd();
      return;
    }

    try {
      window.paypal
        .Buttons({
          style: {
            layout: 'horizontal',
            color: 'gold',
            shape: 'pill',
            label: 'pay',
          },

          // 1) Tu front pide al Worker que cree la orden
          createOrder: async () => {
            console.groupCollapsed('%c[PayPalCmp] createOrder', 'color:#0f9');
            try {
              console.log('[PayPalCmp] createOrder → obteniendo token de usuario...');
              const token = await this.authService.getIdToken();
              console.log('[PayPalCmp] Token obtenido?', !!token);

              if (!token) {
                this.error = 'Debes iniciar sesión para comprar DruCoins.';
                console.warn('[PayPalCmp] createOrder → sin token / usuario no logueado');
                throw new Error('no_auth');
              }

              const url = `${environment.API_BASE}/paypal/create-order`;
              console.log('[PayPalCmp] createOrder → llamando a', url);

              const res = await fetch(url, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              });

              console.log('[PayPalCmp] createOrder → status', res.status);
              const data = await res.json().catch((e) => {
                console.error('[PayPalCmp] createOrder → error parseando JSON', e);
                throw e;
              });
              console.log('[PayPalCmp] createOrder → response JSON:', data);

              if (!res.ok || !data.ok || !data.orderID) {
                console.error('[PayPalCmp] create-order error:', data);
                this.error = 'No se pudo iniciar el pago.';
                throw new Error('create_order_failed');
              }

              console.log('[PayPalCmp] createOrder → orderID devuelto:', data.orderID);
              console.groupEnd();
              return data.orderID;
            } catch (err) {
              console.error('[PayPalCmp] createOrder error', err);
              console.groupEnd();
              throw err;
            }
          },

          // 2) PayPal aprueba → tu front pide al Worker que capture
          onApprove: async (data: any) => {
            console.groupCollapsed('%c[PayPalCmp] onApprove', 'color:#6f6');
            console.log('[PayPalCmp] onApprove data:', data);
            try {
              const token = await this.authService.getIdToken();
              console.log('[PayPalCmp] onApprove → token?', !!token);

              if (!token) {
                this.error = 'Sesión caducada. Inicia sesión de nuevo.';
                console.warn('[PayPalCmp] onApprove → sin token');
                console.groupEnd();
                return;
              }

              const url = `${environment.API_BASE}/paypal/capture-order`;
              console.log('[PayPalCmp] onApprove → llamando a', url, 'con orderID', data.orderID);

              const res = await fetch(url, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ orderID: data.orderID }),
              });

              console.log('[PayPalCmp] capture-order → status', res.status);
              const json = await res.json().catch((e) => {
                console.error('[PayPalCmp] capture-order → error parseando JSON', e);
                throw e;
              });

              console.log('[PayPalCmp] capture-order response:', json);

              if (!res.ok || !json.ok) {
                this.error = 'No se pudo completar el pago.';
                console.warn('[PayPalCmp] capture-order → respuesta no OK');
                console.groupEnd();
                return;
              }

              const newBalance = Number(json.drucoins ?? json.balance ?? 0);
              console.log('[PayPalCmp] Nuevo saldo de DruCoins:', newBalance);

              // Avisamos al front del nuevo saldo
              this.authService.updateDrucoinBalance(newBalance);
              this.sessionService.setDrucoins(newBalance);

              console.log('[PayPalCmp] Balance actualizado, cerrando modal...');
              this.close.emit();
              console.groupEnd();
            } catch (err) {
              console.error('[PayPalCmp] onApprove error', err);
              this.error = 'Ocurrió un error al procesar el pago.';
              console.groupEnd();
            }
          },

          onError: (err: any) => {
            console.error('%c[PayPalCmp] Buttons onError', 'color:#f55', err);
            this.error = 'PayPal ha devuelto un error. Intenta más tarde.';
          },
        })
        .render(this.paypalButtonsRef.nativeElement);

      console.log('[PayPalCmp] window.paypal.Buttons().render() llamado correctamente');
    } catch (e) {
      console.error('[PayPalCmp] Error al inicializar paypal.Buttons:', e);
      this.error = 'No se pudieron inicializar los botones de PayPal.';
    }

    console.groupEnd();
  }
}
