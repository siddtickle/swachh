# swachh

A video organizer for editors. Browse, tag, and cull footage across any project folder.

Named after the Marathi/Hindi word for *clean* — स्वच्छ.

---

## What it does

swachh scans a folder of video clips, pulls out metadata (camera, date, focal length, ISO, etc.), generates thumbnail previews, and gives you a fast grid view to browse, tag, star, and cull your footage. It works completely offline — your files never leave your computer.

---

## Installation (step by step, no coding experience needed)

### Step 1 — Download the app

1. Go to the GitHub page for this project
2. Click the green **Code** button near the top right
3. Click **Download ZIP**
4. Once it downloads, double-click the ZIP file to unzip it
5. Move the unzipped folder (called `swachh-main` or similar) somewhere you'll remember — your Desktop or Documents folder works fine

### Step 2 — Open Terminal

Terminal is a built-in Mac app that lets you type commands. You don't need to know how to code — you'll just be copying and pasting the commands below.

To open Terminal:
- Press **⌘ + Space** to open Spotlight, type `Terminal`, and press Enter
- Or find it in **Applications → Utilities → Terminal**

### Step 3 — Install Homebrew (if you don't have it)

Homebrew is a free tool that makes it easy to install software on a Mac. You only need to do this once.

In Terminal, paste this and press Enter:

```
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It will ask for your Mac password. Type it (nothing will appear as you type — that's normal) and press Enter. Wait for it to finish — this can take a few minutes.

> **Already have Homebrew?** You can skip this step. If you're not sure, paste `brew --version` in Terminal and press Enter. If you see a version number, you're good.

### Step 4 — Install Node.js and ffmpeg

Node.js is what runs the app. ffmpeg is what reads video files. In Terminal, paste each line and press Enter, waiting for each to finish before doing the next:

```
brew install node
```

```
brew install ffmpeg
```

These are free and widely used — ffmpeg alone is used by YouTube, VLC, and thousands of other apps.

### Step 5 — Navigate to the swachh folder

In Terminal, type `cd ` (with a space after it), then drag the swachh folder from Finder directly into the Terminal window. The folder path will appear automatically. Press Enter.

It should look something like:

```
cd /Users/yourname/Desktop/swachh-main
```

### Step 6 — Install swachh's dependencies

Still in Terminal, paste this and press Enter:

```
npm install
```

This downloads the libraries swachh needs to run. It only needs to happen once. You'll see a lot of text scroll by — that's normal. Wait for it to finish (you'll see your cursor come back).

### Step 7 — Run swachh

```
npm start
```

The app will open. On first launch, click **Choose Project Folder** and point it at a folder containing video clips. swachh will scan everything recursively and generate thumbnails — this takes a minute or two depending on how much footage you have.

**Next time** you want to open swachh, just open Terminal, navigate to the folder again (Step 5), and run `npm start`.

---

## Optional: Build it as a proper Mac app (so you can put it in your Dock)

If you'd rather double-click to open swachh like any other Mac app:

```
npm run build
```

This creates a file at `dist/mac-arm64/swachh.app`. Drag that file to your `/Applications` folder, then drag it from there to your Dock.

> **Note:** Because swachh isn't distributed through the Mac App Store, macOS may warn you the first time you open it. To get past this: right-click `swachh.app` → **Open** → **Open** again in the dialog.

---

## Optional: AI clip analysis

swachh can analyze your video clips using AI and write a description of what's happening in each clip — useful for finding footage later or getting a quick overview of a shoot.

To use this feature:
1. Get a free API key from [console.anthropic.com](https://console.anthropic.com) (you'll need to create an account and add a small amount of credit — analyzing a full shoot of ~400 clips costs roughly $1–2)
2. In swachh, click the **⚙ Settings** gear icon in the top right
3. Paste your API key and click Save
4. Open any clip and click **Analyze** — or use **Analyze All** to run on every clip at once

Your API key is stored privately on your computer and never sent anywhere except directly to Anthropic's servers.

---

## Project data

When you open a folder, swachh creates a hidden `.organizer/` subfolder inside it containing thumbnails, metadata, and your tags and notes. This data travels with your footage — if you copy the folder to an external drive, your tags come with it.

You can safely delete `.organizer/` to start completely fresh.

---

## Features

| | |
|---|---|
| Group by | Day, Camera, Folder |
| Filter by | Camera type, focal length, resolution, date |
| Per-clip | Tags, notes, star, mark for deletion |
| Delete flow | Mark → review list → confirm → moves to Trash |
| Camera metadata | Aperture, ISO, shutter, white balance, LUT (Blackmagic/iPhone clips) |
| GPS | Links to Google Maps for geotagged clips |

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `D` | Mark / unmark for deletion |
| `S` | Star clip |
| `T` | Focus tag input |
| `← →` | Previous / next clip |
| `Space` | Play / pause |
| `F` | Toggle filter sidebar |
| `Esc` | Close detail panel |

---

## Supported cameras

Tested with:

- **iPhone via Blackmagic Cam** — full metadata (lens, aperture, ISO, shutter, WB, LUT, GPS, day/night)
- **Fujifilm X-E4** — date, resolution
- **Sony XAVC** — date, resolution
- Any other camera that produces `.mov`, `.mp4`, `.mts`, `.m2ts`, `.avi`, or `.mkv` files

> iPhone clips recorded in ProRes or HEVC will show a thumbnail preview instead of a live video player (a browser limitation). You can open them directly in QuickTime from the detail panel.

---

## Troubleshooting

**"command not found: brew"** — Homebrew didn't install correctly. Try Step 3 again, making sure to paste the full command.

**"command not found: npm"** — Node.js didn't install. Try `brew install node` again.

**App opens but shows a blank screen** — Make sure you selected a folder that actually contains video files.

**Thumbnails not generating** — ffmpeg may not be installed. Run `ffmpeg -version` in Terminal. If you get an error, run `brew install ffmpeg` again.

**macOS says the app is from an unidentified developer** — Right-click `swachh.app` → Open → Open. You only have to do this once.
