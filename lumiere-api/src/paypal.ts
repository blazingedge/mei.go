// paypal.ts en tu worker

const PAYPAL_API_BASE = env.PAYPAL_API_BASE || 'https://api-m.paypal.com';

async function getPayPalAccessToken(env: Env): Promise<string> {
  const auth = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_SECRET}`);

  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    console.error('[PayPal] Error obteniendo token', res.status);
    throw new Error('paypal_token_failed');
  }

  const data: any = await res.json();
  return data.access_token as string;
}
