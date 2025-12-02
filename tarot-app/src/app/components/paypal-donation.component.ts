import { AuthService } from '../core/auth/auth.service';
import { SessionService } from '../core/services/session.service';
import {
  Component,
  EventEmitter,
  inject,
  OnDestroy,
  OnInit,
  Output,
} from '@angular/core';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-paypal-donation', // dejamos el mismo selector para no romper nada
  standalone: true,
  templateUrl: './paypal-donation.component.html',
  styleUrls: ['./paypal-donation.component.scss'],
})
export class PaypalDonationComponent implements OnInit, OnDestroy {
  @Output() close = new EventEmitter<void>();

  private authService = inject(AuthService);
  private sessionService = inject(SessionService); // por si luego quieres usarlo

  loading = false;
  error: string | null = null;

  ngOnInit() {
    console.groupCollapsed('%c[StripeCmp] ngOnInit', 'color:#0ff');
    console.log('[StripeCmp] Iniciando componente (Stripe en lugar de PayPal)');
    console.log('[StripeCmp] API_BASE:', environment.API_BASE);
    console.groupEnd();
  }

  ngOnDestroy() {
    console.log('[StripeCmp] ngOnDestroy → componente destruido');
  }

  onCloseClick() {
    console.log('[StripeCmp] onCloseClick → emitiendo close');
    this.close.emit();
  }

  // ============================
  //   LANZAR STRIPE CHECKOUT
  // ============================
  async onStripeCheckoutClick() {
    console.groupCollapsed('%c[StripeCmp] onStripeCheckoutClick', 'color:#6af');
    this.error = null;
    this.loading = true;

    try {
      const token = await this.authService.getIdToken();
      console.log('[StripeCmp] Firebase token?', token ? 'OK' : 'NULL');

      if (!token) {
        this.error = 'Debes iniciar sesión para comprar DruCoins.';
        console.warn('[StripeCmp] Sin token de Firebase');
        this.loading = false;
        console.groupEnd();
        return;
      }

      const url = `${environment.API_BASE}/stripe/create-checkout-session`;
      console.log('[StripeCmp] Llamando a', url);

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({}), // por ahora pack fijo en el backend
      });

      const raw = await res.text();
      console.log('[StripeCmp] /stripe/create-checkout-session RAW:', res.status, raw);

      if (!res.ok) {
        this.error = 'No se pudo iniciar el pago con Stripe.';
        console.error('[StripeCmp] Respuesta no OK al crear sesión Stripe');
        this.loading = false;
        console.groupEnd();
        return;
      }

      let data: any;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        console.error('[StripeCmp] JSON.parse falló en create-checkout-session', e);
        this.error = 'Respuesta inesperada del servidor de pagos.';
        this.loading = false;
        console.groupEnd();
        return;
      }

      console.log('[StripeCmp] /stripe/create-checkout-session JSON:', data);

      if (!data.ok || !data.url) {
        console.error('[StripeCmp] Payload inválido en create-checkout-session:', data);
        this.error = 'No se pudo iniciar el pago con Stripe.';
        this.loading = false;
        console.groupEnd();
        return;
      }

      console.log('[StripeCmp] Sesión Stripe OK, redirigiendo a', data.url);
      // 🔸 Redirigimos a la página de pago de Stripe
      window.location.href = data.url;
      console.groupEnd();
    } catch (err) {
      console.error('[StripeCmp] Error al iniciar Stripe Checkout', err);
      this.error = 'Ocurrió un error al iniciar el pago con Stripe.';
      this.loading = false;
      console.groupEnd();
    }
  }
}
