#!/usr/bin/env python3
import sys
import os
import re
import time
import random
import platform
import threading
import requests
from io import BytesIO
from urllib.parse import quote
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont, ImageEnhance, ImageOps

# --- MAC M-SERIES USB FIX ---
if platform.system() == 'Darwin':
    mac_lib_paths = '/opt/homebrew/lib:/usr/local/lib'
    current_fallback = os.environ.get('DYLD_FALLBACK_LIBRARY_PATH', '')
    os.environ['DYLD_FALLBACK_LIBRARY_PATH'] = f"{mac_lib_paths}:{current_fallback}"

try:
    from escpos.printer import Usb
except ImportError:
    print("⚠️  Warning: 'python-escpos' library not found. Printing will be simulated in console.")
    print("Install it using: pip install python-escpos[usb] Pillow requests")
    Usb = None

# --- Constants ---
# Generation Constants
DPI = 300
WIDTH = int(2.0 * DPI)     # 600 pixels
HEIGHT = int(3.125 * DPI)  # 937.5 pixels
MARGIN = 0                 
USABLE_WIDTH = WIDTH - (MARGIN * 2)
USABLE_HEIGHT = HEIGHT - (MARGIN * 2)
RATE_LIMIT_DELAY = 0.1  # 100ms delay for Scryfall API

ASCII_MODE = False

# Printer Constants
VENDOR_ID = 0x1fc9
PRODUCT_ID = 0x2016
PRINTER_WIDTH_PX = 576  # Standard 80mm thermal width

# Thread-Safe API Lock
API_LOCK = threading.Lock()
LAST_API_CALL = 0

# Known Bonus Sheets / The List / Special Guests mappings
BONUS_SHEETS = {
    'stx': ['sta'],
    'bro': ['brr'],
    'mom': ['mul'],
    'woe': ['wot', 'spg'],
    'lci': ['spg'],
    'mkm': ['spg'],
    'otj': ['big', 'otp', 'spg'],
    'blb': ['spg'],
    'dsk': ['spg'],
    'fdn': ['spg']
}

HISTORICAL_BLOCKS = {
    'ice age': ['ice', 'all', 'csp'],
    'mirage': ['mir', 'vis', 'wth'],
    'tempest': ['tmp', 'sth', 'exo'],
    "urza's": ['usg', 'ulg', 'uds'],
    'masques': ['mmq', 'nem', 'pcy'],
    'invasion': ['inv', 'pls', 'apc'],
    'odyssey': ['ody', 'tor', 'jud'],
    'onslaught': ['ons', 'lgn', 'scg'],
    'mirrodin': ['mrd', 'dst', '5dn'],
    'kamigawa': ['chk', 'bok', 'sok'],
    'ravnica': ['rav', 'gpt', 'dis'],
    'time spiral': ['tsp', 'plc', 'fut'],
    'lorwyn': ['lrw', 'lrw', 'mor'],
    'shadowmoor': ['shm', 'shm', 'eve'],
    'alara': ['ala', 'con', 'arb'],
    'zendikar': ['zen', 'wwk', 'roe'],
    'scars of mirrodin': ['som', 'mbs', 'nph'],
    'innistrad': ['isd', 'dka', 'avr'],
    'return to ravnica': ['rtr', 'gtc', 'dgm'],
    'theros': ['ths', 'bng', 'jou'],
    'khans of tarkir': ['ktk', 'frf', 'dtk'],
    'battle for zendikar': ['bfz', 'bfz', 'ogw'],
    'shadows over innistrad': ['soi', 'soi', 'emn'],
    'kaladesh': ['kld', 'kld', 'aer'],
    'amonkhet': ['akh', 'akh', 'hou'],
    'ixalan': ['xln', 'xln', 'rix']
}

# --- Rate Limiting & Networking ---
def rate_limited_get(url, stream=False):
    """Centralized, thread-safe HTTP GET wrapper that enforces Scryfall's 100ms rate limit and implements exponential backoff."""
    global LAST_API_CALL
    delays = [1, 2, 4, 8, 16]
    headers = {'User-Agent': 'MTGThermalDraft/1.0'}
    
    for attempt in range(len(delays) + 1):
        # 1. Lock only the timer update to properly stagger the requests
        with API_LOCK:
            now = time.time()
            elapsed = now - LAST_API_CALL
            if elapsed < RATE_LIMIT_DELAY:
                time.sleep(RATE_LIMIT_DELAY - elapsed)
            LAST_API_CALL = time.time()
        
        # 2. Network I/O happens OUTSIDE the lock to allow true concurrent thread downloads
        try:
            res = requests.get(url, headers=headers, stream=stream, timeout=60)
            
            if res.status_code in [200, 404]:
                return res
            elif res.status_code in [429, 500, 502, 503, 504]:
                pass # Trigger retry for rate limits or server errors
            else:
                return res # Return other errors instead of retrying blindly
        except requests.RequestException:
            pass # Trigger retry for network timeouts/connection errors
            
        if attempt < len(delays):
            time.sleep(delays[attempt])
            
    print("      [!] API/Network Error: Request failed after multiple retries. Please check your connection.")
    return None

# --- Font Management ---
def get_font(size, bold=False, monospace=False):
    if monospace:
        font_paths = [
            "/System/Library/Fonts/Menlo.ttc",
            "/System/Library/Fonts/Monaco.ttf",
            "/System/Library/Fonts/Supplemental/Courier New.ttf",
            "/Library/Fonts/Courier New.ttf",
            "C:\\Windows\\Fonts\\consola.ttf",
            "C:\\Windows\\Fonts\\cour.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
        ]
    else:
        font_paths = [
            "/System/Library/Fonts/Helvetica.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/Library/Fonts/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
        ]
        
    for path in font_paths:
        if os.path.exists(path):
            try:
                index = 1 if bold and ".ttc" in path else 0
                return ImageFont.truetype(path, size, index=index)
            except Exception:
                continue
                
    # --- Robust Fallback ---
    # Dynamically download an open-source TTF to avoid the terrible default bitmap font
    fallback_dir = os.path.join(os.path.expanduser("~"), ".mtg_draft_fonts")
    os.makedirs(fallback_dir, exist_ok=True)
    fallback_path = os.path.join(fallback_dir, "mono.ttf" if monospace else "sans.ttf")
    
    if not os.path.exists(fallback_path):
        try:
            url = "https://github.com/googlefonts/roboto/raw/main/src/hinted/RobotoMono-Regular.ttf" if monospace else "https://github.com/googlefonts/roboto/raw/main/src/hinted/Roboto-Regular.ttf"
            res = requests.get(url) # GitHub doesn't need Scryfall's rate limit lock
            if res.status_code == 200:
                with open(fallback_path, 'wb') as f:
                    f.write(res.content)
        except Exception:
            pass
            
    try:
        return ImageFont.truetype(fallback_path, size)
    except Exception:
        return ImageFont.load_default()

# --- Text Helpers ---
def format_mana(text):
    if not text: return ""
    return text.replace('{', '[').replace('}', ']')

def wrap_text(text, font, max_width):
    lines = []
    paragraphs = text.split('\n')
    for p in paragraphs:
        if not p:
            lines.append("")
            continue
        words = p.split()
        if not words: continue
        current_line = words[0]
        for word in words[1:]:
            test_line = current_line + " " + word
            if font.getlength(test_line) <= max_width:
                current_line = test_line
            else:
                lines.append(current_line)
                current_line = word
        lines.append(current_line)
    return lines

# --- Image Processing ---
def fast_dither(image):
    """
    Optimized dithering using Pillow's native C-backend (Floyd-Steinberg).
    Replaces the pure-Python Atkinson dither to eliminate the massive nested-loop bottleneck.
    """
    img = image.convert('L')
    brightener = ImageEnhance.Brightness(img)
    img = brightener.enhance(1.2)
    enhancer = ImageEnhance.Contrast(img)
    img = enhancer.enhance(1.1)
    
    # Pillow's convert to '1' applies Floyd-Steinberg dithering natively in optimized C
    return img.convert('1')

def download_art_memory(image_uri):
    """Downloads art directly into RAM as a PIL Image object."""
    if not image_uri: return None
    res = rate_limited_get(image_uri, stream=True)
    if res and res.status_code == 200:
        try:
            img = Image.open(BytesIO(res.content))
            img.load() # Force load into memory to prevent I/O operations on closed streams
            return img
        except Exception as e:
            print(f"      [!] Failed to process art: {e}")
    return None

# --- API & Logic ---
def get_set_info(set_code):
    res = rate_limited_get(f"https://api.scryfall.com/sets/{set_code}")
    if res and res.status_code == 200:
        return res.json()
    return None

def fetch_cards_for_query(query):
    cards = []
    url = f"https://api.scryfall.com/cards/search?q={quote(query)}"
    while url:
        res = rate_limited_get(url)
        if res and res.status_code == 200:
            data = res.json()
            cards.extend(data.get('data', []))
            url = data.get('next_page')
        else:
            break
    return cards

def fetch_token_data(uri):
    """Fetches full card JSON from a specific API URI (used for tokens via 'all_parts')"""
    res = rate_limited_get(uri)
    if res and res.status_code == 200:
        return res.json()
    return None

cube_card_cache = {}
def fetch_card_by_name(name):
    """Fetches card data specifically by fuzzy name match for Cube processing."""
    if name in cube_card_cache:
        return cube_card_cache[name]
    url = f"https://api.scryfall.com/cards/named?fuzzy={quote(name)}"
    res = rate_limited_get(url)
    if res and res.status_code == 200:
        data = res.json()
        cube_card_cache[name] = data
        return data
    return None

def get_cube_list(cube_id):
    """Fetches plaintext card list from CubeCobra."""
    print(f"📥 Fetching cube list from CubeCobra ({cube_id})...")
    url = f"https://cubecobra.com/cube/api/cubelist/{cube_id}"
    res = rate_limited_get(url)
    if res and res.status_code == 200:
        cards = [line.strip() for line in res.text.split('\n') if line.strip()]
        return cards
    print("❌ Connection to CubeCobra failed or list empty.")
    return None

def build_jumpstart_pack():
    """Builds a pseudo-jumpstart pack by pulling randomly from on-color Jumpstart cards."""
    colors = [
        ('W', 'Plains', 'White'),
        ('U', 'Island', 'Blue'),
        ('B', 'Swamp', 'Black'),
        ('R', 'Mountain', 'Red'),
        ('G', 'Forest', 'Green')
    ]
    c_code, basic_name, c_name = random.choice(colors)
    theme_name = f"Jumpstart Theme: {c_name}"
    
    print(f"📥 Fetching {c_name}-aligned cards from all Jumpstart sets...")
    cards = fetch_cards_for_query(f"st:jumpstart id<={c_code} -t:basic -is:digital")
    
    pools = {'C': [], 'U': [], 'R': [], 'M': []}
    for c in cards:
        rarity = c.get('rarity', 'common')
        if rarity in pools:
            pools[rarity].append(c)
        else:
            pools['R'].append(c)
            
    pack = []
    
    def pick_random(pool_name):
        pool = pools.get(pool_name, [])
        if not pool:
            pool = pools.get('C', []) # fallback
        return random.choice(pool) if pool else None

    # Jumpstart Formula: 1 R/M, 4 Uncommon, 7 Common, 8 Basic Lands
    r_card = pick_random('M') if random.random() < 0.2 and pools.get('M') else pick_random('R')
    if r_card: pack.append(r_card)
    for _ in range(4): pack.append(pick_random('U'))
    for _ in range(7): pack.append(pick_random('C'))
        
    basics = fetch_cards_for_query(f"t:basic name:{basic_name} st:jumpstart -is:digital")
    if not basics:
        basics = fetch_cards_for_query(f"t:basic name:{basic_name}") 
        
    if basics:
        for _ in range(8):
            pack.append(random.choice(basics))
    
    return pack, theme_name

def parse_scryfall_card(card):
    faces = []
    rarity_char = card.get('rarity', 'common')[0].upper()
    
    if 'card_faces' in card:
        if 'image_uris' in card['card_faces'][0]:
            # True Double-Faced Card
            for i, face in enumerate(card['card_faces']):
                oracle = face.get('oracle_text', '')
                flavor = face.get('flavor_text', '')
                text = oracle if oracle else flavor
                
                faces.append({
                    'name': face.get('name', ''),
                    'mana_cost': format_mana(face.get('mana_cost', '')),
                    'type_line': face.get('type_line', ''),
                    'text': text,
                    'power': face.get('power'),
                    'toughness': face.get('toughness'),
                    'loyalty': face.get('loyalty') or card.get('loyalty'),
                    'image_uri': face.get('image_uris', {}).get('art_crop'),
                    'id': f"{card['id']}_face{i}",
                    'rarity': rarity_char,
                    'dfc_side': 'front' if i == 0 else 'back'
                })
        else:
            # Adventure, Split, or Flip cards: Single image, but multiple rule boxes
            main_face = card['card_faces'][0]
            combined_text = main_face.get('oracle_text', main_face.get('flavor_text', ''))
            
            for face in card['card_faces'][1:]:
                sub_name = face.get('name', '')
                sub_mana = format_mana(face.get('mana_cost', ''))
                sub_type = face.get('type_line', '')
                sub_text = face.get('oracle_text', face.get('flavor_text', ''))
                
                combined_text += "\n\n"
                combined_text += f"--- {sub_name}   {sub_mana} ---\n"
                if sub_type:
                    combined_text += f"{sub_type}\n"
                combined_text += sub_text
            
            faces.append({
                'name': main_face.get('name', ''),
                'mana_cost': format_mana(main_face.get('mana_cost', '')),
                'type_line': main_face.get('type_line', ''),
                'text': combined_text.strip(),
                'power': main_face.get('power') or card.get('power'), 
                'toughness': main_face.get('toughness') or card.get('toughness'),
                'loyalty': main_face.get('loyalty') or card.get('loyalty'),
                'image_uri': card.get('image_uris', {}).get('art_crop'),
                'id': card['id'],
                'rarity': rarity_char
            })
    else:
        # Standard single-face card
        oracle = card.get('oracle_text', '')
        flavor = card.get('flavor_text', '')
        text = oracle if oracle else flavor
        
        faces.append({
            'name': card.get('name', ''),
            'mana_cost': format_mana(card.get('mana_cost', '')),
            'type_line': card.get('type_line', ''),
            'text': text,
            'power': card.get('power'),
            'toughness': card.get('toughness'),
            'loyalty': card.get('loyalty'),
            'image_uri': card.get('image_uris', {}).get('art_crop'),
            'id': card['id'],
            'rarity': rarity_char
        })
    return faces

def get_all_chaos_sets():
    """Fetches a full list of valid booster-draftable sets for Chaos Draft."""
    print("🌀 Fetching list of valid sets for Chaos Draft from Scryfall...")
    res = rate_limited_get("https://api.scryfall.com/sets")
    if res and res.status_code == 200:
        sets_data = res.json().get('data', [])
        valid_types = ['core', 'expansion', 'masters', 'draft_innovation']
        valid_sets = [s['code'] for s in sets_data if s.get('set_type') in valid_types]
        return valid_sets
    return []

def build_pools(set_code):
    info = get_set_info(set_code)
    if not info:
        print(f"❌ Set '{set_code}' not found!")
        return None, False, "", ""

    release_date = info.get('released_at', '1990-01-01')
    is_play_booster = release_date >= '2024-02-09' # MKM onwards
    set_name = info.get('name', set_code.upper())

    print(f"📥 Fetching card pool for {set_name}...")
    main_cards = fetch_cards_for_query(f"e:{set_code} is:booster -is:digital")
    
    if not main_cards:
        print(f"⚠️  No draftable booster cards found for {set_name}.")
        return None, False, "", ""
    
    # Highly categorized in-memory pool partitioning for perfect set simulation
    pools = {
        'C': [], 'U': [], 'R': [], 'M': [], 'Basic': [], 'Bonus': [],
        'DFC': [], 'Legendary': [], 'Planeswalker': [], 'Battle': [],
        'DraftMatters': [], 'Gate': [], 'SnowLand': [], 'NonBasicLand': [],
        'Lesson': []
    }

    for c in main_cards:
        rarity = c.get('rarity', 'common')
        type_line = c.get('type_line', '').lower()
        
        # Characteristic Toggling
        is_dfc = 'card_faces' in c and 'image_uris' in c['card_faces'][0]
        is_legendary = 'legendary' in type_line and 'creature' in type_line
        is_planeswalker = 'planeswalker' in type_line
        is_battle = 'battle' in type_line
        is_gate = 'gate' in type_line
        is_snow = 'snow' in type_line and 'land' in type_line
        is_nonbasic = 'land' in type_line and 'basic' not in type_line
        is_draftmatters = 'conspiracy' in type_line or c.get('watermark') == 'conspiracy'
        is_lesson = 'lesson' in type_line

        # Base Slotting
        if 'basic land' in type_line: pools['Basic'].append(c)
        elif rarity == 'common': pools['C'].append(c)
        elif rarity == 'uncommon': pools['U'].append(c)
        elif rarity == 'mythic': pools['M'].append(c)
        else: pools['R'].append(c) 
            
        # Special Rules Slotting (Allows cards to exist in multiple selection pools)
        if is_dfc: pools['DFC'].append(c)
        if is_legendary: pools['Legendary'].append(c)
        if is_planeswalker: pools['Planeswalker'].append(c)
        if is_battle: pools['Battle'].append(c)
        if is_draftmatters: pools['DraftMatters'].append(c)
        if is_gate: pools['Gate'].append(c)
        if is_snow: pools['SnowLand'].append(c)
        if is_nonbasic: pools['NonBasicLand'].append(c)
        if is_lesson: pools['Lesson'].append(c)

    # Fetch Bonus Sheets / Special Guests (Removing strictly "is:booster" requirement to bypass API tagging flaws on bonus sheets)
    if set_code in BONUS_SHEETS:
        for bonus_code in BONUS_SHEETS[set_code]:
            print(f"🌟 Fetching bonus sheet subset: {bonus_code.upper()}...")
            bonus_cards = fetch_cards_for_query(f"e:{bonus_code} lang:en -is:digital")
            pools['Bonus'].extend(bonus_cards)

    if set_code == 'mh2':
        print(f"🌟 Fetching New-to-Modern reprints for MH2...")
        pools['Bonus'] = fetch_cards_for_query(f"e:mh2 is:reprint lang:en -is:digital")

    return pools, is_play_booster, set_name, release_date

def roll_pack(pools, is_play_booster, set_code, release_date):
    pack = []
    seen_names = set()
    
    def pull(pool_keys, allow_dupe=False):
        """Intelligently pulls a unique card from a list of preferred pools (falling back down the list)"""
        if isinstance(pool_keys, str):
            search_keys = [pool_keys]
        else:
            search_keys = list(pool_keys) # Copy to prevent reference mutation bugs
            
        # Add ultimate fallback to prevent crashes if pools are completely exhausted
        search_keys.extend(['C', 'U', 'R', 'M', 'Basic']) 
            
        for key in search_keys:
            pool = pools.get(key, [])
            if not pool: continue
            
            valid_pool = pool if allow_dupe else [c for c in pool if c.get('name') not in seen_names]
            
            if valid_pool:
                chosen = random.choice(valid_pool)
                seen_names.add(chosen.get('name'))
                return chosen
                
            if pool: # If we exhausted unique cards, reluctantly allow a dupe
                chosen = random.choice(pool)
                seen_names.add(chosen.get('name'))
                return chosen
                
        return None

    # --- HISTORICAL PACK ERAS & EXCEPTIONS ---
    
    # Vintage 8-Card Packs (e.g., Arabian Nights, Fallen Empires)
    if set_code in ['arn', 'atq', 'drk', 'fem', 'hml']:
        for _ in range(2): pack.append(pull(['U', 'R']))
        for _ in range(6): pack.append(pull('C'))
        return pack
        
    # Vintage 12-Card Packs (e.g., Alliances)
    if set_code in ['chr', 'all']:
        pack.append(pull(['R', 'M', 'U']))
        for _ in range(3): pack.append(pull('U'))
        for _ in range(8): pack.append(pull('C'))
        return pack

    # Double Masters (15 Cards)
    if set_code in ['2xm', '2x2']:
        for _ in range(2): pack.append(pull(['M', 'R']) if random.random() < 0.125 else pull('R'))
        for _ in range(3): pack.append(pull('U'))
        for _ in range(8): pack.append(pull('C'))
        for _ in range(2): 
            roll = random.random()
            if roll < 0.05: pack.append(pull(['R', 'M'], allow_dupe=True))
            elif roll < 0.25: pack.append(pull('U', allow_dupe=True))
            else: pack.append(pull('C', allow_dupe=True))
        return pack
            
    # Commander Legends (20 Cards)
    if set_code in ['cmr', 'clb']:
        pack.append(pull(['M', 'R']) if random.random() < 0.125 else pull('R'))
        for _ in range(2): pack.append(pull(['Legendary', 'U']))
        for _ in range(3): pack.append(pull('U'))
        for _ in range(13): pack.append(pull('C'))
        roll = random.random()
        if roll < 0.05: pack.append(pull(['R', 'M'], allow_dupe=True))
        elif roll < 0.25: pack.append(pull('U', allow_dupe=True))
        else: pack.append(pull('C', allow_dupe=True))
        return pack

    # --- MODERN PLAY BOOSTERS ---
    if is_play_booster:
        pack.append(pull(['Basic', 'C']))                                     # 1 Land
        pack.append(pull(['M', 'R']) if random.random() < 0.125 else pull('R')) # 1 Rare/Mythic
        for _ in range(3): pack.append(pull('U'))                             # 3 Uncommons
        
        if pools.get('Bonus') and (set_code == 'otj' or random.random() < 0.20):
            pack.append(pull('Bonus'))
        else:
            pack.append(pull('C'))
            
        for _ in range(6): pack.append(pull('C'))                             # 6 Commons
        
        # Wildcard & Foil Slots
        for _ in range(2):
            roll = random.random()
            if roll < 0.01: pack.append(pull(['M', 'R'], allow_dupe=True))
            elif roll < 0.05: pack.append(pull('R', allow_dupe=True))
            elif roll < 0.25: pack.append(pull('U', allow_dupe=True))
            else: pack.append(pull('C', allow_dupe=True))
            
        return pack

    # --- STANDARD DRAFT BOOSTERS (The remaining 90% of sets) ---
    
    # Setup standard architecture
    c_count = 10
    u_count = 3
    r_count = 1
    
    # 1. Evaluate the Basic Land Slot
    # Most sets before Shards of Alara did not have Basic Lands in boosters, resulting in an 11th common.
    if pools.get('Basic') and set_code not in ['dgm', 'frf', 'khm']:
        pack.append(pull('Basic'))
    elif set_code == 'dgm':
        pack.append(pull(['Gate', 'Basic']))
    elif set_code == 'frf':
        pack.append(pull(['NonBasicLand', 'Basic']))
    elif set_code == 'khm':
        pack.append(pull(['SnowLand', 'Basic']))
    else:
        # Pre-Shards Era (or missing basics): Grant an extra Common.
        c_count = 11
        
    # 2. Evaluate Set Specific Sub-Slots (Evaluated independently to support sets with multiple rules)
    if set_code == 'war': 
        u_count -= 1
        pack.append(pull(['Planeswalker', 'U']))
        
    if set_code == 'dom':
        u_count -= 1
        pack.append(pull(['Legendary', 'U']))
        
    if set_code == 'mom':
        u_count -= 1
        pack.append(pull(['Battle', 'U']))
        
    if set_code in ['isd', 'dka', 'soi', 'emn', 'mid', 'vow', 'znr']:
        c_count -= 1
        pack.append(pull(['DFC', 'C']))
        
    if set_code in ['cns', 'cn2']:
        c_count -= 1
        pack.append(pull(['DraftMatters', 'C']))
        
    if set_code == 'stx':
        c_count -= 1
        pack.append(pull(['Lesson', 'C']))
        
    if set_code in BONUS_SHEETS or set_code == 'mh2':
        c_count -= 1
        pack.append(pull(['Bonus', 'C']))

    # 3. Build the core pack
    pack.append(pull(['M', 'R']) if random.random() < 0.125 else pull('R'))
    for _ in range(u_count): pack.append(pull('U'))
    
    # 4. Fill Commons & process traditional foils
    for i in range(c_count):
        # Master sets guarantee 1 Foil (Replaces last common slot)
        is_masters = set_code in ['mma', 'mm2', 'mm3', 'ema', 'ima', 'a25', 'uma', 'mh1', 'cmm']
        if i == c_count - 1 and (is_masters or random.random() < 0.15):
            roll = random.random()
            if roll < 0.05: pack.append(pull(['R', 'M'], allow_dupe=True))
            elif roll < 0.25: pack.append(pull('U', allow_dupe=True))
            else: pack.append(pull('C', allow_dupe=True))
        else:
            pack.append(pull('C'))

    return pack

# --- Layout Engine ---
def generate_card_image(face, art_cache=None):
    img = Image.new('1', (WIDTH, HEIGHT), color=1)
    draw = ImageDraw.Draw(img)
    current_y = MARGIN
    
    # 1. Header & DFC Symbol check
    title_font_size = 32
    font_title = get_font(title_font_size, bold=True, monospace=ASCII_MODE)
    mana_width = font_title.getlength(face['mana_cost']) if face['mana_cost'] else 0
    
    dfc_side = face.get('dfc_side')
    icon_size = 20 if dfc_side else 0
    icon_spacing = 8 if dfc_side else 0
    
    if ASCII_MODE and dfc_side:
        dfc_str = "[^]" if dfc_side == 'front' else "[v]"
        icon_size = font_title.getlength(dfc_str)
        icon_spacing = 4
    
    # Check width requirements accommodating the DFC icon if present
    while (font_title.getlength(face['name']) + mana_width + icon_size + icon_spacing + 10) > USABLE_WIDTH and title_font_size > 10:
        title_font_size -= 1
        font_title = get_font(title_font_size, bold=True, monospace=ASCII_MODE)
        mana_width = font_title.getlength(face['mana_cost']) if face['mana_cost'] else 0
        if ASCII_MODE and dfc_side:
            icon_size = font_title.getlength(dfc_str)
    
    title_x = MARGIN
    
    if dfc_side:
        if ASCII_MODE:
            draw.text((title_x, current_y), dfc_str, font=font_title, fill=0)
            title_x += icon_size + icon_spacing
        else:
            # Dynamically generate a 1-bit BMP triangle and paste it inline
            icon_img = Image.new('1', (int(icon_size), int(icon_size)), color=1)
            icon_draw = ImageDraw.Draw(icon_img)
            if dfc_side == 'front':
                icon_draw.polygon([(0, icon_size), (icon_size/2, 0), (icon_size, icon_size)], fill=0)
            else:
                icon_draw.polygon([(0, 0), (icon_size/2, icon_size), (icon_size, 0)], fill=0)
            
            y_offset = current_y + (title_font_size - int(icon_size)) // 2 + 2
            img.paste(icon_img, (title_x, int(y_offset)))
            title_x += icon_size + icon_spacing
    
    draw.text((title_x, current_y), face['name'], font=font_title, fill=0)
    
    if face['mana_cost']:
        draw.text((WIDTH - MARGIN - mana_width, current_y), face['mana_cost'], font=font_title, fill=0)
    current_y += title_font_size + 6 
    
    # 2. Type Line Prep
    type_font_size = 26
    font_type = get_font(type_font_size, bold=True, monospace=ASCII_MODE)
    rarity_str = face.get('rarity', 'C')
    
    while font_type.getlength(face['type_line']) + font_type.getlength(rarity_str) + 15 > USABLE_WIDTH and type_font_size > 10:
        type_font_size -= 1
        font_type = get_font(type_font_size, bold=True, monospace=ASCII_MODE)
    
    # 3. Dynamic Art/Text Sizing
    pt_height = 40 if face.get('power') and face.get('toughness') else 0
    # ensure space if it has loyalty instead of P/T
    if face.get('loyalty'): pt_height = max(pt_height, 48)
        
    remaining_height = HEIGHT - (current_y + type_font_size + 15 + pt_height + MARGIN)
    
    font_size = 47
    font_text = get_font(font_size, monospace=ASCII_MODE)
    line_spacing = 4
    wrapped_lines = []
    text_height = 0
    
    if face['text']:
        wrapped_lines = wrap_text(face['text'], font_text, USABLE_WIDTH)
        text_height = len(wrapped_lines) * (font_size + line_spacing)
        
        text_max_height = int(remaining_height * 0.5)
        
        while text_height > text_max_height and font_size >= 16:
            font_size -= 2
            font_text = get_font(font_size, monospace=ASCII_MODE)
            wrapped_lines = wrap_text(face['text'], font_text, USABLE_WIDTH)
            text_height = len(wrapped_lines) * (font_size + line_spacing)
            
        if text_height > text_max_height:
            text_height = text_max_height
            
    # Art dynamically fills whatever space is left
    art_height = int(remaining_height - text_height - 10)

    # 4. Draw Art
    art_img = None
    if art_cache and face['image_uri'] in art_cache:
        art_img = art_cache[face['image_uri']].copy()
    else:
        art_img = download_art_memory(face['image_uri'])
        
    if art_img:
        if ASCII_MODE:
            # -- POS DOT MATRIX OVERRIDE RENDERING --
            ascii_chars = ["@", "#", "8", "&", "o", ":", "*", ".", " "]
            art_img = art_img.convert('L')
            
            ascii_font_size = 28
            ascii_font = get_font(ascii_font_size, monospace=True)
            
            char_width = ascii_font.getlength("A")
            if char_width == 0: char_width = 16
            char_height = ascii_font_size
            
            cols = int(USABLE_WIDTH / char_width)
            rows = int(art_height / char_height)
            
            if cols > 0 and rows > 0:
                art_ratio = art_img.width / art_img.height
                target_ratio = cols / rows
                
                # Perfect center crop to maintain aspect ratio
                if art_ratio > target_ratio:
                    new_w = int(art_img.height * target_ratio)
                    left = (art_img.width - new_w) // 2
                    art_img = art_img.crop((left, 0, left + new_w, art_img.height))
                else:
                    new_h = int(art_img.width / target_ratio)
                    top = (art_img.height - new_h) // 2
                    art_img = art_img.crop((0, top, art_img.width, top + new_h))
                    
                art_img = art_img.resize((cols, rows), Image.Resampling.LANCZOS)
                
                # Lighten the artwork and add a hair more contrast for the POS dot-matrix vibe
                brightener = ImageEnhance.Brightness(art_img)
                art_img = brightener.enhance(1.4)
                
                # Enhance contrast so the ASCII chars have more dynamic range
                enhancer = ImageEnhance.Contrast(art_img)
                art_img = enhancer.enhance(1.6)
                pixels = list(art_img.getdata())
                
                ascii_y = current_y
                draw.text((MARGIN, ascii_y - (ascii_font_size - 2)), "-" * cols, font=ascii_font, fill=0)
                
                for y in range(rows):
                    line_chars = []
                    for x in range(cols):
                        pixel_val = pixels[y * cols + x]
                        # 0 is black (maps to @), 255 is white (maps to ' ')
                        idx = int((pixel_val / 255) * (len(ascii_chars) - 1))
                        line_chars.append(ascii_chars[idx])
                    line_str = "".join(line_chars)
                    draw.text((MARGIN, ascii_y), line_str, font=ascii_font, fill=0)
                    ascii_y += char_height
                
                draw.text((MARGIN, ascii_y), "-" * cols, font=ascii_font, fill=0)
        else:
            # -- STANDARD C-OPTIMIZED DITHERING --
            art_ratio = art_img.width / art_img.height
            target_ratio = USABLE_WIDTH / art_height
            if art_ratio > target_ratio:
                new_w = int(art_img.height * target_ratio)
                left = (art_img.width - new_w) // 2
                art_img = art_img.crop((left, 0, left + new_w, art_img.height))
            else:
                new_h = int(art_img.width / target_ratio)
                top = (art_img.height - new_h) // 2
                art_img = art_img.crop((0, top, art_img.width, top + new_h))
            art_img = art_img.resize((USABLE_WIDTH, art_height), Image.Resampling.LANCZOS)
            art_img = fast_dither(art_img)
            img.paste(art_img, (MARGIN, current_y))
            draw.rectangle([MARGIN, current_y, MARGIN + USABLE_WIDTH, current_y + art_height], outline=0, width=2)
            
        art_img.close()
    
    current_y += art_height + 8
    
    # Draw Type Line
    draw.text((MARGIN, current_y), face['type_line'], font=font_type, fill=0)
    # Draw Rarity Signifier (Right-aligned)
    rarity_width = font_type.getlength(rarity_str)
    draw.text((WIDTH - MARGIN - rarity_width, current_y), rarity_str, font=font_type, fill=0)
    
    current_y += type_font_size + 10
    
    if wrapped_lines:
        for line in wrapped_lines:
            draw.text((MARGIN, current_y), line, font=font_text, fill=0)
            current_y += font_size + line_spacing
            
    # 5. P/T and Loyalty Rendering Layer
    if face.get('power') is not None and face.get('toughness') is not None:
        pt_str = f"{face['power']} / {face['toughness']}"
        if ASCII_MODE:
            pt_str = f"[ {pt_str} ]"
            pt_font = get_font(30, True, monospace=True)
            pt_width = pt_font.getlength(pt_str)
            draw.text((WIDTH - pt_width - 8, HEIGHT - 40), pt_str, font=pt_font, fill=0)
        else:
            pt_width = get_font(30, True).getlength(pt_str)
            draw.rectangle([WIDTH - pt_width - 16, HEIGHT - 48, WIDTH, HEIGHT], fill=1, outline=0, width=2)
            draw.text((WIDTH - pt_width - 8, HEIGHT - 40), pt_str, font=get_font(30, True), fill=0)
        
    if face.get('loyalty') is not None:
        loyalty_str = str(face.get('loyalty'))
        if ASCII_MODE:
            loy_str = f"{{ {loyalty_str} }}"
            loy_font = get_font(30, True, monospace=True)
            loy_width = loy_font.getlength(loy_str)
            x0 = WIDTH - loy_width - 8
            
            # Slide left if card also has P/T
            if face.get('power') is not None and face.get('toughness') is not None:
                pt_str = f"[ {face['power']} / {face['toughness']} ]"
                x0 -= (loy_font.getlength(pt_str) + 16)
                
            draw.text((x0, HEIGHT - 40), loy_str, font=loy_font, fill=0)
        else:
            loy_font = get_font(30, True)
            loy_width = loy_font.getlength(loyalty_str)
            
            box_w = max(loy_width + 24, 48)
            box_h = 48
            x0 = WIDTH - box_w
            
            if face.get('power') is not None and face.get('toughness') is not None:
                pt_str = f"{face['power']} / {face['toughness']}"
                pt_width = loy_font.getlength(pt_str)
                x0 -= (pt_width + 24)
                
            y0 = HEIGHT - box_h
            
            shield = [
                (x0, y0),
                (x0 + box_w, y0),
                (x0 + box_w, HEIGHT - 16),
                (x0 + box_w/2, HEIGHT),
                (x0, HEIGHT - 16)
            ]
            draw.polygon(shield, fill=1)
            draw.line(shield + [(x0, y0)], fill=0, width=2)
            
            text_x = x0 + (box_w - loy_width) / 2
            text_y = y0 + 6
            draw.text((text_x, text_y), loyalty_str, font=loy_font, fill=0)
        
    return img

# --- Print Logic ---
def setup_printer():
    if Usb is None: return None
    try:
        printer = Usb(VENDOR_ID, PRODUCT_ID)
        try: printer.profile.profile_data['media']['width'] = {"mm": 80, "pixels": 576}
        except: pass
        printer._raw(b'\x1f\x1b\x1f\x01') # Speed 2
        printer._raw(b'\x1f\x1b\x1f\x0a') # Density 10
        printer.set(align='center')
        return printer
    except Exception as e:
        print(f"❌ Could not connect to printer: {e}")
        return None

def wait_for_printer(printer, default_sleep=1.5):
    """
    Checks printer status to prevent hardware buffer overflows.
    Falls back to a safe mechanical sleep timer if the printer uses a write-only USB endpoint.
    """
    if not printer: return
    try:
        # If the printer supports two-way communication, this confirms it is ready to receive
        # more data. We just add a tiny sleep to ensure the mechanical cut/feed completes.
        printer.paper_status()
        time.sleep(0.2)
    except Exception:
        # Catch timeout or NotImplemented errors from write-only generic drivers
        time.sleep(default_sleep)

def process_for_print(img):
    # Force the 90-degree rotation here AFTER generation. 
    # This guarantees the card always prints in the wide/landscape format.
    img = img.rotate(90, expand=True)
    
    ratio = PRINTER_WIDTH_PX / img.width
    target_height = int(img.height * ratio)
    return img.resize((PRINTER_WIDTH_PX, target_height), Image.Resampling.LANCZOS)

def print_card_list(cards_list, printer):
    """Abstracted helper block for rendering and dispatching a list of Scryfall JSON cards to the printer."""
    
    # --- PRE-FETCH ART ASYNCHRONOUSLY ---
    print("  [~] Pre-fetching card art into memory...")
    unique_uris = set()
    for card_data in cards_list:
        faces = parse_scryfall_card(card_data)
        for face in faces:
            if face.get('image_uri'):
                unique_uris.add(face['image_uri'])
                
    art_cache = {}
    if unique_uris:
        with ThreadPoolExecutor(max_workers=5) as executor:
            future_to_uri = {executor.submit(download_art_memory, uri): uri for uri in unique_uris}
            for future in future_to_uri:
                uri = future_to_uri[future]
                try:
                    img = future.result()
                    if img:
                        art_cache[uri] = img
                except Exception:
                    pass

    # --- RENDER AND PRINT LOOP ---
    for idx, card_data in enumerate(cards_list):
        faces = parse_scryfall_card(card_data)
        
        rarity = card_data.get('rarity', 'common')
        print(f"  [{idx+1}/{len(cards_list)}] {card_data.get('name')} ({rarity.upper()})")
        
        for face_idx, face in enumerate(faces):
            if len(faces) > 1:
                print(f"    -> Rendering DFC Face {face_idx+1}: {face['name']}")
                
            card_img = generate_card_image(face, art_cache)
            
            if printer:
                print_ready = process_for_print(card_img)
                printer.image(print_ready, impl="bitImageRaster")
                
                # Only cut if it's the last face of the card
                if face_idx < len(faces) - 1:
                    spacer = Image.new('1', (PRINTER_WIDTH_PX, 20), color=1)
                    printer.image(spacer, impl="bitImageRaster")
                    spacer.close()
                    wait_for_printer(printer, 1.0)
                else:
                    printer.cut(feed=False)
                    wait_for_printer(printer, 1.5)
                    
                print_ready.close()
            card_img.close()

# --- Main Flow ---
def main():
    global ASCII_MODE
    
    print("\n✨ MTG Instant Draft Machine ✨")
    print("--------------------------------\n")
    
    raw_input = input("🏷️  Enter Set Code, 'CHAOS', 'JUMPSTART', 'BLOCK', 'RANDOM BLOCK', or CubeCobra URL: ").strip().lower()
    
    # Check for POS Override (Easter Egg)
    if 'ascii' in raw_input:
        ASCII_MODE = True
        raw_input = raw_input.replace('ascii', '').strip()
        print("\n📠 [ACCESS GRANTED] POS OVERRIDE: DOT-MATRIX PROTOCOL ENGAGED...")
        # If the user only typed "ascii", prompt again for the actual set
        if not raw_input:
            raw_input = input("🏷️  Now Enter Set Code, 'CHAOS', 'BLOCK', etc: ").strip().lower()
    
    is_cube = False
    is_jumpstart = False
    is_chaos = False
    is_block = False
    
    cube_id = None
    block_sequence = []
    block_name = ""
    
    # 1. Input Parsing & Mode Selection
    if "cubecobra.com" in raw_input:
        is_cube = True
        match = re.search(r'cube/(?:list|overview|playtest)/([^/&\?]+)', raw_input, re.IGNORECASE)
        if match:
            cube_id = match.group(1)
        else:
            print("❌ Could not parse CubeCobra URL. Make sure it looks like 'https://cubecobra.com/cube/list/your_cube_id'")
            return
    elif raw_input == 'jumpstart':
        is_jumpstart = True
    elif raw_input == 'chaos':
        is_chaos = True
    elif raw_input == 'random block':
        is_block = True
        block_name = random.choice(list(HISTORICAL_BLOCKS.keys()))
        block_sequence = HISTORICAL_BLOCKS[block_name]
        print(f"\n🎲 Random Block Selected: {block_name.title()}!")
    elif raw_input == 'block':
        is_block = True
        print("\n📚 Available Blocks:")
        blocks_list = list(HISTORICAL_BLOCKS.keys())
        for i, b_name in enumerate(blocks_list):
            print(f"  {i+1}. {b_name.title()}")
        
        while True:
            b_sel = input("\n🔢 Select a Block Number (or type name): ").strip().lower()
            if b_sel.isdigit() and 1 <= int(b_sel) <= len(blocks_list):
                block_name = blocks_list[int(b_sel)-1]
                block_sequence = HISTORICAL_BLOCKS[block_name]
                break
            elif b_sel in HISTORICAL_BLOCKS:
                block_name = b_sel
                block_sequence = HISTORICAL_BLOCKS[b_sel]
                break
            print("❌ Invalid selection. Please try again.")
    else:
        set_code = raw_input
        
    if is_block:
        try:
            num_drafters = int(input(f"👥 Enter Number of Drafters for {block_name.title()} Block (Each gets 3 packs): ").strip())
            num_packs = num_drafters * 3
        except ValueError:
            print("❌ Invalid number of drafters.")
            return
    else:
        try:
            num_packs = int(input("📦 Enter Number of Packs to Generate: ").strip())
        except ValueError:
            print("❌ Invalid number of packs.")
            return
            
    print_tokens = input("🖨️  Print associated tokens? (y/n): ").strip().lower() == 'y'
            
    printer = setup_printer()
    if not printer:
        print("\n⚠️  Proceeding in SIMULATION mode. (Images will be processed in RAM but not physically printed)")

    # 2. Setup Data Sources & Generate Draft Sequence
    pool_cache = {}
    cube_list = []
    cube_index = 0
    token_cache = {}
    global_tokens_dict = {}
    
    draft_sequence = []

    if is_block:
        draft_sequence = block_sequence * num_drafters
    elif is_cube:
        print(f"\n🌀 Cube Draft Selected! Fetching from CubeCobra...")
        cube_list = get_cube_list(cube_id)
        if not cube_list:
            return
        print(f"✅ Loaded {len(cube_list)} cards. Shuffling the cube...")
        random.shuffle(cube_list)
        draft_sequence = ['cube'] * num_packs
    elif is_jumpstart:
        draft_sequence = ['jumpstart'] * num_packs
    elif is_chaos:
        valid_chaos_sets = get_all_chaos_sets()
        if not valid_chaos_sets:
            print("❌ Failed to fetch sets for Chaos draft.")
            return
        print(f"\n🌀 Chaos Draft Selected! Prepare for madness...")
        for _ in range(num_packs):
            if valid_chaos_sets:
                choice = random.choice(valid_chaos_sets)
                valid_chaos_sets.remove(choice)
                draft_sequence.append(choice)
    else:
        # Standard Set optimization (fetch immediately to confirm validity)
        pools, is_play_booster, set_name, release_date = build_pools(set_code)
        if not pools: return
        pool_cache[set_code] = (pools, is_play_booster, set_name, release_date)
        booster_type = "Play Booster" if is_play_booster else "Historical Draft Booster"
        print(f"\n✅ Ready! '{set_name}' utilizes {booster_type} logic.")
        draft_sequence = [set_code] * num_packs

    # 3. Process the Draft Sequence
    for pack_idx, current_set_code in enumerate(draft_sequence):
        
        if current_set_code == 'jumpstart':
            pack_cards, theme_name = build_jumpstart_pack()
            set_name = theme_name
            booster_type = "Jumpstart Packet"
            
            print(f"\n==========================================")
            print(f"🎲 Rolling Packet {pack_idx + 1} of {num_packs}...")
            print(f"🌟 Set: {set_name} (20 Cards)")
            print(f"==========================================")
            
        elif current_set_code == 'cube':
            pack_cards = []
            set_name = f"Cube: {cube_id}"
            print(f"\n==========================================")
            print(f"🎲 Rolling Pack {pack_idx + 1} of {num_packs}...")
            print(f"🌟 Set: {set_name} (15 Random Cards)")
            print(f"==========================================")
            
            while len(pack_cards) < 15:
                if cube_index >= len(cube_list):
                    print("⚠️ Cube exhausted! Reshuffling...")
                    random.shuffle(cube_list)
                    cube_index = 0
                    
                target_name = cube_list[cube_index]
                cube_index += 1
                
                card_data = fetch_card_by_name(target_name)
                if card_data:
                    pack_cards.append(card_data)
                else:
                    print(f"      [!] Scryfall could not find: {target_name}. Skipping to next card.")
                    
        else:
            if current_set_code not in pool_cache:
                pools, is_play_booster, set_name, release_date = build_pools(current_set_code)
                if not pools:
                    if is_chaos and valid_chaos_sets:
                        print(f"⚠️  Skipping '{current_set_code}' due to pool build failure. Finding another set...")
                        next_choice = random.choice(valid_chaos_sets)
                        valid_chaos_sets.remove(next_choice)
                        draft_sequence.append(next_choice)
                        continue
                    else:
                        print(f"⚠️  Failed to build pool for '{current_set_code}'.")
                        break
                pool_cache[current_set_code] = (pools, is_play_booster, set_name, release_date)
            else:
                pools, is_play_booster, set_name, release_date = pool_cache[current_set_code]

            booster_type = "Play Booster" if is_play_booster else "Historical Draft Booster"

            print(f"\n==========================================")
            if is_block:
                drafter_num = (pack_idx // 3) + 1
                pack_num = (pack_idx % 3) + 1
                print(f"🎲 Drafter {drafter_num} - Pack {pack_num} of 3...")
            else:
                print(f"🎲 Rolling Pack {pack_idx + 1} of {len(draft_sequence)}...")
            print(f"🌟 Set: {set_name} ({booster_type})")
            print(f"==========================================")
            
            pack_cards = roll_pack(pools, is_play_booster, current_set_code, release_date)

        pack_tokens_dict = {}
        
        # --- Token Processing ---
        if print_tokens:
            for card_data in pack_cards:
                for part in card_data.get('all_parts', []):
                    # Identifies Emblems, standard Tokens, The Monarch, Initiative, etc.
                    if part.get('component') == 'token':
                        if part.get('id') == card_data.get('id'):
                            continue
                            
                        token_uri = part.get('uri')
                        if token_uri and token_uri not in token_cache:
                            print(f"    -> Finding Token/Helper: {part.get('name', 'Unknown')}")
                            t_data = fetch_token_data(token_uri)
                            if t_data:
                                token_cache[token_uri] = t_data
                                
                        if token_uri in token_cache:
                            t_data = token_cache[token_uri]
                            if num_packs == 1:
                                pack_tokens_dict[token_uri] = t_data
                            else:
                                global_tokens_dict[token_uri] = t_data
        
        # --- Physical Printing ---
        if printer:
            printer.set(align='center')
            printer.text("\n================================\n")
            
            if is_block:
                drafter_num = (pack_idx // 3) + 1
                pack_num = (pack_idx % 3) + 1
                printer.text(f"--- DRAFTER {drafter_num} : PACK {pack_num} ---\n")
                printer.text(f"--- {set_name} ---\n")
            elif is_jumpstart:
                printer.text(f"--- PACKET {pack_idx + 1}: {set_name} ---\n")
            else:
                printer.text(f"--- PACK {pack_idx + 1}: {set_name} ---\n")
                
            printer.text("================================\n\n")
            printer.cut() # Auto-cut the pack header!
            wait_for_printer(printer, 1.0)
            
        print_card_list(pack_cards, printer)
        
        # --- Immediate Token Print (If only 1 Pack requested) ---
        if print_tokens and len(draft_sequence) == 1 and pack_tokens_dict:
            print(f"\n==========================================")
            print(f"🃏 Printing {len(pack_tokens_dict)} Associated Tokens...")
            print(f"==========================================")
            if printer:
                printer.set(align='center')
                printer.text("\n================================\n")
                printer.text(f"--- ASSOCIATED TOKENS ---\n")
                printer.text("================================\n\n")
                printer.cut()
                wait_for_printer(printer, 1.0)
            
            print_card_list(list(pack_tokens_dict.values()), printer)

    # --- Consolidated Token Batch Print (If multiple packs requested) ---
    if print_tokens and len(draft_sequence) > 1 and global_tokens_dict:
        print(f"\n==========================================")
        print(f"🃏 Printing Consolidated Token Batch ({len(global_tokens_dict)} Unique Tokens)...")
        print(f"==========================================")
        if printer:
            printer.set(align='center')
            printer.text("\n================================\n")
            printer.text(f"--- DRAFT TOKEN BATCH ---\n")
            printer.text("================================\n\n")
            printer.cut()
            wait_for_printer(printer, 1.0)
        
        print_card_list(list(global_tokens_dict.values()), printer)

    print("\n🎉 Draft Machine finished successfully!")

if __name__ == "__main__":
    main()