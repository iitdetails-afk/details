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
const staffFile = path.join(dataDir, 'staff.json');
const attendanceFile = path.join(dataDir, 'attendance.json');
const leavesFile = path.join(dataDir, 'leaves.json');
const tasksFile = path.join(dataDir, 'tasks.json');
const notificationsFile = path.join(dataDir, 'notifications.json');
const backendPortFile = path.join(__dirname, '.backend-port');

// ── Single admin session (in-memory) ──────────────────────────────────
let adminSession = { token: null, loginAt: null };

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const TOKEN_SECRET = 'iit_super_secret_token_key_2026';

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
}

function generateSessionToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64').replace(/=/g, '');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64').replace(/=/g, '');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${signature}`;
}

function verifySessionToken(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = crypto.createHmac('sha256', TOKEN_SECRET).update(`${header}.${body}`).digest('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (signature !== expectedSig) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64').toString('utf8'));
  } catch {
    return null;
  }
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

function requireStaff(req, res, next) {
  const token = getAuthToken(req);
  const payload = verifySessionToken(token);
  if (!payload || payload.role !== 'staff') {
    return res.status(401).json({ success: false, error: 'Unauthorized — staff login required' });
  }
  req.staffId = payload.staffId;
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
  if (!fs.existsSync(staffFile)) fs.writeFileSync(staffFile, '[]', 'utf8');
  if (!fs.existsSync(attendanceFile)) fs.writeFileSync(attendanceFile, '[]', 'utf8');
  if (!fs.existsSync(leavesFile)) fs.writeFileSync(leavesFile, '[]', 'utf8');
  if (!fs.existsSync(tasksFile)) fs.writeFileSync(tasksFile, '[]', 'utf8');
  if (!fs.existsSync(notificationsFile)) fs.writeFileSync(notificationsFile, '[]', 'utf8');
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

// ── Staff Management Endpoints ──
function getNextStaffId(staff) {
  let maxId = 0;
  const year = new Date().getFullYear();
  const prefix = `STF${year}`;
  staff.forEach(s => {
    if (s.staffId && s.staffId.startsWith(prefix)) {
      const num = parseInt(s.staffId.substring(prefix.length), 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  });
  return `${prefix}${String(maxId + 1).padStart(4, '0')}`;
}

app.get('/api/staff', (req, res) => {
  const staffList = readJson(staffFile, []);
  // Strip sensitive salt/hash from response
  const publicList = staffList.map(s => {
    const { passwordHash, salt, ...publicData } = s;
    return publicData;
  });
  res.json(publicList);
});

// Admin registers or edits staff
app.post('/api/staff', requireAdmin, (req, res) => {
  const staffList = readJson(staffFile, []);
  const payload = req.body;
  const { staffId, name, mobile, email, department, role, password, status, photo, docName, docBase64 } = payload;
  
  if (!name || !mobile || !email || !role || !department) {
    return res.status(400).json({ success: false, error: 'Name, Mobile, Email, Department, and Role/Designation are required fields.' });
  }

  // Email unique check
  const emailIndex = staffList.findIndex(s => s.email.toLowerCase() === email.toLowerCase() && s.staffId !== staffId);
  if (emailIndex !== -1) {
    return res.status(400).json({ success: false, error: 'A staff member with this Email already exists.' });
  }
  
  // Mobile unique check
  const mobileIndex = staffList.findIndex(s => s.mobile === mobile && s.staffId !== staffId);
  if (mobileIndex !== -1) {
    return res.status(400).json({ success: false, error: 'A staff member with this Mobile number already exists.' });
  }

  if (staffId && staffId !== '') {
    const existingIndex = staffList.findIndex(s => s.staffId === staffId);
    if (existingIndex !== -1) {
      const existing = staffList[existingIndex];
      let updatedHash = existing.passwordHash;
      let updatedSalt = existing.salt;
      
      if (password && password.trim() !== '') {
        updatedSalt = crypto.randomBytes(16).toString('hex');
        updatedHash = hashPassword(password, updatedSalt);
      }
      
      staffList[existingIndex] = {
        ...existing,
        name,
        mobile,
        email,
        department,
        role,
        status: status || existing.status,
        photo: photo !== undefined ? photo : existing.photo,
        docName: docName !== undefined ? docName : existing.docName,
        docBase64: docBase64 !== undefined ? docBase64 : existing.docBase64,
        passwordHash: updatedHash,
        salt: updatedSalt,
        updatedAt: new Date().toLocaleString()
      };
      
      writeJson(staffFile, staffList);
      const { passwordHash, salt, ...publicData } = staffList[existingIndex];
      res.json({ success: true, saved: publicData });
      return;
    }
  }

  // Create new staff member
  if (!password || password.trim() === '') {
    return res.status(400).json({ success: false, error: 'Password is required for new registration.' });
  }
  
  const generatedId = getNextStaffId(staffList);
  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  
  const newStaff = {
    staffId: generatedId,
    name,
    mobile,
    email,
    department,
    role,
    status: status || 'Active',
    photo: photo || '',
    docName: docName || '',
    docBase64: docBase64 || '',
    passwordHash,
    salt,
    createdAt: new Date().toLocaleString()
  };
  
  staffList.push(newStaff);
  writeJson(staffFile, staffList);
  
  const { passwordHash: ph, salt: st, ...publicData } = newStaff;
  res.json({ success: true, saved: publicData });
});

// Admin toggle status
app.post('/api/staff/toggle', requireAdmin, (req, res) => {
  const { staffId, status } = req.body;
  const staffList = readJson(staffFile, []);
  const index = staffList.findIndex(s => s.staffId === staffId);
  if (index === -1) return res.status(404).json({ success: false, error: 'Staff not found.' });
  
  staffList[index].status = status;
  writeJson(staffFile, staffList);
  res.json({ success: true, status });
});

// Admin reset password
app.post('/api/staff/reset-password', requireAdmin, (req, res) => {
  const { staffId, newPassword } = req.body;
  const staffList = readJson(staffFile, []);
  const index = staffList.findIndex(s => s.staffId === staffId);
  if (index === -1) return res.status(404).json({ success: false, error: 'Staff not found.' });
  
  const salt = crypto.randomBytes(16).toString('hex');
  staffList[index].salt = salt;
  staffList[index].passwordHash = hashPassword(newPassword, salt);
  writeJson(staffFile, staffList);
  res.json({ success: true });
});

app.post('/api/staff/delete', requireAdmin, (req, res) => {
  const { staffId } = req.body;
  const staffList = readJson(staffFile, []);
  const filtered = staffList.filter(s => s.staffId !== staffId);
  writeJson(staffFile, filtered);
  res.json({ success: true });
});

// Staff Authentication Login
app.post('/api/staff/login', (req, res) => {
  const { staffId, password } = req.body;
  if (!staffId || !password) return res.status(400).json({ success: false, error: 'Staff ID and password are required.' });
  
  const staffList = readJson(staffFile, []);
  const staff = staffList.find(s => s.staffId.toUpperCase() === staffId.trim().toUpperCase());
  
  if (!staff) {
    return res.status(401).json({ success: false, error: 'Incorrect Staff ID or password.' });
  }
  
  if (staff.status === 'Inactive' || staff.status === 'Disabled') {
    return res.status(403).json({ success: false, error: 'Your account is disabled. Contact Admin.' });
  }
  
  const calculatedHash = hashPassword(password, staff.salt);
  if (calculatedHash !== staff.passwordHash) {
    return res.status(401).json({ success: false, error: 'Incorrect Staff ID or password.' });
  }
  
  // Generate signed session token
  const token = generateSessionToken({ staffId: staff.staffId, role: 'staff', name: staff.name });
  res.json({ success: true, token, name: staff.name, staffId: staff.staffId });
});

// Fetch Profile
app.get('/api/staff/profile', requireStaff, (req, res) => {
  const staffList = readJson(staffFile, []);
  const staff = staffList.find(s => s.staffId === req.staffId);
  if (!staff) return res.status(404).json({ success: false, error: 'Staff not found.' });
  const { passwordHash, salt, ...profile } = staff;
  res.json(profile);
});

// ── Staff Attendance Endpoints ──
app.post('/api/staff/attendance', requireStaff, (req, res) => {
  const { latitude, longitude, address, photo } = req.body;
  if (!latitude || !longitude || !photo) {
    return res.status(400).json({ success: false, error: 'GPS coordinates and a live photo are required to mark attendance.' });
  }

  const attendanceLog = readJson(attendanceFile, []);
  const todayStr = new Date().toLocaleDateString('en-IN');
  
  // Check if attendance already marked today
  const alreadyMarked = attendanceLog.some(a => a.staffId === req.staffId && new Date(a.timestamp).toLocaleDateString('en-IN') === todayStr);
  if (alreadyMarked) {
    return res.status(400).json({ success: false, error: 'Attendance already marked for today.' });
  }

  // Calculate late arrivals (after 9:30 AM)
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const isLate = minutes > (9 * 60 + 30); // Late if checked in after 09:30

  const record = {
    id: 'ATT-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    staffId: req.staffId,
    timestamp: now.toISOString(),
    latitude,
    longitude,
    address: address || 'N/A',
    photo,
    isLate
  };

  attendanceLog.push(record);
  writeJson(attendanceFile, attendanceLog);
  res.json({ success: true, record });
});

// Fetch attendance log for admin
app.get('/api/admin/attendance', requireAdmin, (req, res) => {
  const log = readJson(attendanceFile, []);
  const staffList = readJson(staffFile, []);
  
  // Join staff name and role for display
  const detailedLog = log.map(item => {
    const s = staffList.find(x => x.staffId === item.staffId) || {};
    return {
      ...item,
      staffName: s.name || 'Unknown',
      staffRole: s.role || 'N/A',
      staffDept: s.department || 'N/A'
    };
  });
  
  res.json(detailedLog);
});

// ── Leave & OD Management Endpoints ──
app.post('/api/staff/leave', requireStaff, (req, res) => {
  const { type, startDate, endDate, reason, docName, docBase64 } = req.body;
  if (!type || !startDate || !endDate || !reason) {
    return res.status(400).json({ success: false, error: 'Leave type, start date, end date, and reason are required.' });
  }

  const leaves = readJson(leavesFile, []);
  const newRequest = {
    id: 'REQ-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    staffId: req.staffId,
    type, // 'Leave' or 'On-Duty'
    startDate,
    endDate,
    reason,
    docName: docName || '',
    docBase64: docBase64 || '',
    status: 'Pending',
    remarks: '',
    createdAt: new Date().toISOString()
  };

  leaves.push(newRequest);
  writeJson(leavesFile, leaves);
  res.json({ success: true, request: newRequest });
});

// Fetch leaves for staff
app.get('/api/staff/leaves', requireStaff, (req, res) => {
  const leaves = readJson(leavesFile, []);
  const filtered = leaves.filter(l => l.staffId === req.staffId);
  res.json(filtered);
});

// Fetch leaves for admin
app.get('/api/admin/leaves', requireAdmin, (req, res) => {
  const leaves = readJson(leavesFile, []);
  const staffList = readJson(staffFile, []);
  
  const detailed = leaves.map(item => {
    const s = staffList.find(x => x.staffId === item.staffId) || {};
    return {
      ...item,
      staffName: s.name || 'Unknown',
      staffRole: s.role || 'N/A',
      staffDept: s.department || 'N/A'
    };
  });
  res.json(detailed);
});

// Admin approve/reject leave or OD
app.post('/api/admin/leaves/action', requireAdmin, (req, res) => {
  const { id, status, remarks } = req.body;
  if (!id || !status) return res.status(400).json({ success: false, error: 'Request ID and action status are required.' });
  
  const leaves = readJson(leavesFile, []);
  const index = leaves.findIndex(l => l.id === id);
  if (index === -1) return res.status(404).json({ success: false, error: 'Request not found.' });

  leaves[index].status = status; // 'Approved' or 'Rejected'
  leaves[index].remarks = remarks || '';
  writeJson(leavesFile, leaves);

  // Add notification for staff
  const notifications = readJson(notificationsFile, []);
  notifications.push({
    id: 'NTF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    staffId: leaves[index].staffId,
    message: `Your ${leaves[index].type} request from ${leaves[index].startDate} has been ${status.toLowerCase()}.${remarks ? ' Remarks: ' + remarks : ''}`,
    type: 'leave',
    read: false,
    createdAt: new Date().toISOString()
  });
  writeJson(notificationsFile, notifications);

  res.json({ success: true });
});

// ── Work Assignment / Task Endpoints ──
// Admin assign task
app.post('/api/admin/tasks', requireAdmin, (req, res) => {
  const { title, description, priority, dueDate, department, assignedStaffId, attachmentName, attachmentBase64 } = req.body;
  if (!title || !description || !priority || !dueDate || !assignedStaffId) {
    return res.status(400).json({ success: false, error: 'Title, description, priority, due date, and assigned staff are required.' });
  }

  const tasks = readJson(tasksFile, []);
  const staffList = readJson(staffFile, []);
  const s = staffList.find(x => x.staffId === assignedStaffId);
  if (!s) return res.status(400).json({ success: false, error: 'Assigned staff member not found.' });

  const newTask = {
    id: 'TSK-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    title,
    description,
    priority, // 'Low', 'Medium', 'High'
    assignedDate: new Date().toLocaleDateString('en-IN'),
    dueDate,
    department: department || s.department || 'N/A',
    assignedStaffId,
    assignedStaffName: s.name,
    attachmentName: attachmentName || '',
    attachmentBase64: attachmentBase64 || '',
    status: 'Pending', // 'Pending', 'In Progress', 'Completed'
    completionTime: '',
    comments: '',
    progress: 0,
    progressUpdates: [] // array of updates
  };

  tasks.push(newTask);
  writeJson(tasksFile, tasks);

  // Add notification
  const notifications = readJson(notificationsFile, []);
  notifications.push({
    id: 'NTF-' + crypto.randomBytes(4).toString('hex').toUpperCase(),
    staffId: assignedStaffId,
    message: `New task assigned: "${title}" (Due: ${dueDate})`,
    type: 'task',
    read: false,
    createdAt: new Date().toISOString()
  });
  writeJson(notificationsFile, notifications);

  res.json({ success: true, task: newTask });
});

// Fetch tasks for admin
app.get('/api/admin/tasks', requireAdmin, (req, res) => {
  res.json(readJson(tasksFile, []));
});

// Fetch tasks for staff
app.get('/api/staff/tasks', requireStaff, (req, res) => {
  const tasks = readJson(tasksFile, []);
  const filtered = tasks.filter(t => t.assignedStaffId === req.staffId);
  res.json(filtered);
});

// Staff update task status
app.post('/api/staff/tasks/status', requireStaff, (req, res) => {
  const { id, status, comments } = req.body;
  if (!id || !status) return res.status(400).json({ success: false, error: 'Task ID and status are required.' });

  const tasks = readJson(tasksFile, []);
  const index = tasks.findIndex(t => t.id === id && t.assignedStaffId === req.staffId);
  if (index === -1) return res.status(404).json({ success: false, error: 'Task not found.' });

  tasks[index].status = status;
  if (comments !== undefined) tasks[index].comments = comments;
  
  if (status === 'Completed') {
    tasks[index].completionTime = new Date().toLocaleString();
    tasks[index].progress = 100;
  } else if (status === 'In Progress' && tasks[index].progress === 0) {
    tasks[index].progress = 10;
  }
  
  writeJson(tasksFile, tasks);
  res.json({ success: true, task: tasks[index] });
});

// Staff post progress update
app.post('/api/staff/tasks/progress', requireStaff, (req, res) => {
  const { id, progress, comments, fileName, fileBase64 } = req.body;
  if (!id || progress === undefined) return res.status(400).json({ success: false, error: 'Task ID and progress percentage are required.' });

  const tasks = readJson(tasksFile, []);
  const index = tasks.findIndex(t => t.id === id && t.assignedStaffId === req.staffId);
  if (index === -1) return res.status(404).json({ success: false, error: 'Task not found.' });

  const progressPct = parseInt(progress, 10);
  tasks[index].progress = progressPct;
  if (progressPct === 100) {
    tasks[index].status = 'Completed';
    tasks[index].completionTime = new Date().toLocaleString();
  }

  const updateRecord = {
    progress: progressPct,
    comments: comments || '',
    fileName: fileName || '',
    fileBase64: fileBase64 || '',
    timestamp: new Date().toLocaleString()
  };

  tasks[index].progressUpdates.push(updateRecord);
  writeJson(tasksFile, tasks);
  res.json({ success: true, task: tasks[index] });
});

// Staff notifications list
app.get('/api/staff/notifications', requireStaff, (req, res) => {
  const list = readJson(notificationsFile, []);
  const filtered = list.filter(n => n.staffId === req.staffId);
  res.json(filtered.reverse());
});

// Staff mark notification read
app.post('/api/staff/notifications/read', requireStaff, (req, res) => {
  const { id } = req.body;
  const list = readJson(notificationsFile, []);
  const index = list.findIndex(n => n.id === id && n.staffId === req.staffId);
  if (index !== -1) {
    list[index].read = true;
    writeJson(notificationsFile, list);
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