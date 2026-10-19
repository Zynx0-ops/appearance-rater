// Appearance Rater — zero-dependency local dev server.
//
// The app is fully static (everything in /public), so this just serves files.
// In production it's hosted on GitHub Pages. Photos are analyzed in the
// browser and are never sent anywhere.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

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

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
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
