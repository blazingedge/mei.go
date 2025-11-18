export const onRequest = async (context) => {
  // Ejecuta el request normal (devuelve HTML, JS, etc.)
  const response = await context.next();

  // Construimos un nuevo objeto Response para poder modificar headers
  const newHeaders = new Headers(response.headers);

  // 🔥 FIX ABSOLUTO PARA GOOGLE OAUTH POPUP 🔥
  // Evitamos que COOP/COEP bloqueen window.close()
  newHeaders.set("Cross-Origin-Opener-Policy", "unsafe-none");
  newHeaders.set("Cross-Origin-Embedder-Policy", "unsafe-none");
  newHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");

  // Opcional: evita bloqueos de iframes y recursos externos
  newHeaders.set("X-Frame-Options", "ALLOWALL");

  // Opcional: asegura que Firebase Auth pueda comunicar el popup correctamente
  newHeaders.set("Access-Control-Allow-Origin", "*");
  newHeaders.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  newHeaders.set("Access-Control-Allow-Headers", "*");

  // Respuesta final con headers modificados
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
};
