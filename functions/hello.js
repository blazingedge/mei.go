export async function onRequest(context) {
  const url = new URL(context.request.url);

  // Si el request es un archivo (chunk, asset, etc) se sirve normalmente
  if (url.pathname.match(/\.[a-zA-Z0-9]+$/)) {
    return context.next();
  }

  // Si es una ruta Angular (login, spreads, auth, tarot, etc)
  // devolver index.html SIEMPRE
  return context.env.ASSETS.fetch(
    new Request(`${url.origin}/index.html`, context.request)
  );
}
