# swachh — Developer Handoff

Named after the Marathi/Hindi word for *clean* — स्वच्छ.

A standalone Electron desktop app for video editors to browse, tag, cull, and AI-analyze footage and stills across any project folder.

---

## Quick start

```bash
brew install ffmpeg          # required: metadata + thumbnails
cd ~/Documents/Projects/swachh
npm install
npm start
```

Build as macOS .app:
```bash
npm run build
# → dist/mac-arm64/swachh.app  (or mac-x64 on Intel)
```

Drag `swachh.app` to `/Applications` and pin to Dock.

---

## File structure

```
swachh/
├── main.js        Electron main process — all IPC handlers, file I/O, ffprobe, ffmpeg, AI analysis
├── preload.js     contextBridge — exposes safe API surface to renderer
├── index.html     Single-file SPA renderer — all UI, state, and JS
├── package.json   App metadata, electron-builder config
├── README.md      End-user docs
└── CLAUDE.md      This file
```

---

## Architecture

### Data model

Project data lives inside each project folder, not in the app:

```
<project-folder>/
└── .organizer/
    ├── clips.json       Metadata for every video and photo (read-only from UI)
    ├── user_data.json   Per-item user edits: tags, notes, starred, markedDelete, analysis
    ├── thumbnails/      JPEG thumbnails (400px wide, named by relativePath)
    └── previews/        Cached full-size JPEGs for raw/HEIC stills (rendered on first view)
```

**Key**: every item is keyed by `relativePath` (path relative to the project folder root). This is the canonical ID used everywhere — in clips.json, user_data.json, thumbnail filenames, and IPC messages.

**Media type**: each entry carries `mediaType: 'video' | 'photo'`. Videos and photos live in one `clips.json` and one `user_data.json`, which is what lets every action — tagging, starring, delete marks, multi-select, drag-out, AI analysis — work identically on both. The UI's Videos/Photos tabs are two filtered views over that single list. Entries written before photo support have no `mediaType`; `loadClips()` backfills `'video'` on read.

**Thumbnail naming**: `subdir__filename.jpg` (double underscore as separator) to flatten nested folder paths into a flat thumbnail directory. e.g. `Fujifilm/DSCF7312.MOV` → `Fujifilm__DSCF7312.jpg`. Photos append their source extension — `Fujifilm/DSCF7312.JPG` → `Fujifilm__DSCF7312_jpg.jpg` — because cameras put a stills file and a movie file with the same stem in the same folder.

App-level config (last used folder path, Anthropic API key) is stored separately in:
```
~/Library/Application Support/swachh/organizer-config.json
```

### Main process (main.js)

Key constants:
- `VIDEO_EXTS` — supported extensions: `.mov .mp4 .mts .m2ts .avi .mkv`
- `PHOTO_EXTS` — stills, including camera raw: `.jpg .jpeg .png .gif .webp .bmp .heic .heif .tif .tiff .raf .arw .cr2 .cr3 .nef .dng .orf .rw2 .raw .srw .pef`
- `WEB_IMAGE_EXTS` — the subset Chromium can put straight into an `<img>`; everything else is previewed through a cached JPEG
- `SKIP_DIRS` — directories never scanned: `.organizer thumbnails previews node_modules .Trash`
- `DATA_SUBDIR` = `'.organizer'`
- `CONFIG_PATH` — path to the user config JSON

Key functions:
- `getProjectPaths(projectFolder)` — returns `{ dataDir, thumbDir, previewDir, clipsJson, userDataJson, presetTagsJson }`
- `findMediaFiles(rootFolder)` — one recursive walk returning `{ videos, photos }`, skips hidden dirs and SKIP_DIRS
- `parseClip(filepath, projectFolder)` — ffprobe → structured metadata object with camera detection for iPhone/Blackmagic, Fujifilm X-E4, Sony XAVC
- `parsePhoto(filepath, projectFolder)` — same shape, built from `sips -g all` (dimensions, format, EXIF capture time) plus `mdimport -t -d3` (lens, aperture, ISO, shutter, focal length, GPS, orientation-corrected pixel dimensions)
- `generateThumbnail` / `generatePhotoThumbnail(filepath, thumbDir, relativePath)` — 400px-wide JPEG, via ffmpeg and sips respectively
- `ensurePhotoPreview(relativePath)` — renders and caches a 2400px JPEG for formats Chromium can't decode
- `mergeWithUserData(clips, userDataJson)` — merges clips.json with user_data.json, result includes `mediaType`, `tags`, `notes`, `starred`, `markedDelete`, `analysis`
- `extractFrames(filepath, duration, count=3)` — samples video at 20/50/80% duration, returns base64 JPEG array
- `extractPhotoFrame(filepath)` — renders one still to a 768px base64 JPEG for analysis
- `analyzeWithClaude(frames, apiKey, mediaType)` — calls Anthropic claude-haiku-4-5-20251001 vision API via `net.fetch`, returns `{ description, subjects, setting, activity, mood, suggestedTags }`

**Why sips/mdimport and not ffprobe for stills**: ffprobe can't open camera raw at all and reports HEIC's embedded thumbnail dimensions rather than the image's. `sips` decodes everything macOS Preview can. `mdls` would be the obvious EXIF reader but only answers for Spotlight-indexed files, which rules out most external footage drives — `mdimport -t -d3` runs the same importer directly against the file and works on unindexed volumes. Off macOS, `probePhotoSize()` falls back to ffprobe for dimensions (web formats only, no EXIF).

IPC handlers exposed to renderer:
- `app:check` — returns `{ projectFolder, clipsExist, ffprobeOk, ffmpegOk }`
- `folder:select` — opens system folder picker, saves to config
- `extraction:start` — starts metadata extraction + thumbnail generation for videos and photos (fires `extraction:progress` events). ffmpeg is only required when the folder contains videos
- `extraction:rescan` — re-runs extraction on existing project folder
- `clips:get` — returns merged clips array
- `clip:update` — updates user_data.json for one clip
- `clip:trash` — moves one clip to macOS Trash
- `clip:trash-multiple` — batch trash
- `clips:delete-list` — returns all clips marked for deletion
- `clip:show-in-finder` — shell-reveal in Finder
- `settings:get` — reads organizer-config.json
- `settings:set` — writes organizer-config.json
- `clip:analyze` — extracts frames + calls Claude API for one clip, saves result to user_data.json
- `clips:analyze-batch` — fire-and-forget batch analysis, emits `analysis:progress`, `analysis:result`, `analysis:complete` events
- `clips:analyze-cancel` — sets `analysisCancelled = true` flag to stop batch

### Custom Electron protocols

Registered as privileged schemes in `main.js` before `app.ready`:

- `local-video://` — serves video files with range-request support (required for `<video>` seeking). Uses `net.fetch(pathToFileURL(...))` to forward range headers.
- `local-thumb://` — serves thumbnail JPEGs from `.organizer/thumbnails/`.
- `local-photo://` — serves a full-size still: the original file for `WEB_IMAGE_EXTS`, otherwise a cached JPEG from `.organizer/previews/`, rendered by `ensurePhotoPreview()` on first request.

All three protocols take the URL-encoded `relativePath` as the host+path.

### Renderer (index.html)

Single-file SPA. No bundler — vanilla JS and CSS.

State object:
```js
state = {
  clips,           // every video and photo, merged with user data
  mediaTab,        // 'video' | 'photo' — which tab is being browsed
  filteredClips,   // result of applyFilters()
  selectedIndex,   // index into filteredClips
  groupBy,         // 'day' | 'camera' | 'folder' | 'none'
  sortBy,          // 'date' | 'duration' | 'name' | 'size'
  search,          // current search string
  filters,         // { cameras, days, focal, res, starred, blank, untagged }
  sidebarOpen,
  pendingDeleteList,
}
```

`activeMedia()` returns the clips belonging to `state.mediaTab`; `applyFilters()` starts from it, and so do the sidebar facet counts. Tags, stars and delete marks deliberately stay global, so a tag invented on a clip is one click away on a photo. `setMediaTab()` clears the facet filters on switch (their values are per-media, so keeping them would silently empty the other tab) and `syncMediaTabUI()` hides the video-only affordances: duration sorting, the Blank filter, the LUT preview, and the transport/speed controls under the preview.

Key flows:
1. **Boot**: `boot()` → `app:check` → show setup/loading/app
2. **Extraction**: `extraction:start` → listen for `extraction:progress` events → `loadAndShowApp()`
3. **Rendering**: `applyFilters()` → `renderGrid()` → `makeCard()` per clip
4. **Detail panel**: `selectClip(idx)` populates all sections including analysis display; photos swap the `<video>` for `#detail-photo` and show dimensions/megapixels/format instead of duration/FPS/codec
5. **AI analysis**: `analyzeCurrentClip()` or `analyzeAll()` → IPC → main.js → Anthropic API → `analysis:result` event updates `state.clips` in-place

---

## AI Analysis

Uses `claude-haiku-4-5-20251001` via the Anthropic API (vision).

Flow:
1. `extractFrames()` in main.js samples the video at 20%, 50%, 80% of duration using ffmpeg → temp JPEG files → base64 strings
2. `analyzeWithClaude()` sends frames to the API with a structured prompt requesting JSON: `{ description, subjects, setting, activity, mood, suggestedTags }`
3. Result saved to `user_data.json` under `ud[relativePath].analysis` (includes `analyzedAt` timestamp)
4. Renderer receives via `analysis:result` IPC event and updates the display

The API key is stored in `organizer-config.json` (never in code or clips.json). It's loaded via `settings:get` IPC on app startup.

Batch analysis uses a fire-and-forget pattern with a `analysisCancelled` flag in main.js scope. The renderer triggers the batch and listens for progress/result/complete events.

---

## Known limitations / future work

- **ffprobe camera detection is heuristic** — Sony and Fujifilm detection works on known naming conventions; other cameras fall through to "Unknown"
- **AI analysis frame sampling is fixed at 3 frames** — for long clips, more frames would give better results
- **Thumbnails are generated once** — rescanning adds new clips but doesn't regenerate existing thumbnails; delete `.organizer/thumbnails/` to force regeneration
- **Photo metadata is macOS-only** — `sips`/`mdimport` give full EXIF there; elsewhere stills fall back to ffprobe dimensions with no EXIF, and raw/HEIC can't be read at all
- **Existing projects need a rescan** — a `clips.json` written before photo support contains no stills, so the Photos tab stays empty until 🔄 Rescan
- **Analysis search** — analysis text is included in the search filter but the grid cards don't visually indicate analyzed clips

---

## Dependencies

- `electron` 29.4.6
- `electron-builder` 24.13.3
- `ffmpeg` + `ffprobe` (system, via Homebrew)
- Anthropic API (claude-haiku-4-5-20251001) — optional, for AI analysis only
