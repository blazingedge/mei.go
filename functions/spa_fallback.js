export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname.match(/\.[a-zA-Z0-9]+$/)) {
    return context.next();
  }

  return context.env.ASSETS.fetch(
    new Request(`${url.origin}/index.html`, context.request)
  );
}
