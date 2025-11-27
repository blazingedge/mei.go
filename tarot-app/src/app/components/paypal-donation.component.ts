
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
    this.loadPaypalSdk();
  }

  ngOnDestroy() {
    // aquí no hace falta limpiar nada especial;
    // los botones se destruyen con el componente
  }

  onCloseClick() {
    this.close.emit();
  }

  // ============================
  //   SDK DE PAYPAL
  // ============================
  private loadPaypalSdk() {
    if (window.paypal) {
      this.renderButtons();
      return;
    }

    this.loading = true;
    const script = document.createElement('script');
    script.src = `https://www.paypal.com/sdk/js?client-id=${environment.PAY_PAL_CLIENT_ID}&currency=EUR`;
    script.async = true;

    script.onload = () => {
      this.loading = false;
      this.renderButtons();
    };

    script.onerror = () => {
      this.loading = false;
      this.error = 'No se pudo cargar PayPal. Intenta más tarde.';
    };

    document.body.appendChild(script);
  }

  // ============================
  //   BOTONES PAYPAL
  // ============================
  private renderButtons() {
    if (!window.paypal || !this.paypalButtonsRef) {
      this.error = 'PayPal no está disponible en este momento.';
      return;
    }

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
          try {
            const token = await this.authService.getIdToken();
            if (!token) {
              this.error = 'Debes iniciar sesión para comprar DruCoins.';
              throw new Error('no_auth');
            }

            const res = await fetch(`${environment.API_BASE}/paypal/create-order`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${token}`,
              },
            });

            const data = await res.json();
            if (!res.ok || !data.ok || !data.orderID) {
              console.error('create-order error:', data);
              this.error = 'No se pudo iniciar el pago.';
              throw new Error('create_order_failed');
            }

            return data.orderID;
          } catch (err) {
            console.error('[PayPal] createOrder error', err);
            throw err;
          }
        },

        // 2) PayPal aprueba → tu front pide al Worker que capture
        onApprove: async (data: any) => {
          try {
            const token = await this.authService.getIdToken();
            if (!token) {
              this.error = 'Sesión caducada. Inicia sesión de nuevo.';
              return;
            }

            const res = await fetch(`${environment.API_BASE}/paypal/capture-order`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({ orderID: data.orderID }),
            });

            const json = await res.json();
            console.log('capture-order response:', json);

            if (!res.ok || !json.ok) {
              this.error = 'No se pudo completar el pago.';
              return;
            }

            const newBalance = Number(json.drucoins ?? json.balance ?? 0);

            // 👇 Aquí es donde avisas a TODO el front de que hay nuevo saldo
            this.authService.updateDrucoinBalance(newBalance);
            this.sessionService.setDrucoins(newBalance);

            // opcional: pequeño mensaje
            // alert(`Gracias por tu apoyo 🌀 Nuevo saldo: ${newBalance} DruCoins`);

            // Cerramos el modal
            this.close.emit();
          } catch (err) {
            console.error('[PayPal] onApprove error', err);
            this.error = 'Ocurrió un error al procesar el pago.';
          }
        },

        onError: (err: any) => {
          console.error('[PayPal] Buttons error', err);
          this.error = 'PayPal ha devuelto un error. Intenta más tarde.';
        },
      })
      .render(this.paypalButtonsRef.nativeElement);
  }
}
