// ─────────────────────────────────────────────────────────────────────────────
// swachh — Electron Main Process
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, protocol, shell, net, nativeTheme, dialog } = require('electron');
const path   = require('path');
const fs     = require('fs');
const os     = require('os');
const cp     = require('child_process');
const { promisify } = require('util');
const { pathToFileURL } = require('url');

const execFileAsync = promisify(cp.execFile);

// ── Enable hardware video decode (HEVC/H.265 on macOS via VideoToolbox) ───────
// Must be called before app.whenReady()
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'PlatformHEVCVideoDecoder,PlatformHEVCDecoderSupport');
  app.commandLine.appendSwitch('enable-features', 'VideoDecodeOnGPU');
}

// ── Constants ─────────────────────────────────────────────────────────────────
const VIDEO_EXTS   = new Set(['.mov', '.mp4', '.mts', '.m2ts', '.avi', '.mkv']);
const SKIP_DIRS    = new Set(['.organizer', 'thumbnails', 'node_modules', '.Trash', '$RECYCLE.BIN']);
const CONFIG_PATH  = path.join(app.getPath('userData'), 'organizer-config.json');
const DATA_SUBDIR  = '.organizer'; // inside the chosen project folder

// ── Register custom protocols BEFORE app is ready ────────────────────────────
protocol.registerSchemesAsPrivileged([
  { scheme: 'local-video', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
  { scheme: 'local-thumb', privileges: { secure: true } },
]);

// ── Config persistence ────────────────────────────────────────────────────────
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function saveConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...loadConfig(), ...data }, null, 2));
}

// ── Derived paths from project folder ────────────────────────────────────────
function getProjectPaths(projectFolder) {
  const dataDir      = path.join(projectFolder, DATA_SUBDIR);
  const thumbDir     = path.join(dataDir, 'thumbnails');
  const clipsJson    = path.join(dataDir, 'clips.json');
  const userDataJson = path.join(dataDir, 'user_data.json');
  return { dataDir, thumbDir, clipsJson, userDataJson };
}

// ── Find ffprobe / ffmpeg — bundled binary first, system fallback ─────────────
function findBinary(name) {
  // 1. Bundled binary (inside .app via extraResources)
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, 'bin', name);
    if (fs.existsSync(bundled)) return bundled;
  }

  // 2. System install (dev mode / fallback)
  const candidates = [
    `/opt/homebrew/bin/${name}`,   // Homebrew ARM (M1/M2/M3)
    `/usr/local/bin/${name}`,       // Homebrew Intel
    `/usr/bin/${name}`,
  ];
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  try {
    const found = cp.execSync(`which ${name}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (found) return found;
  } catch {}
  return null;
}

let FFPROBE = null;
let FFMPEG  = null;

// ── Extraction state ──────────────────────────────────────────────────────────
let extractionStatus = {
  running: false, done: 0, total: 0, current: '', complete: false, errors: [],
};
let mainWindow     = null;
let PROJECT_FOLDER = null; // set when user picks a folder
let analysisCancelled = false;

// ── Recursive video file discovery ───────────────────────────────────────────
function findVideoFiles(rootFolder) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name))  continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) {
        results.push(full);
      }
    }
  }
  walk(rootFolder);
  return results.sort();
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function loadClips(projectFolder) {
  const { clipsJson } = getProjectPaths(projectFolder);
  if (!fs.existsSync(clipsJson)) return { clips: [], errors: [] };
  try { return JSON.parse(fs.readFileSync(clipsJson, 'utf8')); }
  catch { return { clips: [], errors: [] }; }
}

function loadUserData(projectFolder) {
  const { userDataJson } = getProjectPaths(projectFolder);
  if (!fs.existsSync(userDataJson)) return {};
  try { return JSON.parse(fs.readFileSync(userDataJson, 'utf8')); }
  catch { return {}; }
}

function saveUserData(projectFolder, data) {
  const { userDataJson } = getProjectPaths(projectFolder);
  fs.writeFileSync(userDataJson, JSON.stringify(data, null, 2));
}

function mergeWithUserData(clips, projectFolder) {
  const ud = loadUserData(projectFolder);
  return clips.map(c => ({
    ...c,
    tags:         (ud[c.relativePath] || {}).tags         ?? [],
    notes:        (ud[c.relativePath] || {}).notes        ?? '',
    starred:      (ud[c.relativePath] || {}).starred      ?? false,
    markedDelete: (ud[c.relativePath] || {}).markedDelete ?? false,
    analysis:     (ud[c.relativePath] || {}).analysis     ?? null,
  }));
}

// ── Thumbnail filename (handles nested paths) ─────────────────────────────────
function thumbName(relativePath) {
  // "subdir/DSCF1234.MOV" → "subdir__DSCF1234.jpg"
  const stem = relativePath.replace(/[\/\\]/g, '__').replace(/\.[^.]+$/, '');
  return `${stem}.jpg`;
}

// ── Parse clip metadata ───────────────────────────────────────────────────────
async function parseClip(filepath, projectFolder) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filepath,
  ], { maxBuffer: 4 * 1024 * 1024 });

  const data   = JSON.parse(stdout);
  const fmt    = data.format || {};
  const tags   = fmt.tags   || {};
  const vs     = (data.streams || []).find(s => s.codec_type === 'video') || {};

  const duration = parseFloat(fmt.duration || 0);
  const size     = parseInt(fmt.size       || 0);
  const width    = vs.width  || 0;
  const height   = vs.height || 0;
  const codec    = vs.codec_name || 'unknown';

  // FPS
  let fps = 0;
  const [fn, fd] = (vs.r_frame_rate || '0/1').split('/').map(Number);
  if (fd) fps = Math.round((fn / fd) * 100) / 100;

  // Camera detection
  let cameraType = 'unknown', camera = 'Unknown', lens = '', focalLength = '';
  let aperture = '', iso = '', shutter = '', whiteBalance = '', lut = '';
  let dayNight = '', environment = '', gps = null, dateRaw = '';

  if (tags['com.blackmagic-design.camera.lensType']) {
    cameraType   = 'iphone';
    const lensRaw = tags['com.blackmagic-design.camera.lensType'] || '';
    const flM     = lensRaw.match(/(\d+)mm/);
    focalLength  = flM ? `${flM[1]}mm` : lensRaw;
    lens         = lensRaw;
    camera       = 'iPhone 16 Pro Max';
    aperture     = tags['com.blackmagic-design.camera.aperture']           || '';
    iso          = tags['com.blackmagic-design.camera.iso']                || '';
    shutter      = tags['com.blackmagic-design.shutterSpeed']              || '';
    const wb     = tags['com.blackmagic-design.camera.whiteBalanceKelvin'] || '';
    whiteBalance = wb ? `${wb}K` : '';
    lut          = (tags['com.blackmagic-design.camera.look.LUTName'] || '').replace('.cube', '');
    dayNight     = tags['com.blackmagic-design.camera.dayNight']           || '';
    environment  = tags['com.blackmagic-design.camera.environment']        || '';
    const gpsRaw = tags['com.apple.quicktime.location.ISO6709'] || '';
    const gm     = gpsRaw.match(/([+-]\d+\.\d+)([+-]\d+\.\d+)/);
    if (gm) gps  = { lat: parseFloat(gm[1]), lng: parseFloat(gm[2]) };
    dateRaw      = tags['com.blackmagic-design.camera.dateRecorded']
                || tags['com.apple.quicktime.creationdate'] || '';
  } else if ((tags.comment || tags['comment-eng'] || '').includes('FUJIFILM')) {
    cameraType = 'fujifilm';
    camera     = 'Fujifilm X-E4';
    dateRaw    = tags.creation_time || '';
  } else if ((tags.major_brand || '').includes('XAVC') || path.basename(filepath).match(/^C\d{4}/i)) {
    cameraType = 'sony';
    camera     = 'Sony (XAVC)';
    dateRaw    = tags.creation_time || '';
  } else {
    // Unknown — use whatever we can find
    camera  = tags['com.apple.quicktime.model'] || tags.comment || 'Unknown';
    dateRaw = tags.creation_time || tags['com.apple.quicktime.creationdate'] || '';
  }

  // Parse day in JST
  let day = '';
  if (dateRaw) {
    try {
      const clean = dateRaw.replace('+0900', '+09:00');
      if (clean.includes('+09:00')) {
        day = clean.substring(0, 10);
      } else if (clean.endsWith('Z')) {
        const utcMs = new Date(clean).getTime();
        day = new Date(utcMs + 9 * 3600 * 1000).toISOString().substring(0, 10);
      } else {
        day = clean.substring(0, 10);
      }
    } catch {}
  }
  // Fallback: A001 filename encodes date MMDD
  if (!day) {
    const m = path.basename(filepath).match(/A001_(\d{2})(\d{2})\d{4}_/);
    if (m) day = `2026-${m[1]}-${m[2]}`;
  }
  // Fallback: file mtime
  if (!day) {
    day = new Date(fs.statSync(filepath).mtime).toISOString().substring(0, 10);
  }

  const relativePath = path.relative(projectFolder, filepath);

  return {
    filename:     path.basename(filepath),
    relativePath,                            // key used in user_data.json
    subfolder:    path.dirname(relativePath) === '.' ? '' : path.dirname(relativePath),
    duration:     Math.round(duration * 100) / 100,
    size, width, height, fps, codec,
    date: dateRaw, day,
    cameraType, camera, focalLength, lens,
    aperture, iso, shutter, whiteBalance, lut,
    dayNight, environment, gps,
    thumbnail:    thumbName(relativePath),
    isBlankCandidate: duration < 3.0,
  };
}

// ── Generate thumbnail ────────────────────────────────────────────────────────
async function generateThumbnail(filepath, thumbDir, relativePath) {
  const outPath = path.join(thumbDir, thumbName(relativePath));
  if (fs.existsSync(outPath)) return true;
  // Ensure subdirectory exists
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  for (const seek of ['1', '0']) {
    try {
      await execFileAsync(FFMPEG, [
        '-y', '-ss', seek, '-i', filepath,
        '-vframes', '1', '-vf', 'scale=400:-1', '-q:v', '5', outPath,
      ], { timeout: 20000 });
      if (fs.existsSync(outPath)) return true;
    } catch {}
  }
  return false;
}

// ── AI Analysis ───────────────────────────────────────────────────────────────

// Extract N frames from a video as base64 JPEGs
async function extractFrames(filepath, duration, count = 3) {
  const frames = [];
  const d      = Math.max(duration || 5, 1);
  // Sample at 20%, 50%, 80% of clip — avoids black frames at start/end
  const times  = count === 1
    ? [d * 0.5]
    : Array.from({ length: count }, (_, i) => d * (0.2 + i * 0.3));

  for (const t of times) {
    const tmp = path.join(os.tmpdir(), `swachh_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
      await execFileAsync(FFMPEG, [
        '-y', '-ss', String(t), '-i', filepath,
        '-vframes', '1', '-vf', 'scale=512:-1', '-q:v', '5', tmp,
      ], { timeout: 15000 });
      if (fs.existsSync(tmp)) {
        frames.push(fs.readFileSync(tmp).toString('base64'));
        fs.unlinkSync(tmp);
      }
    } catch {}
  }
  return frames;
}

// Send frames to Claude API and get structured analysis back
async function analyzeWithClaude(frames, apiKey) {
  const body = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        ...frames.map(data => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data },
        })),
        {
          type: 'text',
          text: `These are ${frames.length} frames sampled from a video clip. Analyze the scene and respond with ONLY valid JSON (no markdown, no explanation) in this exact format:
{
  "description": "one concise sentence describing the scene",
  "subjects": ["main", "subjects", "visible"],
  "setting": "location or environment type",
  "activity": "what is happening",
  "mood": "atmosphere or mood",
  "suggestedTags": ["2 to 4 short tags"]
}`,
        },
      ],
    }],
  };

  const res = await net.fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${err}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text?.trim() || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in API response');
  return {
    analysis:     JSON.parse(match[0]),
    inputTokens:  data.usage?.input_tokens  || 0,
    outputTokens: data.usage?.output_tokens || 0,
  };
}

// ── Extraction orchestration ──────────────────────────────────────────────────
async function runExtraction(projectFolder) {
  extractionStatus = { running: true, done: 0, total: 0, current: '', complete: false, errors: [] };

  try {
    const { dataDir, thumbDir, clipsJson } = getProjectPaths(projectFolder);
    fs.mkdirSync(dataDir,  { recursive: true });
    fs.mkdirSync(thumbDir, { recursive: true });

    const files = findVideoFiles(projectFolder);
    extractionStatus.total = files.length;
    mainWindow?.webContents.send('extraction:progress', { ...extractionStatus });

    const clips = [];
    const BATCH = 6;

    for (let i = 0; i < files.length; i += BATCH) {
      const batch   = files.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(fp =>
          parseClip(fp, projectFolder)
            .then(meta =>
              generateThumbnail(fp, thumbDir, meta.relativePath)
                .then(() => meta)
            )
        )
      );
      for (let j = 0; j < results.length; j++) {
        extractionStatus.done++;
        extractionStatus.current = path.basename(batch[j]);
        if (results[j].status === 'fulfilled' && results[j].value) {
          clips.push(results[j].value);
        } else {
          extractionStatus.errors.push(path.relative(projectFolder, batch[j]));
          console.error('Extraction error:', results[j].reason);
        }
      }
      mainWindow?.webContents.send('extraction:progress', { ...extractionStatus });
    }

    clips.sort((a, b) => {
      const d = (a.day || '').localeCompare(b.day || '');
      return d || (a.date || a.relativePath).localeCompare(b.date || b.relativePath);
    });

    const { clipsJson: cj } = getProjectPaths(projectFolder);
    fs.writeFileSync(cj, JSON.stringify(
      { clips, errors: extractionStatus.errors, generated: new Date().toISOString() },
      null, 2
    ));
  } catch (err) {
    console.error('[runExtraction] fatal error:', err);
    extractionStatus.errors.push(`Fatal: ${err.message}`);
  }

  // Always mark complete so the UI doesn't hang on the loading screen
  extractionStatus.running  = false;
  extractionStatus.complete = true;
  mainWindow?.webContents.send('extraction:progress', { ...extractionStatus });
}

// ── IPC handlers ──────────────────────────────────────────────────────────────
function setupIPC() {
  // App startup check
  ipcMain.handle('app:check', () => {
    FFPROBE = findBinary('ffprobe');
    FFMPEG  = findBinary('ffmpeg');
    const cfg = loadConfig();
    PROJECT_FOLDER = cfg.projectFolder || null;
    return {
      ffprobeOk:     !!FFPROBE,
      ffmpegOk:      !!FFMPEG,
      projectFolder: PROJECT_FOLDER,
      clipsExist:    PROJECT_FOLDER && fs.existsSync(getProjectPaths(PROJECT_FOLDER).clipsJson),
    };
  });

  // Folder picker
  ipcMain.handle('folder:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select your video project folder',
      buttonLabel: 'Use This Folder',
    });
    if (result.canceled || !result.filePaths.length) return null;

    const folder = result.filePaths[0];
    PROJECT_FOLDER = folder;
    saveConfig({ projectFolder: folder });

    const { clipsJson } = getProjectPaths(folder);
    return {
      folder,
      videoCount: findVideoFiles(folder).length,
      clipsExist: fs.existsSync(clipsJson),
    };
  });

  // Start extraction
  ipcMain.handle('extraction:start', () => {
    if (!PROJECT_FOLDER) return { error: 'No project folder set' };
    if (extractionStatus.running) return { alreadyRunning: true };
    if (!FFPROBE || !FFMPEG)
      return { error: 'ffprobe/ffmpeg not found.\nInstall via Terminal: brew install ffmpeg' };
    runExtraction(PROJECT_FOLDER); // fire and forget
    return { started: true };
  });

  ipcMain.handle('extraction:status', () => ({ ...extractionStatus }));

  // Get all clips (merged with user data)
  ipcMain.handle('clips:get', () => {
    if (!PROJECT_FOLDER) return [];
    const { clips } = loadClips(PROJECT_FOLDER);
    return mergeWithUserData(clips, PROJECT_FOLDER);
  });

  // Update clip annotations
  ipcMain.handle('clip:update', (_, relativePath, updates) => {
    if (!PROJECT_FOLDER) return { ok: false };
    const ud = loadUserData(PROJECT_FOLDER);
    ud[relativePath] = ud[relativePath] || {};
    for (const key of ['tags', 'notes', 'starred', 'markedDelete']) {
      if (key in updates) ud[relativePath][key] = updates[key];
    }
    saveUserData(PROJECT_FOLDER, ud);
    return { ok: true };
  });

  // Trash single clip
  ipcMain.handle('clip:trash', async (_, relativePath) => {
    if (!PROJECT_FOLDER) return { ok: false };
    const fp = path.join(PROJECT_FOLDER, relativePath);
    if (!fs.existsSync(fp)) return { ok: false, error: 'File not found' };
    await shell.trashItem(fp);
    // Remove from clips.json
    const d = loadClips(PROJECT_FOLDER);
    d.clips = d.clips.filter(c => c.relativePath !== relativePath);
    fs.writeFileSync(getProjectPaths(PROJECT_FOLDER).clipsJson, JSON.stringify(d, null, 2));
    // Remove from user_data.json
    const ud = loadUserData(PROJECT_FOLDER);
    delete ud[relativePath];
    saveUserData(PROJECT_FOLDER, ud);
    return { ok: true };
  });

  // Trash multiple clips (after delete review)
  ipcMain.handle('clip:trash-multiple', async (_, relativePaths) => {
    if (!PROJECT_FOLDER) return { ok: false, trashed: [] };
    const trashed = [];
    for (const rp of relativePaths) {
      const fp = path.join(PROJECT_FOLDER, rp);
      if (fs.existsSync(fp)) {
        await shell.trashItem(fp);
        trashed.push(rp);
      }
    }
    const d  = loadClips(PROJECT_FOLDER);
    const rm = new Set(trashed);
    d.clips  = d.clips.filter(c => !rm.has(c.relativePath));
    fs.writeFileSync(getProjectPaths(PROJECT_FOLDER).clipsJson, JSON.stringify(d, null, 2));
    const ud = loadUserData(PROJECT_FOLDER);
    for (const rp of trashed) delete ud[rp];
    saveUserData(PROJECT_FOLDER, ud);
    return { ok: true, trashed };
  });

  // Get list of clips marked for deletion
  ipcMain.handle('clips:delete-list', () => {
    if (!PROJECT_FOLDER) return [];
    const ud = loadUserData(PROJECT_FOLDER);
    const { clips } = loadClips(PROJECT_FOLDER);
    return clips
      .filter(c => (ud[c.relativePath] || {}).markedDelete)
      .map(c => ({ relativePath: c.relativePath, filename: c.filename, duration: c.duration }));
  });

  // Reveal in Finder
  ipcMain.handle('clip:show-in-finder', (_, relativePath) => {
    if (!PROJECT_FOLDER) return;
    shell.showItemInFolder(path.join(PROJECT_FOLDER, relativePath));
  });

  // Re-scan existing folder (for after adding new clips)
  ipcMain.handle('extraction:rescan', () => {
    if (!PROJECT_FOLDER) return { error: 'No project folder set' };
    if (extractionStatus.running) return { alreadyRunning: true };
    if (!FFPROBE || !FFMPEG)
      return { error: 'ffprobe/ffmpeg not found. Install: brew install ffmpeg' };
    runExtraction(PROJECT_FOLDER);
    return { started: true };
  });

  // ── Settings (API key stored in app config) ──────────────────────────────
  ipcMain.handle('settings:get', () => {
    const cfg = loadConfig();
    return {
      apiKey:  cfg.apiKey  || '',
      lutPath: cfg.lutPath || null,
      usage:   cfg.usage   || { inputTokens: 0, outputTokens: 0, clipsAnalyzed: 0 },
    };
  });

  // LUT — open file picker, return path
  ipcMain.handle('lut:select', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: 'Select a .cube LUT file',
      filters: [{ name: 'LUT files', extensions: ['cube'] }],
    });
    if (result.canceled || !result.filePaths.length) return null;
    const lutPath = result.filePaths[0];
    saveConfig({ lutPath });
    return lutPath;
  });

  // LUT — read file contents (renderer parses + uploads to WebGL)
  ipcMain.handle('lut:read', (_, filePath) => {
    if (!filePath) return null;
    try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  });

  // LUT — clear saved path
  ipcMain.handle('lut:clear', () => {
    saveConfig({ lutPath: null });
    return { ok: true };
  });

  ipcMain.handle('settings:set', (_, settings) => {
    saveConfig(settings);
    return { ok: true };
  });

  ipcMain.handle('settings:reset-usage', () => {
    saveConfig({ usage: { inputTokens: 0, outputTokens: 0, clipsAnalyzed: 0 } });
    return { ok: true };
  });

  // ── Analyze single clip ───────────────────────────────────────────────────
  ipcMain.handle('clip:analyze', async (_, relativePath) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) return { error: 'Add your Anthropic API key in Settings (⚙) first.' };
    if (!PROJECT_FOLDER) return { error: 'No project folder set' };
    if (!FFMPEG) return { error: 'ffmpeg not found' };

    const filepath = path.join(PROJECT_FOLDER, relativePath);
    if (!fs.existsSync(filepath)) return { error: 'File not found' };

    const { clips } = loadClips(PROJECT_FOLDER);
    const clip = clips.find(c => c.relativePath === relativePath);

    try {
      const frames = await extractFrames(filepath, clip?.duration ?? 10);
      if (!frames.length) return { error: 'Could not extract frames from video' };

      const { analysis, inputTokens, outputTokens } = await analyzeWithClaude(frames, cfg.apiKey);
      analysis.analyzedAt = new Date().toISOString();

      // Persist to .organizer/user_data.json in the project folder
      const ud = loadUserData(PROJECT_FOLDER);
      ud[relativePath]          = ud[relativePath] || {};
      ud[relativePath].analysis = analysis;
      saveUserData(PROJECT_FOLDER, ud);

      // Accumulate usage stats in config
      const u = loadConfig().usage || { inputTokens: 0, outputTokens: 0, clipsAnalyzed: 0 };
      saveConfig({ usage: { inputTokens: u.inputTokens + inputTokens, outputTokens: u.outputTokens + outputTokens, clipsAnalyzed: u.clipsAnalyzed + 1 } });

      return { ok: true, analysis };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ── Batch analyze clips ───────────────────────────────────────────────────
  ipcMain.handle('clips:analyze-batch', (_, relativePaths) => {
    const cfg = loadConfig();
    if (!cfg.apiKey) return { error: 'Add your Anthropic API key in Settings first.' };
    if (!PROJECT_FOLDER) return { error: 'No project folder set' };
    analysisCancelled = false;

    // Fire and forget — progress via IPC events
    (async () => {
      const { clips } = loadClips(PROJECT_FOLDER);
      const clipMap   = Object.fromEntries(clips.map(c => [c.relativePath, c]));
      let done = 0;

      for (const rp of relativePaths) {
        if (analysisCancelled) break;

        mainWindow?.webContents.send('analysis:progress', {
          done, total: relativePaths.length, current: path.basename(rp),
        });

        try {
          const filepath = path.join(PROJECT_FOLDER, rp);
          const clip     = clipMap[rp];
          const frames   = await extractFrames(filepath, clip?.duration ?? 10);
          if (!frames.length) throw new Error('no frames');

          const { analysis, inputTokens, outputTokens } = await analyzeWithClaude(frames, cfg.apiKey);
          analysis.analyzedAt = new Date().toISOString();

          const ud = loadUserData(PROJECT_FOLDER);
          ud[rp]          = ud[rp] || {};
          ud[rp].analysis = analysis;
          saveUserData(PROJECT_FOLDER, ud);

          // Accumulate usage
          const u = loadConfig().usage || { inputTokens: 0, outputTokens: 0, clipsAnalyzed: 0 };
          saveConfig({ usage: { inputTokens: u.inputTokens + inputTokens, outputTokens: u.outputTokens + outputTokens, clipsAnalyzed: u.clipsAnalyzed + 1 } });

          mainWindow?.webContents.send('analysis:result', { relativePath: rp, analysis });
        } catch (e) {
          mainWindow?.webContents.send('analysis:error', { relativePath: rp, error: e.message });
        }

        done++;
        // Brief pause to avoid hammering the API
        await new Promise(r => setTimeout(r, 300));
      }

      mainWindow?.webContents.send('analysis:complete', {
        done, total: relativePaths.length, cancelled: analysisCancelled,
      });
    })();

    return { started: true };
  });

  ipcMain.handle('clips:analyze-cancel', () => {
    analysisCancelled = true;
    return { ok: true };
  });
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  nativeTheme.themeSource = 'dark';
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    minWidth: 960, minHeight: 640,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  // mainWindow.webContents.openDevTools(); // uncomment to debug renderer
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Serve video files via custom protocol (supports HTTP Range for seeking)
  // URL format: local-video://v/<segment1>/<segment2>/...
  // Each path segment is individually encodeURIComponent'd in preload.js so that
  // slashes stay as real path separators — avoiding the Chromium hostname-lowercasing
  // bug that would corrupt case-sensitive filenames.
  protocol.handle('local-video', async request => {
    if (!PROJECT_FOLDER) return new Response(null, { status: 403 });
    try {
      const url      = new URL(request.url);
      // pathname = /segment1/segment2 — decode each segment separately
      const relPath  = url.pathname.slice(1).split('/').map(decodeURIComponent).join('/');
      const filepath = path.join(PROJECT_FOLDER, relPath);
      if (!path.resolve(filepath).startsWith(path.resolve(PROJECT_FOLDER)))
        return new Response(null, { status: 403 });
      if (!fs.existsSync(filepath))
        return new Response(null, { status: 404 });
      // Forward Range header so <video> seeking works
      return net.fetch(pathToFileURL(filepath).toString(), { headers: request.headers });
    } catch (e) {
      console.error('[local-video]', e.message);
      return new Response(null, { status: 500 });
    }
  });

  // Serve thumbnails
  protocol.handle('local-thumb', async request => {
    if (!PROJECT_FOLDER) return new Response(null, { status: 403 });
    try {
      const url      = new URL(request.url);
      const filename = decodeURIComponent(url.pathname.slice(1));
      const { thumbDir } = getProjectPaths(PROJECT_FOLDER);
      const filepath = path.join(thumbDir, filename);
      if (!path.resolve(filepath).startsWith(path.resolve(thumbDir)))
        return new Response(null, { status: 403 });
      if (!fs.existsSync(filepath))
        return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(filepath).toString());
    } catch (e) {
      console.error('[local-thumb]', e.message);
      return new Response(null, { status: 500 });
    }
  });

  setupIPC();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
