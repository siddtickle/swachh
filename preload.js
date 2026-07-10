// ─────────────────────────────────────────────────────────────────────────────
// swachh — Preload (contextBridge)
// ─────────────────────────────────────────────────────────────────────────────

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('organizer', {
  // ── App init ──────────────────────────────────────────────────────────────
  check:          ()               => ipcRenderer.invoke('app:check'),

  // ── Folder selection ──────────────────────────────────────────────────────
  selectFolder:   ()               => ipcRenderer.invoke('folder:select'),

  // ── Extraction ───────────────────────────────────────────────────────────
  startExtraction: ()              => ipcRenderer.invoke('extraction:start'),
  rescan:          ()              => ipcRenderer.invoke('extraction:rescan'),
  getExtractionStatus: ()          => ipcRenderer.invoke('extraction:status'),
  onExtractionProgress: (cb) => {
    const fn = (_, data) => cb(data);
    ipcRenderer.on('extraction:progress', fn);
    return () => ipcRenderer.removeListener('extraction:progress', fn);
  },

  // ── Clips data ────────────────────────────────────────────────────────────
  getClips:       ()                          => ipcRenderer.invoke('clips:get'),
  updateClip:     (relativePath, updates)     => ipcRenderer.invoke('clip:update', relativePath, updates),
  trashClip:      (relativePath)              => ipcRenderer.invoke('clip:trash', relativePath),
  trashMultiple:  (relativePaths)             => ipcRenderer.invoke('clip:trash-multiple', relativePaths),
  getDeleteList:  ()                          => ipcRenderer.invoke('clips:delete-list'),
  showInFinder:   (relativePath)              => ipcRenderer.invoke('clip:show-in-finder', relativePath),

  // ── Settings ──────────────────────────────────────────────────────────────
  getSettings:    ()               => ipcRenderer.invoke('settings:get'),
  saveSettings:   (s)              => ipcRenderer.invoke('settings:set', s),
  resetUsage:     ()               => ipcRenderer.invoke('settings:reset-usage'),

  // ── LUT ───────────────────────────────────────────────────────────────────
  selectLut:      ()               => ipcRenderer.invoke('lut:select'),
  readLut:        (p)              => ipcRenderer.invoke('lut:read', p),
  clearLut:       ()               => ipcRenderer.invoke('lut:clear'),

  // ── AI Analysis ───────────────────────────────────────────────────────────
  analyzeClip:    (relativePath)   => ipcRenderer.invoke('clip:analyze', relativePath),
  analyzeBatch:   (relativePaths)  => ipcRenderer.invoke('clips:analyze-batch', relativePaths),
  cancelAnalysis: ()               => ipcRenderer.invoke('clips:analyze-cancel'),

  onAnalysisProgress: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('analysis:progress', fn);
    return () => ipcRenderer.removeListener('analysis:progress', fn);
  },
  onAnalysisResult: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('analysis:result', fn);
    return () => ipcRenderer.removeListener('analysis:result', fn);
  },
  onAnalysisComplete: (cb) => {
    const fn = (_, d) => cb(d);
    ipcRenderer.on('analysis:complete', fn);
    return () => ipcRenderer.removeListener('analysis:complete', fn);
  },

  // ── URL helpers ───────────────────────────────────────────────────────────
  // Use a fixed host ('v') so the path portion is never lowercased by Chromium.
  // Encode each path segment individually so real slashes remain as separators.
  videoUrl: (relativePath)  => `local-video://v/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
  thumbUrl: (thumbFilename) => `local-thumb://v/${encodeURIComponent(thumbFilename)}`,
});
