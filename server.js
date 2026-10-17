/* =========================================================
   ANIRUDH AGENCY — Local Server with Public Tunnel
   =========================================================
   Starts a local file server AND creates a public internet
   tunnel via localtunnel so you can share the app with
   phones on any network (mobile data, different Wi-Fi, etc.)
   ========================================================= */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const BASE_DIR = __dirname;
const ENABLE_TUNNEL = !process.argv.includes('--no-tunnel');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt':  'text/plain; charset=utf-8'
};

/* ── Network Helpers ── */
function getLocalIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
        candidates.push({ name, address: net.address });
      }
    }
  }
  const wifi = candidates.find(c => /wi-?fi|wireless|wlan/i.test(c.name));
  if (wifi) return wifi.address;
  return candidates.length > 0 ? candidates[0].address : '127.0.0.1';
}

const localIp = getLocalIp();
const localUrl = `http://localhost:${PORT}`;
const lanUrl   = `http://${localIp}:${PORT}`;

/* Shared state — populated after tunnel connects */
let tunnelUrl      = null;
let tunnelPassword = null;
let tunnelError    = null;
let tunnelReady    = false;

/* Fetch public host IP for localtunnel password prompt if needed */
function fetchPublicIp() {
  const https = require('https');
  const req = https.get('https://loca.lt/mytunnelpassword', { timeout: 5000 }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const ip = d.trim();
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
        tunnelPassword = ip;
      }
    });
  });
  req.on('error', () => {
    https.get('https://api.ipify.org', { timeout: 5000 }, (r2) => {
      let d2 = '';
      r2.on('data', c => d2 += c);
      r2.on('end', () => {
        const ip = d2.trim();
        if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
          tunnelPassword = ip;
        }
      });
    }).on('error', () => {});
  });
}
fetchPublicIp();

/* ── HTTP File Server ── */
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  /* Network info API — used by the app's QR code generator */
  if (req.url === '/api/network-ip') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      lan:            lanUrl,
      local:          localUrl,
      public:         tunnelUrl || null,
      tunnelPassword: tunnelPassword || null,
      tunnelReady,
      /* Best URL to display in QR: prefer public tunnel */
      url:            tunnelUrl || lanUrl
    }));
    return;
  }

  /* Tunnel status SSE stream — app polls this for live updates */
  if (req.url === '/api/tunnel-status') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    const sendStatus = () => {
      const data = JSON.stringify({ tunnelUrl, tunnelReady, tunnelError });
      res.write(`data: ${data}\n\n`);
    };
    sendStatus();
    const interval = setInterval(sendStatus, 2000);
    req.on('close', () => clearInterval(interval));
    return;
  }

  /* Static file serving */
  let safePath = req.url.split('?')[0].split('#')[0];
  if (safePath === '/' || safePath === '') safePath = '/index.html';

  const filePath = path.normalize(path.join(BASE_DIR, safePath));
  if (!filePath.startsWith(BASE_DIR)) {
    res.writeHead(403); res.end('Access Denied'); return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      /* SPA fallback → index.html */
      fs.readFile(path.join(BASE_DIR, 'index.html'), (e2, content) => {
        if (e2) { res.writeHead(404, {'Content-Type': 'text/plain'}); res.end('404'); }
        else { res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'}); res.end(content); }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

/* ── Start Server then Tunnel ── */
server.listen(PORT, '0.0.0.0', async () => {
  console.log('\n=============================================================');
  console.log('   ANIRUDH AGENCY — Wholesale Order Entry Mobile App');
  console.log('=============================================================');
  console.log(`   Desktop:       ${localUrl}`);
  console.log(`   Same Wi-Fi:    ${lanUrl}`);
  console.log('-------------------------------------------------------------');

  if (ENABLE_TUNNEL) {
    console.log('   Public tunnel: Starting... (any network / mobile data)');
    await startTunnel();
  } else {
    console.log('   Public tunnel: Disabled (run without --no-tunnel to enable)');
    printInstallInstructions();
  }

  if (process.argv.includes('--open')) {
    const startCmd = process.platform === 'win32' ? `start ${localUrl}` : `open ${localUrl}`;
    exec(startCmd, () => {});
  }
});

/* ── Public Tunnel via Cloudflare (cloudflared) or localtunnel ── */
let tunnelChildProc = null;

async function startTunnel() {
  const cloudflaredPath = path.join(BASE_DIR, 'cloudflared.exe');
  if (fs.existsSync(cloudflaredPath)) {
    console.log('   Starting Cloudflare Tunnel (ultra-reliable, zero password)...');
    startCloudflareTunnel(cloudflaredPath);
    return;
  }
  startLocaltunnel();
}

function startCloudflareTunnel(binPath) {
  const { spawn } = require('child_process');
  tunnelChildProc = spawn(binPath, [
    'tunnel',
    '--protocol', 'http2',
    '--url', `http://127.0.0.1:${PORT}`
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const onData = (data) => {
    const text = data.toString();
    const match = text.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i);
    if (match && !tunnelReady) {
      tunnelUrl   = match[1];
      tunnelReady = true;
      tunnelError = null;

      console.log('\n=============================================================');
      console.log('   ✅ CLOUDFLARE PUBLIC URL READY (Rock-solid, Zero password)!');
      console.log('=============================================================');
      console.log(`   📱 Public URL:  ${tunnelUrl}`);
      console.log('-------------------------------------------------------------');
      console.log('   HOW TO INSTALL ON MOBILE:');
      console.log('   1. Open Chrome or Safari on ANY phone');
      console.log(`   2. Go to: ${tunnelUrl}`);
      console.log('      (Or scan the QR code in the app → Phone QR Code button)');
      console.log('   3. Android: Tap "Install App on Device"');
      console.log('   4. iPhone:  Share → Add to Home Screen');
      console.log('=============================================================\n');
    }
  };

  tunnelChildProc.stdout.on('data', onData);
  tunnelChildProc.stderr.on('data', onData);

  tunnelChildProc.on('close', () => {
    tunnelUrl   = null;
    tunnelReady = false;
  });

  process.on('exit', () => {
    if (tunnelChildProc) tunnelChildProc.kill();
  });
  process.on('SIGINT', () => {
    if (tunnelChildProc) tunnelChildProc.kill();
    process.exit(0);
  });
}

async function startLocaltunnel() {
  try {
    let lt;
    try {
      lt = require('localtunnel');
    } catch (e) {
      fallbackTunnel();
      return;
    }

    console.log('   Connecting to localtunnel.me...');
    const tunnel = await lt({ port: PORT });

    tunnelUrl   = tunnel.url;
    tunnelReady = true;
    tunnelError = null;

    console.log('\n=============================================================');
    console.log('   ✅ PUBLIC URL READY — Share with ANYONE on ANY network!');
    console.log('=============================================================');
    console.log(`   📱 Public URL:  ${tunnelUrl}`);
    if (tunnelPassword) {
      console.log(`   🔑 Tunnel IP:   ${tunnelPassword} (enter on phone if prompted)`);
    }
    console.log('-------------------------------------------------------------');
    console.log('   HOW TO INSTALL ON MOBILE:');
    console.log('   1. Open Chrome or Safari on ANY phone');
    console.log(`   2. Go to: ${tunnelUrl}`);
    console.log('   3. Android: Tap "Install App on Device"');
    console.log('   4. iPhone:  Share → Add to Home Screen');
    console.log('=============================================================\n');

    tunnel.on('close', () => {
      tunnelUrl   = null;
      tunnelReady = false;
    });
  } catch (err) {
    tunnelError = err.message;
    printInstallInstructions();
  }
}

function fallbackTunnel() {
  const { spawn } = require('child_process');
  const proc = spawn('npx', ['localtunnel', '--port', String(PORT)], {
    shell: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', (data) => {
    const text = data.toString();
    const match = text.match(/(https?:\/\/[a-z0-9-]+\.loca\.lt)/i);
    if (match && !tunnelReady) {
      tunnelUrl   = match[1];
      tunnelReady = true;
      console.log(`\n✅ Public URL: ${tunnelUrl}\n`);
    }
  });
  proc.on('error', () => printInstallInstructions());
}

function printInstallInstructions() {
  console.log(`   Same Wi-Fi URL: ${lanUrl}`);
  console.log('   Scan QR code in the app for LAN access.\n');
}
