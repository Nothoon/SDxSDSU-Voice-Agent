import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/demo-adapters.js', ['demo-adapters.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/api/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok', app: 'Thread' }));
    return;
  }
  const asset = assets.get(pathname);
  if (!asset) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }
  try {
    const body = await readFile(new URL(`./public/${asset[0]}`, import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1] });
    response.end(body);
  } catch {
    response.writeHead(500);
    response.end('Unable to load asset');
  }
}).listen(Number(process.env.PORT || 3000), '127.0.0.1', () => {
  console.log(`Thread running at http://localhost:${process.env.PORT || 3000}`);
});
