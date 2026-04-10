## MTG Instant Draft Machine

Generate MTG draft packs (Set, Chaos, Jumpstart, Block, Cube), preview cards, and print thermal proxies from either:

- a browser-based web app (`index.html`)
- a Python CLI (`instantdraft.py`)

This README is organized **Web App first**, then **CLI alternative**.

---

## Quick Start

### Web App (fastest path)

```bash
git clone https://www.github.com/realgoku3/mtg_instantdraft.git
cd mtg_instantdraft
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
git clone https://www.github.com/realgoku3/mtg_instantdraft.git
cd mtg_instantdraft
python3 -m venv .venv && source .venv/bin/activate
pip install --upgrade pip && pip install "python-escpos[usb]" Pillow requests
python3 instantdraft.py
```

---

## 1) Web App (HTML) - Recommended

`index.html` is a single-page app that uses Scryfall + WebUSB to generate and print packs.

### What you need

- A modern browser with WebUSB support (Chrome/Edge recommended)
- Internet access (Scryfall API + card images)
- Optional: ESC/POS USB thermal printer (80mm recommended)
- 80mm thermal paper

### Install / setup

1. Clone the repo:

```bash
git clone https://www.github.com/realgoku3/mtg_instantdraft.git
cd mtg_instantdraft
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

1. Choose a mode (`Set Draft`, `Chaos`, `Jumpstart`, `Block`, or `Cube`).
2. Configure pack count / drafters / token options.
3. Click **Generate Draft**.
4. (Optional) Connect printer with **Connect Printer**.
5. Print via:
   - **Print Pack** (single pack)
   - **Print All Packs** (entire draft queue)
   - **Quick Print** (single card by name)

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
git clone https://www.github.com/realgoku3/mtg_instantdraft.git
cd mtg_instantdraft
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
python3 instantdraft.py
```

You will be prompted for:

- set code (example: `dsk`, `otj`, `mkm`)
- or special mode (`CHAOS`, `JUMPSTART`, `BLOCK`, CubeCobra URL)
- number of packs / drafters
- whether to include token printing

### Optional printer USB IDs

If your printer is not detected, update constants in `instantdraft.py`:

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
- **CLI cannot connect to printer**: Verify `VENDOR_ID` and `PRODUCT_ID` in `instantdraft.py`.
- **Windows USB driver issues (CLI)**: Use Zadig to install a compatible USB driver for the printer interface used by `python-escpos`.
- **Slow generation on large drafts**: This is expected due to API fetch and image processing; try fewer packs first to validate setup.

---

## Contributing

PRs and issues are welcome, especially around:

- card layout edge cases
- printer compatibility improvements
- UX/quality-of-life features
