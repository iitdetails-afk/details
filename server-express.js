const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const app = express();
const port = process.env.PORT || 5000;
// On Vercel, only /tmp is writable. Use it for data files in production.
const isVercel = !!process.env.VERCEL;
const dataDir = isVercel ? '/tmp/data' : path.join(__dirname, 'data');
const submissionsFile = path.join(dataDir, 'submissions.json');
const detailsFile = path.join(dataDir, 'details.json');
const sheetsConfigFile = path.join(dataDir, 'sheets_config.json');
const adminConfigFile = path.join(dataDir, 'admin_config.json');
const backendPortFile = path.join(__dirname, '.backend-port');

// ── Single admin session (in-memory) ──────────────────────────────────
let adminSession = { token: null, loginAt: null };

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getAdminPin() {
  const cfg = readJson(adminConfigFile, { pin: '1234' });
  return cfg.pin || '1234';
}

function isValidToken(token) {
  return token && adminSession.token && token === adminSession.token;
}

function getAuthToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

function requireAdmin(req, res, next) {
  const token = getAuthToken(req);
  if (!isValidToken(token)) {
    return res.status(401).json({ success: false, error: 'Unauthorized — admin login required' });
  }
  next();
}

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/details', (req, res) => {
  res.redirect('/details.html');
});

app.get('/form', (req, res) => {
  res.redirect('/form.html');
});

app.get('/ss', (req, res) => {
  res.redirect('/ss.html');
});

function ensureDataFiles() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(submissionsFile)) fs.writeFileSync(submissionsFile, '[]', 'utf8');
  if (!fs.existsSync(detailsFile)) fs.writeFileSync(detailsFile, '{}', 'utf8');
  if (!fs.existsSync(sheetsConfigFile)) fs.writeFileSync(sheetsConfigFile, JSON.stringify({ webAppUrl: "" }, null, 2), 'utf8');
  if (!fs.existsSync(adminConfigFile)) fs.writeFileSync(adminConfigFile, JSON.stringify({ pin: '1234' }, null, 2), 'utf8');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function sendIfFileExists(res, fileName) {
  const safePath = path.join(__dirname, fileName);
  if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
    res.sendFile(safePath);
    return true;
  }
  return false;
}

ensureDataFiles();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/details', (req, res) => {
  writeJson(detailsFile, req.body);
  res.json({ success: true, saved: req.body });
});

app.get('/api/details', (req, res) => {
  res.json(readJson(detailsFile, {}));
});

function getNextSubmissionId(submissions) {
  let maxId = 0;
  submissions.forEach(s => {
    if (s.submissionId && s.submissionId.startsWith('ID-')) {
      const num = parseInt(s.submissionId.substring(3), 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  });
  return `ID-${String(maxId + 1).padStart(4, '0')}`;
}

function postToGoogleSheet(url, payload) {
  return new Promise((resolve, reject) => {
    if (!url) {
      resolve();
      return;
    }
    try {
      const parsedUrl = new URL(url);
      const dataString = JSON.stringify(payload);
      
      const options = {
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dataString)
        }
      };
      
      const req = https.request(options, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          postToGoogleSheet(redirectUrl, payload).then(resolve).catch(reject);
          return;
        }
        
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve(body));
      });
      
      req.on('error', (err) => {
        reject(err);
      });
      
      req.write(dataString);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

app.post('/api/submit', (req, res) => {
  const submissions = readJson(submissionsFile, []);
  const payload = req.body;
  
  if (payload.submissionId && payload.submissionId !== 'N/A' && payload.submissionId !== '') {
    const existingIndex = submissions.findIndex(s => s.submissionId === payload.submissionId);
    if (existingIndex !== -1) {
      submissions[existingIndex] = {
        ...submissions[existingIndex],
        ...payload,
        submittedAt: payload.submittedAt || submissions[existingIndex].submittedAt || new Date().toLocaleString()
      };
      writeJson(submissionsFile, submissions);
      
      const sheetsConfig = readJson(sheetsConfigFile, { webAppUrl: "" });
      if (sheetsConfig.webAppUrl) {
        const sheetPayload = { ...submissions[existingIndex] };
        delete sheetPayload.photo;
        postToGoogleSheet(sheetsConfig.webAppUrl, sheetPayload).catch(e => console.warn('Google Sheets sync failed:', e));
      }

      res.json({ success: true, saved: submissions[existingIndex] });
      return;
    }
  }

  // Validate email uniqueness for new submissions
  if (payload.email && payload.email.trim()) {
    const emailExists = submissions.some(s => s.email && s.email.trim().toLowerCase() === payload.email.trim().toLowerCase());
    if (emailExists) {
      return res.status(400).json({ success: false, error: 'This email is already registered. Each email can only be used once.' });
    }
  }

  const generatedId = getNextSubmissionId(submissions);
  const newPayload = { 
    ...payload, 
    submissionId: payload.submissionId && payload.submissionId !== 'N/A' && payload.submissionId !== '' ? payload.submissionId : generatedId,
    submittedAt: payload.submittedAt || new Date().toLocaleString() 
  };
  submissions.push(newPayload);
  writeJson(submissionsFile, submissions);

  const sheetsConfig = readJson(sheetsConfigFile, { webAppUrl: "" });
  if (sheetsConfig.webAppUrl) {
    const sheetPayload = { ...newPayload };
    delete sheetPayload.photo;
    postToGoogleSheet(sheetsConfig.webAppUrl, sheetPayload).catch(e => console.warn('Google Sheets sync failed:', e));
  }

  res.json({ success: true, saved: newPayload });
});

app.get('/api/sheets-config', (req, res) => {
  res.json(readJson(sheetsConfigFile, { webAppUrl: "" }));
});

app.post('/api/sheets-config', requireAdmin, (req, res) => {
  const payload = req.body;
  writeJson(sheetsConfigFile, payload);
  res.json({ success: true, config: payload });
});

app.post('/api/delete', requireAdmin, (req, res) => {
  const { submissionId } = req.body;
  const submissions = readJson(submissionsFile, []);
  const filtered = submissions.filter(s => s.submissionId !== submissionId);
  writeJson(submissionsFile, filtered);

  const sheetsConfig = readJson(sheetsConfigFile, { webAppUrl: "" });
  if (sheetsConfig.webAppUrl) {
    postToGoogleSheet(sheetsConfig.webAppUrl, { submissionId, action: "DELETE" }).catch(e => console.warn('Google Sheets delete failed:', e));
  }

  res.json({ success: true });
});

// ── Admin Endpoints ──
app.post('/api/admin/login', (req, res) => {
  const { pin } = req.body;
  const correctPin = getAdminPin();
  if (!pin || pin !== correctPin) {
    return res.status(401).json({ success: false, error: 'Incorrect PIN' });
  }
  const token = generateToken();
  adminSession = { token, loginAt: new Date().toISOString() };
  console.log(`[Admin] New session started at ${adminSession.loginAt}`);
  res.json({ success: true, token });
});

app.post('/api/admin/logout', (req, res) => {
  adminSession = { token: null, loginAt: null };
  console.log('[Admin] Session cleared');
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  const token = getAuthToken(req);
  res.json({ valid: isValidToken(token) });
});

app.post('/api/admin/pin', requireAdmin, (req, res) => {
  const { currentPin, newPin } = req.body;
  if (currentPin !== getAdminPin()) {
    return res.status(401).json({ success: false, error: 'Current PIN is incorrect' });
  }
  if (!newPin || !/^\d{4}$/.test(newPin)) {
    return res.status(400).json({ success: false, error: 'New PIN must be 4 digits' });
  }
  writeJson(adminConfigFile, { pin: newPin });
  res.json({ success: true });
});

app.get('/api/submissions', (req, res) => {
  res.json(readJson(submissionsFile, []));
});

app.get('/api/pages', (req, res) => {
  res.json(['details.html', 'form.html', 'ss.html']);
});

app.get('/details.html', (req, res) => {
  if (!sendIfFileExists(res, 'details.html')) {
    res.status(404).send('Not found');
  }
});

app.get('/form.html', (req, res) => {
  if (!sendIfFileExists(res, 'form.html')) {
    res.status(404).send('Not found');
  }
});

app.get('/ss.html', (req, res) => {
  if (!sendIfFileExists(res, 'ss.html')) {
    res.status(404).send('Not found');
  }
});

function writeBackendPort(portNumber) {
  try {
    fs.writeFileSync(backendPortFile, String(portNumber), 'utf8');
  } catch (e) {
    // Ignore write errors (e.g. read-only filesystem on Vercel)
  }
}

function startServer(currentPort) {
  const server = app.listen(currentPort, () => {
    writeBackendPort(currentPort);
    console.log(`Backend running on http://localhost:${currentPort}`);
  });

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      const nextPort = currentPort + 1;
      console.warn(`Port ${currentPort} is busy. Trying ${nextPort}...`);
      startServer(nextPort);
    } else {
      throw error;
    }
  });
}

// Only start the server when run directly (e.g. node server-express.js)
// When imported by Vercel serverless, just export the app
if (require.main === module) {
  startServer(process.env.PORT || 5000);
}

module.exports = app;