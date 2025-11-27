export type TurnstileResponse = {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
};

export async function verifyTurnstile(token: string, env: Env): Promise<TurnstileResponse> {
  // Usa SIEMPRE el FormData global del runtime de Cloudflare
  const formData = new FormData();
  formData.append('secret', env.TURNSTILE_SECRET);
  formData.append('response', token);

  const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: formData,
  });

  if (!resp.ok) {
    console.error('❌ /siteverify status:', resp.status);
    throw new Error(`turnstile_http_${resp.status}`);
  }

  const json = (await resp.json()) as TurnstileResponse;
  console.log('Turnstile JSON:', json);
  return json;
}
