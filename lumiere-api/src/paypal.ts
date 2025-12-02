


// paypal.ts en el Worker
async function getPayPalAccessToken(env: Env): Promise<string> {
  const clientId = env.PAY_PAL_CLIENT_ID;
  const secret   = env.PAYPAL_SECRET;

  if (!clientId || !secret) {
    console.error('[PayPal] Faltan credenciales');
    throw new Error('paypal_missing_config');
  }

  // 👇 Fallback sensato para dev (sandbox)
  const apiBase = env.PAYPAL_API_BASE || 'https://api-m.sandbox.paypal.com';

  const authHeader = 'Basic ' + btoa(`${clientId}:${secret}`);

  const res = await fetch(`${apiBase}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const raw = await res.text();
  devLog(env, '[PayPal] OAuth status:', res.status, raw);

  if (!res.ok) {
    throw new Error('paypal_token_failed');
  }

  const data = JSON.parse(raw);
  if (!data.access_token) throw new Error('paypal_token_missing');

  return data.access_token as string;
}


