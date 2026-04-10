## MTG Instant Draft Machine

Generate MTG draft packs (Set, Chaos, Jumpstart, Block, Cube), preview cards, and print thermal proxies from either:

- a browser-based web app (`index.html`)
- a Python CLI (`instantdraft.py`)

This README is organized **Web App first**, then **CLI alternative**.

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
3. Serve the folder locally (recommended for browser compatibility):

```bash
python3 -m http.server 8080
```

4. Open:

`http://localhost:8080/index.html`

> You can also open the file directly in some environments, but local HTTP is more reliable for browser permissions and asset loading.

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

## Optional utility: image spooler

If included in your checkout, `print_spooler.py` can print existing local PNG/JPG files with thermal-friendly processing.

---

## Notes

- Scryfall rate limiting is respected (requests are staggered).
- Large drafts/cubes may take time due to API fetch + art processing.
- If printing large jobs, ensure paper is loaded and avoid unplugging USB mid-queue.

---

## Troubleshooting

- **WebUSB not available**: Use Chrome or Edge, and run from `http://localhost` (not a restricted browser context).
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
