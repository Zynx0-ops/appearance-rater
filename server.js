// Appearance Rater — zero-dependency Node server.
//
// Serves the single-page app from /public and exposes a small JSON API that
// turns analysis scores into suggestions + product recommendations.
// Photos are analyzed in the browser and are never sent to this server.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildRecommendations, loadCatalog } = require('./lib/recommend');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 16 * 1024; // the API only accepts small JSON score payloads

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  // Block path traversal outside /public.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleApi(req, res) {
  const { pathname } = new URL(req.url, 'http://x');

  if (req.method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && pathname === '/api/products') {
    return sendJson(res, 200, loadCatalog().products);
  }

  if (req.method === 'POST' && pathname === '/api/recommendations') {
    try {
      const body = await readJsonBody(req);
      return sendJson(res, 200, buildRecommendations(body));
    } catch (err) {
      return sendJson(res, err.status || 400, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Unknown endpoint' });
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      handleApi(req, res).catch((err) => {
        console.error(err);
        sendJson(res, 500, { error: 'Server error' });
      });
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
    } else {
      res.writeHead(405).end('Method not allowed');
    }
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

if (require.main === module) {
  createServer().listen(PORT, HOST, () => {
    console.log(`\n  Appearance Rater is running:\n`);
    console.log(`    Local:   http://localhost:${PORT}`);
    for (const ip of lanAddresses()) {
      console.log(`    Network: http://${ip}:${PORT}  (upload works; live camera needs https or localhost)`);
    }
    console.log('');
  });
}

module.exports = { createServer };
