// 本地预览原型用的静态文件服务（只监听 127.0.0.1）。仅供开发时检查原型。
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', 'docs', 'prototype');
const port = Number(process.env.PORT) || 8765;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary' };

http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.resolve(root, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }   // 防止路径穿越
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`prototype at http://127.0.0.1:${port}/`));
