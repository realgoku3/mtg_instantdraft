## Instant Draft Machine

**Live at [draft.manaburn.net](https://draft.manaburn.net)**

Generate booster draft packs (Set, Chaos, Block, Cube), preview cards with a full-size lightbox, and print thermal proxies from either:

- a browser-based web app (`index.html`) -- no install required
- a Python CLI (`_archive/instantdraft.py`)

This README is organized **Web App first**, then **CLI alternative**.

---

## Quick Start

### Web App (fastest path)

Just open **[draft.manaburn.net](https://draft.manaburn.net)** in Chrome or Edge. No install needed.

To run locally instead:

```bash
git clone https://github.com/manaburndotnet/manaburndraft.github.io.git
cd manaburndraft.github.io
```

Open `index.html` directly in a Chromium browser (Chrome/Edge).

Platform-specific ways to open it:

- **Windows**: double-click `index.html`, or run `start index.html` in Command Prompt
- **macOS**: double-click `index.html`, or run `open index.html`
- **Linux**: double-click `index.html`, or run `xdg-open index.html`

If direct-open gives browser/security issues in your environment, use a local server fallback:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`.

### Python CLI (alternative)

```bash
git clone https://github.com/manaburndotnet/manaburndraft.github.io.git
cd manaburndraft.github.io
python3 -m venv .venv && source .venv/bin/activate
pip install --upgrade pip && pip install "python-escpos[usb]" Pillow requests
python3 _archive/instantdraft.py
```

---

## 1) Web App (HTML) -- Recommended

`index.html` is a single-page app that uses Scryfall + WebUSB to generate and print packs. The UI uses a green-on-black terminal aesthetic with monospace type.

### What you need

- A modern browser with WebUSB support (Chrome/Edge recommended)
- Internet access (Scryfall API + card images)
- Optional: ESC/POS USB thermal printer (80mm auto-cutter recommended, all others untested)
- 80mm thermal paper

### Install / setup

1. Open **[draft.manaburn.net](https://draft.manaburn.net)** -- or clone the repo to run locally:

```bash
git clone https://github.com/manaburndotnet/manaburndraft.github.io.git
cd manaburndraft.github.io
```

2. No npm/pip install is required for the web app itself.
3. Open `index.html` directly in a Chromium browser (recommended/default workflow).
   - macOS: `open index.html`
   - Windows (Command Prompt): `start index.html`
   - Linux: `xdg-open index.html`
4. If direct-open causes issues in your environment, run a local server fallback:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`.

### Using the web app

1. Choose a mode (`Set Draft`, `Chaos`, `Block`, or `Cube`).
2. Configure pack count / drafters / token options.
3. Click **Generate Draft**.
4. Click any card to open a full-size **lightbox** with left/right navigation and DFC flip.
5. (Optional) Connect printer with **Connect Printer**.
6. Print via:
   - **Print Pack** (single pack)
   - **Print All Packs** (entire draft queue)
   - **Quick Print** -- enter a card name (`Lightning Bolt`), a set+collector number (`stx102`), or prefix with a quantity (`4 Lightning Bolt`, `4 stx102`)
   - **Print a Card List** -- paste a list in `[qty] [name] ([set]) [collector#]` format to batch-print

### Web app features

- **Card nicknames** -- community nicknames like `bolt`, `bob`, `snap`, `goyf` resolve to their real card names in Quick Print and list printing (see `nicknames.js`).
- **Help modal** -- click the **?** button in the header for a quick-reference guide to all modes and print features.
- **Flavor text** -- random MTG flavor quotes cycle with a burn-out animation while packs generate.
- **Expand / Collapse All** -- toggle all pack sections open or closed from the results header.
- **Settings persistence** -- mode, pack count, drafter count, tokens toggle, gang print, and cube config are saved to localStorage and restored on reload.
- **Thermal preview** -- toggle dithered print-like card images in the UI to preview how cards will look on paper.
- **Gang printing** -- print packs as continuous strips without cuts.
- **Accessibility** -- ARIA attributes, skip-to-content link, keyboard-navigable cards, and `role="dialog"` on the help modal.

### Web app printing tips

- Use Chrome/Edge for best WebUSB behavior.
- If printer connection fails, reconnect USB and retry browser permission prompt.
- Gang printing can reduce cuts and make long strips.
- Thermal preview mode shows dithered print-like card images in the UI.

---

## 2) Python CLI (Alternative)

Use this if you want terminal-driven drafting and printing with `python-escpos`.

### What you need

- Python 3.8+ (3.7+ may work, but 3.8+ recommended)
- USB ESC/POS thermal printer
- Internet access (Scryfall API + art downloads)

### Install dependencies

1. Clone and enter repo:

```bash
git clone https://github.com/manaburndotnet/manaburndraft.github.io.git
cd manaburndraft.github.io
```

2. Create and activate a virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

On Windows PowerShell:

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
```

3. Install required packages:

```bash
pip install --upgrade pip
pip install "python-escpos[usb]" Pillow requests
```

### Run the CLI draft machine

```bash
python3 _archive/instantdraft.py
```

You will be prompted for:

- set code (example: `dsk`, `otj`, `mkm`)
- or special mode (`CHAOS`, `BLOCK`, CubeCobra URL)
- number of packs / drafters
- whether to include token printing

### Optional printer USB IDs

If your printer is not detected, update constants in `_archive/instantdraft.py`:

- `VENDOR_ID`
- `PRODUCT_ID`

Defaults are set for common Vretti/XPrinter-style devices.

---

## Notes

- Scryfall rate limiting is respected (requests are staggered).
- Large drafts/cubes may take time due to API fetch + art processing.
- If printing large jobs, ensure paper is loaded and avoid unplugging USB mid-queue.

---

## Troubleshooting

- **WebUSB browser support**: WebUSB works in Chromium-based browsers (Chrome/Edge). Firefox and Safari do not support WebUSB for this workflow.
- **WebUSB not available**: Use Chrome or Edge. If direct `index.html` launch is blocked in your environment, use `http://localhost` via a local server.
- **Printer does not appear in browser picker**: Reconnect USB, close other printer software, refresh the page, and try `Connect Printer` again.
- **Permission prompt canceled**: Click `Connect Printer` again and reselect the printer.
- **CLI cannot connect to printer**: Verify `VENDOR_ID` and `PRODUCT_ID` in `_archive/instantdraft.py`.
- **Windows USB driver issues (CLI)**: Use Zadig to install a compatible USB driver for the printer interface used by `python-escpos`.
- **Slow generation on large drafts**: This is expected due to API fetch and image processing; try fewer packs first to validate setup.

---

## Contributing

PRs and issues are welcome, especially around:

- card layout edge cases
- printer compatibility improvements
- UX/quality-of-life features
- new card nicknames (edit `nicknames.js`)

---

## License

This project is licensed under the [MIT License](LICENSE).
