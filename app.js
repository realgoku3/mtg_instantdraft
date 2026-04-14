'use strict';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS  (pure data in data.js, loaded before this file)
// ═══════════════════════════════════════════════════════════════
const RATE_LIMIT_DELAY = 105; // slightly over 100ms for safety

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER  (mirrors Python's thread-safe 100ms stagger)
// JS is single-threaded: slot reservation is atomic at sync level.
// Concurrent async calls get distinct time slots via nextCallTime.
// ═══════════════════════════════════════════════════════════════
let _nextCallTime = Date.now();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function rateLimitedGet(url) {
  // Reserve a unique call slot (sync, no race condition in JS)
  const mySlot = _nextCallTime;
  _nextCallTime = Math.max(_nextCallTime + RATE_LIMIT_DELAY, Date.now() + RATE_LIMIT_DELAY);

  const wait = mySlot - Date.now();
  if (wait > 0) await sleep(wait);

  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.status === 200 || res.status === 404) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < delays.length) {
        setStatus(`Rate limited -- retrying in ${delays[attempt]/1000}s...`);
        await sleep(delays[attempt]);
        continue;
      }
      return res;
    } catch {
      if (attempt < delays.length) { await sleep(delays[attempt]); continue; }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════
async function getSetInfo(setCode) {
  const res = await rateLimitedGet(`https://api.scryfall.com/sets/${setCode}`);
  if (res && res.status === 200) return res.json();
  return null;
}

async function fetchCardsForQuery(query) {
  const cards = [];
  let url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`;
  while (url) {
    const res = await rateLimitedGet(url);
    if (res && res.status === 200) {
      const data = await res.json();
      cards.push(...(data.data || []));
      url = data.has_more ? data.next_page : null;
    } else {
      break;
    }
  }
  return cards;
}

async function fetchTokenData(uri) {
  const res = await rateLimitedGet(uri);
  if (res && res.status === 200) return res.json();
  return null;
}

const _cardByNameCache = {};
async function fetchCardByName(name) {
  if (_cardByNameCache[name]) return _cardByNameCache[name];
  const res = await rateLimitedGet(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`);
  if (res && res.status === 200) {
    const data = await res.json();
    _cardByNameCache[name] = data;
    return data;
  }
  return null;
}

/**
 * Batch-fetch cards via POST /cards/collection (up to 75 per request).
 * Each identifier is either {name} or {set, collector_number}.
 * Returns {found: [card,...], notFound: [identifier,...]}.
 */
async function fetchCardsCollection(identifiers) {
  const found = [];
  const notFound = [];
  const BATCH = 75;
  const MAX_RETRIES = 5;

  for (let i = 0; i < identifiers.length; i += BATCH) {
    const batch = identifiers.slice(i, i + BATCH);
    const mySlot = _nextCallTime;
    _nextCallTime = Math.max(_nextCallTime + RATE_LIMIT_DELAY, Date.now() + RATE_LIMIT_DELAY);
    const wait = mySlot - Date.now();
    if (wait > 0) await sleep(wait);

    let retries = 0;
    while (true) {
      const res = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ identifiers: batch }),
      });

      if (res.ok) {
        const data = await res.json();
        found.push(...(data.data || []));
        notFound.push(...(data.not_found || []));
        break;
      } else if (res.status === 429 && retries < MAX_RETRIES) {
        retries++;
        await sleep(2000 * retries);
      } else {
        break;
      }
    }
  }
  return { found, notFound };
}

function entryLookupKey(entry) {
  return (entry.set && entry.collectorNumber)
    ? `sc:${entry.set}/${entry.collectorNumber}`
    : `n:${entry.name.toLowerCase()}`;
}

async function batchFetchCardLookup(entries) {
  const seenKeys = new Set();
  const idList = [];
  for (const entry of entries) {
    const key = entryLookupKey(entry);
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      idList.push((entry.set && entry.collectorNumber)
        ? { set: entry.set, collector_number: entry.collectorNumber }
        : { name: entry.name });
    }
  }
  const { found, notFound } = await fetchCardsCollection(idList);
  const lookup = {};
  for (const card of found) {
    if (card.set && card.collector_number) {
      lookup[`sc:${card.set}/${card.collector_number}`] = card;
    }
    lookup[`n:${(card.name || '').toLowerCase()}`] = card;
  }
  return { lookup, uniqueCount: idList.length, notFound };
}

async function getCubeList(cubeId) {
  setStatus(`Fetching cube list from CubeCobra (${cubeId})...`);
  const res = await rateLimitedGet(`https://cubecobra.com/cube/api/cubelist/${cubeId}`);
  if (res && res.status === 200) {
    const text = await res.text();
    return text.split('\n').map(l => l.trim()).filter(Boolean);
  }
  return null;
}

// Format windows (Modern / Pioneer) — upper bound is "released through today" in the browser.
const MODERN_FIRST_RELEASE = '2003-07-28';   // Eighth Edition
const PIONEER_FIRST_RELEASE = '2012-10-05';  // Return to Ravnica

const STANDARD_SET_CODES_CACHE_KEY = 'mtg_chaos_standard_set_codes_v2';
const STANDARD_SET_CODES_CACHE_MS = 24 * 60 * 60 * 1000;

function todayISODate() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Set objects from GET /sets do not include format legality on Scryfall’s API, so we derive
 * Standard set codes from oracle cards that are legal in the Standard *format* (bans included)
 * via `format:standard`, not the raw CR `legal:standard` line.
 */
async function fetchStandardLegalSetCodes() {
  try {
    const raw = sessionStorage.getItem(STANDARD_SET_CODES_CACHE_KEY);
    if (raw) {
      const { t, codes } = JSON.parse(raw);
      if (Date.now() - t < STANDARD_SET_CODES_CACHE_MS && Array.isArray(codes) && codes.length)
        return new Set(codes);
    }
  } catch {}

  setStatus('Resolving Standard format sets for Chaos...');
  const codes = new Set();
  let url = 'https://api.scryfall.com/cards/search?q=' + encodeURIComponent('game:paper format:standard unique:cards');
  while (url) {
    const res = await rateLimitedGet(url);
    if (!res || res.status !== 200) return null;
    const data = await res.json();
    for (const c of data.data || []) {
      if (c.set) codes.add(c.set);
    }
    url = data.next_page;
  }
  try {
    sessionStorage.setItem(STANDARD_SET_CODES_CACHE_KEY, JSON.stringify({ t: Date.now(), codes: [...codes] }));
  } catch {}
  return codes;
}

function chaosSetMatchesFormat(s, standardCodes) {
  const rel = s.released_at || '0000-00-00';
  const fmt = state.chaosFormat || 'full';

  if (fmt === 'full') return true;
  if (fmt === 'standard') return standardCodes && standardCodes.has(s.code);
  if (fmt === 'modern') return rel >= MODERN_FIRST_RELEASE && rel <= todayISODate();
  if (fmt === 'pioneer') return rel >= PIONEER_FIRST_RELEASE && rel <= todayISODate();
  return true;
}

const CHAOS_SETS_CACHE_KEY = 'mtg_chaos_sets_v2';
const CHAOS_SETS_CACHE_MS = 24 * 60 * 60 * 1000;

async function fetchAllSetsFromScryfall() {
  const all = [];
  let url = 'https://api.scryfall.com/sets';
  while (url) {
    const res = await rateLimitedGet(url);
    if (!res || res.status !== 200) return null;
    const data = await res.json();
    all.push(...(data.data || []));
    url = data.has_more && data.next_page ? data.next_page : null;
  }
  return all;
}

async function getAllChaosSets() {
  const fmt = state.chaosFormat || 'full';

  try {
    const raw = sessionStorage.getItem(CHAOS_SETS_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.fmt === fmt && Date.now() - cached.t < CHAOS_SETS_CACHE_MS && Array.isArray(cached.codes) && cached.codes.length)
        return cached.codes;
    }
  } catch {}

  setStatus('Fetching valid sets for Chaos Draft...');
  let standardCodes = null;
  if (fmt === 'standard') {
    standardCodes = await fetchStandardLegalSetCodes();
    if (!standardCodes || !standardCodes.size) return [];
  }

  const setList = await fetchAllSetsFromScryfall();
  if (!setList) return [];

  const validTypes = new Set(['core', 'expansion', 'masters', 'draft_innovation']);
  const codes = setList
    .filter(s =>
      validTypes.has(s.set_type) &&
      !s.digital &&
      !s.parent_set_code &&
      !CHAOS_EXCLUDED_SETS.has(s.code) &&
      chaosSetMatchesFormat(s, standardCodes)
    )
    .map(s => s.code);

  try { sessionStorage.setItem(CHAOS_SETS_CACHE_KEY, JSON.stringify({ t: Date.now(), fmt, codes })); } catch {}
  return codes;
}

// ═══════════════════════════════════════════════════════════════
// POOL BUILDING
// ═══════════════════════════════════════════════════════════════
async function buildPools(setCode) {
  const info = await getSetInfo(setCode);
  if (!info) return null;

  const releaseDate = info.released_at || '1990-01-01';
  const isPlayBooster = releaseDate >= '2024-02-09'; // MKM onwards
  const setName = info.name || setCode.toUpperCase();

  setStatus(`Fetching card pool for ${setName}...`);
  let mainCards = await fetchCardsForQuery(`e:${setCode} is:booster -is:digital`);
  if (!mainCards.length) {
    setStatus(`No booster-flagged cards found for ${setName}, trying full set...`);
    mainCards = await fetchCardsForQuery(`e:${setCode} -is:digital`);
  }
  if (!mainCards.length) {
    setStatus(`No draftable cards found for ${setName}.`);
    return null;
  }

  const pools = {
    C: [], U: [], R: [], M: [], Basic: [], Bonus: [],
    DFC: [], Legendary: [], Planeswalker: [], Battle: [],
    DraftMatters: [], Gate: [], SnowLand: [], NonBasicLand: [], Lesson: [],
    Background: [],
  };

  for (const c of mainCards) {
    const rarity = c.rarity || 'common';
    const tl = (c.type_line || '').toLowerCase();

    const isDFC = c.card_faces && c.card_faces[0]?.image_uris;
    const isLegendary = tl.includes('legendary') && tl.includes('creature');
    const isPlaneswalker = tl.includes('planeswalker');
    const isBattle = tl.includes('battle');
    const isGate = tl.includes('gate');
    const isSnow = tl.includes('snow') && tl.includes('land');
    const isNonbasicLand = tl.includes('land') && !tl.includes('basic');
    const isDraftMatters = tl.includes('conspiracy') || c.watermark === 'conspiracy';
    const isLesson = tl.includes('lesson');
    const isBackground = tl.includes('background') && tl.includes('enchantment') && tl.includes('legendary');

    if (tl.includes('basic land')) pools.Basic.push(c);
    else if (rarity === 'common') pools.C.push(c);
    else if (rarity === 'uncommon') pools.U.push(c);
    else if (rarity === 'mythic') pools.M.push(c);
    else pools.R.push(c);

    if (isDFC) pools.DFC.push(c);
    if (isLegendary) pools.Legendary.push(c);
    if (isPlaneswalker) pools.Planeswalker.push(c);
    if (isBattle) pools.Battle.push(c);
    if (isDraftMatters) pools.DraftMatters.push(c);
    if (isGate) pools.Gate.push(c);
    if (isSnow) pools.SnowLand.push(c);
    if (isNonbasicLand) pools.NonBasicLand.push(c);
    if (isLesson) pools.Lesson.push(c);
    if (isBackground) pools.Background.push(c);
  }

  if (BONUS_SHEETS[setCode]) {
    for (const bCode of BONUS_SHEETS[setCode]) {
      setStatus(`Fetching bonus sheet: ${bCode.toUpperCase()}...`);
      const bonus = await fetchCardsForQuery(`e:${bCode} lang:en -is:digital`);
      pools.Bonus.push(...bonus);
    }
  }
  if (setCode === 'mh2') {
    setStatus('Fetching New-to-Modern reprints for MH2...');
    pools.Bonus = await fetchCardsForQuery('e:mh2 is:reprint lang:en -is:digital');
  }

  return { pools, isPlayBooster, setName, releaseDate };
}

function getBoosterLabel(setCode, isPlayBooster) {
  if (['arn','atq','drk','fem','hml'].includes(setCode)) return '8-Card Vintage Pack';
  if (['chr','all'].includes(setCode)) return '12-Card Vintage Pack';
  if (setCode === '2xm') return 'Double Masters (15 cards)';
  if (setCode === '2x2') return 'Double Masters 2022 (16 cards)';
  if (['cmr','clb'].includes(setCode)) return 'Commander Legends (20 cards)';
  if (setCode === 'sos') return 'Play Booster (14 cards + Mystical Archive)';
  if (isPlayBooster) return 'Play Booster (MKM+)';
  return '15-Card Draft Booster';
}

// ═══════════════════════════════════════════════════════════════
// PACK ROLLING  (ported 1:1 from Python)
// ═══════════════════════════════════════════════════════════════
function rollPack(pools, isPlayBooster, setCode, releaseDate) {
  const pack = [];
  const seenNames = new Set();

  function pull(poolKeys, allowDupe = false) {
    const keys = Array.isArray(poolKeys) ? [...poolKeys] : [poolKeys];
    keys.push('C', 'U', 'R', 'M', 'Basic');

    for (const key of keys) {
      const pool = pools[key];
      if (!pool || !pool.length) continue;
      const valid = allowDupe ? pool : pool.filter(c => !seenNames.has(c.name));
      if (valid.length) {
        const chosen = valid[Math.floor(Math.random() * valid.length)];
        seenNames.add(chosen.name);
        return chosen;
      }
      if (pool.length) {
        const chosen = pool[Math.floor(Math.random() * pool.length)];
        seenNames.add(chosen.name);
        return chosen;
      }
    }
    return null;
  }

  function pickFromPool(pool) {
    const valid = pool.filter(c => !seenNames.has(c.name));
    const src = valid.length ? valid : pool;
    if (!src.length) return null;
    const chosen = src[Math.floor(Math.random() * src.length)];
    seenNames.add(chosen.name);
    return chosen;
  }

  const rand = () => Math.random();

  // Vintage 8-card packs
  if (['arn','atq','drk','fem','hml'].includes(setCode)) {
    for (let i = 0; i < 2; i++) pack.push(pull(['U','R']));
    for (let i = 0; i < 6; i++) pack.push(pull('C'));
    return pack.filter(Boolean);
  }

  // Vintage 12-card packs
  if (['chr','all'].includes(setCode)) {
    pack.push(pull(['R','M','U']));
    for (let i = 0; i < 3; i++) pack.push(pull('U'));
    for (let i = 0; i < 8; i++) pack.push(pull('C'));
    return pack.filter(Boolean);
  }

  // Double Masters 2XM (15 cards: 2R + 3U + 8C + 2 foil)
  if (setCode === '2xm') {
    for (let i = 0; i < 2; i++) pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));
    for (let i = 0; i < 3; i++) pack.push(pull('U'));
    for (let i = 0; i < 8; i++) pack.push(pull('C'));
    for (let i = 0; i < 2; i++) {
      const r = rand();
      if (r < 0.05) pack.push(pull(['R','M'], true));
      else if (r < 0.25) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    return pack.filter(Boolean);
  }

  // Double Masters 2022 (16 cards: 2R + 3U + 8C + 2 foil + 1 Cryptic Spires)
  if (setCode === '2x2') {
    for (let i = 0; i < 2; i++) pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));
    for (let i = 0; i < 3; i++) pack.push(pull('U'));
    for (let i = 0; i < 8; i++) pack.push(pull('C'));
    for (let i = 0; i < 2; i++) {
      const r = rand();
      if (r < 0.05) pack.push(pull(['R','M'], true));
      else if (r < 0.25) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    const spires = pools.C.find(c => c.name === 'Cryptic Spires');
    if (spires) pack.push(spires);
    else pack.push(pull(['Basic', 'C']));
    return pack.filter(Boolean);
  }

  // Commander Legends CMR (20 cards: 13C + 3U + 1 R/M + 2 legends + 1 foil)
  if (setCode === 'cmr') {
    pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));
    for (let i = 0; i < 2; i++) pack.push(pull(['Legendary','U']));
    for (let i = 0; i < 3; i++) pack.push(pull('U'));
    for (let i = 0; i < 13; i++) pack.push(pull('C'));
    const r = rand();
    if (r < 0.05) pack.push(pull(['R','M'], true));
    else if (r < 0.25) pack.push(pull('U', true));
    else pack.push(pull('C', true));
    return pack.filter(Boolean);
  }

  // Commander Legends: Battle for Baldur's Gate CLB
  // 20 cards: 13C + 3U + 1 R/M + 1 Background + 1 Legendary creature/PW + 1 foil
  // Background: uncommon ~91.7%, rare ~8.3%. Creature/PW: uncommon ~69%, rare/mythic ~31%.
  if (setCode === 'clb') {
    pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));

    // Background legend slot — uncommon ~91.7%, rare ~8.3%
    if (pools.Background.length) {
      const bgU = pools.Background.filter(c => c.rarity === 'uncommon');
      const bgRM = pools.Background.filter(c => c.rarity === 'rare' || c.rarity === 'mythic');
      if (rand() < 0.083 && bgRM.length) pack.push(pickFromPool(bgRM));
      else pack.push(pickFromPool(bgU.length ? bgU : pools.Background));
    } else {
      pack.push(pull(['Legendary','U']));
    }

    // Creature/PW legend slot — uncommon ~69%, rare/mythic ~31%
    const legU = pools.Legendary.filter(c => c.rarity === 'uncommon');
    const legRM = pools.Legendary.filter(c => c.rarity === 'rare' || c.rarity === 'mythic');
    if (rand() < 0.31 && legRM.length) pack.push(pickFromPool(legRM));
    else pack.push(pickFromPool(legU.length ? legU : pools.Legendary));

    for (let i = 0; i < 3; i++) pack.push(pull('U'));
    for (let i = 0; i < 13; i++) pack.push(pull('C'));
    const r = rand();
    if (r < 0.05) pack.push(pull(['R','M'], true));
    else if (r < 0.25) pack.push(pull('U', true));
    else pack.push(pull('C', true));
    return pack.filter(Boolean);
  }

  // ── SECRETS OF STRIXHAVEN (SOS) Play Booster ──
  // 14 cards with guaranteed Mystical Archive (SOA) slot and ~1.82% Special Guests.
  // Source: https://magic.wizards.com/en/news/feature/collecting-secrets-of-strixhaven
  if (setCode === 'sos') {
    const archiveAll = pools.Bonus.filter(c => c.set === 'soa');
    const spgAll = pools.Bonus.filter(c => c.set === 'spg');
    const archiveU = archiveAll.filter(c => c.rarity === 'uncommon');
    const archiveR = archiveAll.filter(c => c.rarity === 'rare');
    const archiveM = archiveAll.filter(c => c.rarity === 'mythic');

    pack.push(pull(['Basic', 'C']));                                          // Slot 14: Land
    for (let i = 0; i < 5; i++) pack.push(pull('C'));                         // Slots 1-5: Commons

    // Slot 6: Common (~98.18%) or Special Guest (~1.82%)
    if (spgAll.length && rand() < 0.0182)
      pack.push(pickFromPool(spgAll));
    else
      pack.push(pull('C'));

    for (let i = 0; i < 3; i++) pack.push(pull('U'));                         // Slots 7-9: Uncommons

    // Slot 10: Wildcard — 39.1% C, 39.1% U, 19.5% R, 1.9% M
    { const r = rand();
      if (r < 0.019) pack.push(pull(['M', 'R'], true));
      else if (r < 0.214) pack.push(pull('R', true));
      else if (r < 0.605) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }

    // Slot 11: Rare/Mythic — ~83.7% R, ~16.3% M
    pack.push(rand() < 0.163 ? pull(['M', 'R']) : pull('R'));

    // Slot 12: Mystical Archive (guaranteed) — 87.5% U, 9.6% R, 2.9% M
    if (archiveAll.length) {
      const r = rand();
      let archPool;
      if (r < 0.029) archPool = archiveM.length ? archiveM : archiveR.length ? archiveR : archiveU;
      else if (r < 0.125) archPool = archiveR.length ? archiveR : archiveU;
      else archPool = archiveU.length ? archiveU : archiveAll;
      pack.push(pickFromPool(archPool.length ? archPool : archiveAll));
    }

    // Slot 13: Foil — 54.4% C, 33.6% U, 6.7% R, 1.1% M, 2.8% Archive U, <1% Archive R/M
    { const r = rand();
      if (r < 0.004 && (archiveR.length || archiveM.length))
        pack.push(pickFromPool([...archiveR, ...archiveM]));
      else if (r < 0.032 && archiveU.length)
        pack.push(pickFromPool(archiveU));
      else if (r < 0.043) pack.push(pull(['M', 'R'], true));
      else if (r < 0.110) pack.push(pull('R', true));
      else if (r < 0.446) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }

    return pack.filter(Boolean);
  }

  // ── OUTLAWS OF THUNDER JUNCTION (OTJ) Play Booster ──
  // 14 cards: guaranteed OTP (Breaking News) + separate BIG/SPG bonus slot.
  // OTP: 67% uncommon, 33% rare/mythic. BIG/SPG: 20% chance replacing a common.
  if (setCode === 'otj' && isPlayBooster) {
    const otpAll = pools.Bonus.filter(c => c.set === 'otp');
    const otpU = otpAll.filter(c => c.rarity === 'uncommon');
    const otpRM = otpAll.filter(c => c.rarity === 'rare' || c.rarity === 'mythic');
    const listAll = pools.Bonus.filter(c => c.set === 'big' || c.set === 'spg');

    pack.push(pull(['Basic','C']));                                          // Land slot
    pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));                 // Rare/Mythic
    for (let i = 0; i < 3; i++) pack.push(pull('U'));                        // 3 Uncommons

    // Guaranteed OTP slot — 67% uncommon, 33% rare/mythic
    if (otpAll.length) {
      if (rand() < 0.33 && otpRM.length)
        pack.push(pickFromPool(otpRM));
      else
        pack.push(pickFromPool(otpU.length ? otpU : otpAll));
    }

    // BIG/SPG bonus slot — 20% replaces a common (~18.5% BIG, ~1.5% SPG)
    if (listAll.length && rand() < 0.20)
      pack.push(pickFromPool(listAll));
    else
      pack.push(pull('C'));

    for (let i = 0; i < 5; i++) pack.push(pull('C'));                        // 5 Commons

    // Wildcard slot
    { const r = rand();
      if (r < 0.01) pack.push(pull(['M','R'], true));
      else if (r < 0.083) pack.push(pull('R', true));
      else if (r < 0.25) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    // Foil slot
    { const r = rand();
      if (r < 0.01) pack.push(pull(['M','R'], true));
      else if (r < 0.05) pack.push(pull('R', true));
      else if (r < 0.25) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    return pack.filter(Boolean);
  }

  // ── MODERN PLAY BOOSTERS (MKM 2024+) ──
  if (isPlayBooster) {
    const BONUS_RATE = { mkm: 0.125, blb: 0.015, dsk: 0.015, fdn: 0.015 };
    const bonusRate = BONUS_RATE[setCode] || 0.015;

    pack.push(pull(['Basic','C']));                                          // Land slot
    pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));                 // Rare/Mythic
    for (let i = 0; i < 3; i++) pack.push(pull('U'));                        // 3 Uncommons

    if (pools.Bonus.length && rand() < bonusRate)
      pack.push(pull('Bonus'));
    else
      pack.push(pull('C'));

    for (let i = 0; i < 6; i++) pack.push(pull('C'));                        // 6 Commons

    // Wildcard slot
    { const r = rand();
      if (r < 0.026) pack.push(pull(['M','R'], true));
      else if (r < 0.189) pack.push(pull('R', true));
      else if (r < 0.772) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    // Foil slot
    { const r = rand();
      if (r < 0.01) pack.push(pull(['M','R'], true));
      else if (r < 0.05) pack.push(pull('R', true));
      else if (r < 0.30) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    }
    return pack.filter(Boolean);
  }

  // ── STANDARD DRAFT BOOSTERS ──
  let cCount = 10, uCount = 3;

  // Land slot
  if (pools.Basic.length && !['dgm','frf','khm'].includes(setCode)) {
    pack.push(pull('Basic'));
  } else if (setCode === 'dgm') {
    pack.push(pull(['Gate','Basic']));
  } else if (setCode === 'frf') {
    pack.push(pull(['NonBasicLand','Basic']));
  } else if (setCode === 'khm') {
    pack.push(pull(['SnowLand','Basic']));
  } else {
    cCount = 11; // pre-Shards era: extra common instead
  }

  // Set-specific sub-slots
  let rareSlotFilled = false;

  // WAR: guaranteed planeswalker — if rare/mythic it IS the rare slot
  if (setCode === 'war') {
    const pw = pull(['Planeswalker','U']);
    if (pw) {
      pack.push(pw);
      const pwr = (pw.rarity || 'common');
      if (pwr === 'rare' || pwr === 'mythic') rareSlotFilled = true;
      else uCount--;
    }
  }

  // DOM: guaranteed legendary creature — if rare/mythic it IS the rare slot
  if (setCode === 'dom') {
    const leg = pull(['Legendary','U']);
    if (leg) {
      pack.push(leg);
      const lr = (leg.rarity || 'common');
      if (lr === 'rare' || lr === 'mythic') rareSlotFilled = true;
      else uCount--;
    }
  }

  if (setCode === 'mom')  { uCount--; pack.push(pull(['Battle','U'])); }
  if (['soi','emn','mid','vow','znr'].includes(setCode)) { cCount--; pack.push(pull(['DFC','C'])); }
  if (['cns','cn2'].includes(setCode)) { cCount--; pack.push(pull(['DraftMatters','C'])); }
  if (setCode === 'stx')  { cCount--; pack.push(pull(['Lesson','C'])); }

  // STX Mystical Archive: weighted rarity — 67% U, 26.4% R, 6.6% M
  if (setCode === 'stx' && pools.Bonus.length) {
    cCount--;
    const staU = pools.Bonus.filter(c => c.rarity === 'uncommon');
    const staR = pools.Bonus.filter(c => c.rarity === 'rare');
    const staM = pools.Bonus.filter(c => c.rarity === 'mythic');
    const r = rand();
    if (r < 0.066 && staM.length) pack.push(staM[Math.floor(rand() * staM.length)]);
    else if (r < 0.330 && staR.length) pack.push(staR[Math.floor(rand() * staR.length)]);
    else pack.push((staU.length ? staU : pools.Bonus)[Math.floor(rand() * (staU.length || pools.Bonus.length))]);
  } else if ((BONUS_SHEETS[setCode] && setCode !== 'stx') || setCode === 'mh2') {
    cCount--; pack.push(pull(['Bonus','C']));
  }

  // Rare/Mythic slot (skipped if WAR/DOM special card already filled it)
  if (!rareSlotFilled) {
    pack.push(rand() < 0.125 ? pull(['M','R']) : pull('R'));
  }

  // Uncommons
  for (let i = 0; i < uCount; i++) pack.push(pull('U'));

  // Commons (with foil slot logic)
  const mastersSets = new Set(['mma','mm2','mm3','ema','ima','a25','uma','cmm']);
  for (let i = 0; i < cCount; i++) {
    if (i === cCount - 1 && (mastersSets.has(setCode) || rand() < 0.15)) {
      const r = rand();
      if (r < 0.05) pack.push(pull(['R','M'], true));
      else if (r < 0.25) pack.push(pull('U', true));
      else pack.push(pull('C', true));
    } else {
      pack.push(pull('C'));
    }
  }

  return pack.filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// CARD PARSING  (mirrors Python parse_scryfall_card)
// ═══════════════════════════════════════════════════════════════
function formatMana(text) {
  if (!text) return '';
  return text.replace(/\{/g, '[').replace(/\}/g, ']');
}

function parseScryfallCard(card) {
  const rarity = (card.rarity || 'common')[0].toUpperCase();
  const faces = [];

  if (card.card_faces) {
    if (card.card_faces[0]?.image_uris) {
      // True DFC
      card.card_faces.forEach((face, i) => {
        faces.push({
          name: face.name || '',
          manaCost: formatMana(face.mana_cost || ''),
          typeLine: face.type_line || '',
          text: face.oracle_text || face.flavor_text || '',
          power: face.power,
          toughness: face.toughness,
          loyalty: face.loyalty || card.loyalty,
          imageUri: face.image_uris?.normal,
          artCropUri: face.image_uris?.art_crop,
          rarity,
          isDFC: true,
          dfcSide: i === 0 ? 'front' : 'back',
          scryfallId: card.id,
          allParts: card.all_parts,
        });
      });
    } else {
      // Adventure / Split / Flip -- single image, combined text
      const main = card.card_faces[0];
      let combinedText = main.oracle_text || main.flavor_text || '';
      for (const face of card.card_faces.slice(1)) {
        const sName = face.name || '';
        const sMana = formatMana(face.mana_cost || '');
        const sType = face.type_line || '';
        const sText = face.oracle_text || face.flavor_text || '';
        combinedText += `\n\n-- ${sName}  ${sMana} --`;
        if (sType) combinedText += `\n${sType}`;
        combinedText += `\n${sText}`;
      }
      faces.push({
        name: main.name || '',
        manaCost: formatMana(main.mana_cost || ''),
        typeLine: main.type_line || '',
        text: combinedText.trim(),
        power: main.power || card.power,
        toughness: main.toughness || card.toughness,
        loyalty: main.loyalty || card.loyalty,
        imageUri: card.image_uris?.normal,
        artCropUri: card.image_uris?.art_crop,
        rarity,
        isDFC: false,
        scryfallId: card.id,
        allParts: card.all_parts,
      });
    }
  } else {
    // Standard single-face
    faces.push({
      name: card.name || '',
      manaCost: formatMana(card.mana_cost || ''),
      typeLine: card.type_line || '',
      text: card.oracle_text || card.flavor_text || '',
      power: card.power,
      toughness: card.toughness,
      loyalty: card.loyalty,
      imageUri: card.image_uris?.normal,
      artCropUri: card.image_uris?.art_crop,
      rarity,
      isDFC: false,
      scryfallId: card.id,
      allParts: card.all_parts,
    });
  }
  return faces;
}

// Group a flat face array into physical cards: single-face → [face], DFC → [front, back].
function groupDFCFaces(faces) {
  const groups = [];
  let i = 0;
  while (i < faces.length) {
    const face = faces[i];
    if (face.isDFC && face.dfcSide === 'front' && faces[i + 1]?.dfcSide === 'back') {
      groups.push([face, faces[i + 1]]);
      i += 2;
    } else {
      groups.push([face]);
      i++;
    }
  }
  return groups;
}

function cardDisplayNamesFromFaces(faces) {
  return groupDFCFaces(faces).map(group =>
    group.length > 1
      ? `${group[0].name || '?'} // ${group[1].name || '?'}`
      : group[0].name || 'Unknown'
  );
}

function checklistLinesFromCardNames(names) {
  return names.map(n => `( ) ${n}`);
}

// ═══════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════
const state = {
  mode: 'set',
  setCode: '',
  cubeId: '',
  selectedBlock: '',
  numPacks: 1,
  numDrafters: 8,
  includeTokens: false,
  retroMode: false,
  thermalPreview: false,
  includeChecklistHeaders: false,
  gangPrinting: false,
  isPrintingCanceled: false,
  isPrinting: false,
  cubePackSize: 15,
  chaosFormat: 'full',
  allPackFaces: [],
  allPackHeaders: [],
};

// ═══════════════════════════════════════════════════════════════
// FLAVOR TEXT CYCLE  (burn-out effect adapted from manaburn.net)
// ═══════════════════════════════════════════════════════════════
let FLAVOR_TEXTS = [...FLAVOR_TEXTS_FALLBACK];

async function loadFlavorTexts() {
  try {
    const resp = await fetch('https://api.scryfall.com/cards/search?q=has%3Aflavortext+is%3Afirstprint+-is%3Areprint+-s%3Aanb+-s%3Aana+-s%3Aoana&order=random&page=1');
    if (!resp.ok) return;
    const data = await resp.json();
    const fetched = data.data
      .filter(c => c.flavor_text && c.flavor_text.length > 10 && c.flavor_text.length < 220)
      .map(c => ({ text: c.flavor_text, source: c.name }));
    if (fetched.length > 10) FLAVOR_TEXTS = fetched;
  } catch (_) { /* keep fallback */ }
}

loadFlavorTexts();

let flavorInterval = null;
let flavorBurnFrame = null;
let flavorIdx = -1;

function startFlavorCycle() {
  if (flavorInterval) return;
  const el = document.getElementById('flavor-text');
  if (!el) return;
  shuffleArray(FLAVOR_TEXTS);
  flavorIdx = -1;
  showNextFlavor(el, true);
  flavorInterval = setInterval(() => burnOutFlavor(el), BURN_CYCLE_MS);
}

function stopFlavorCycle() {
  if (flavorInterval) { clearInterval(flavorInterval); flavorInterval = null; }
  if (flavorBurnFrame) { cancelAnimationFrame(flavorBurnFrame); flavorBurnFrame = null; }
  const el = document.getElementById('flavor-text');
  if (el) { el.innerHTML = ''; el.classList.remove('fade-in'); }
  flavorIdx = -1;
}

function showNextFlavor(el, instant) {
  flavorIdx++;
  if (flavorIdx >= FLAVOR_TEXTS.length) {
    shuffleArray(FLAVOR_TEXTS);
    flavorIdx = 0;
  }
  const f = FLAVOR_TEXTS[flavorIdx];
  el.textContent = `${f.text}\n— ${f.source}`;
  el.classList.remove('fade-in');
  if (!instant) {
    void el.offsetWidth;
    el.classList.add('fade-in');
  }
}

function burnOutFlavor(container) {
  const text = container.textContent;
  if (!text) { showNextFlavor(container, false); return; }

  container.innerHTML = '';
  const chars = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      container.appendChild(document.createElement('br'));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'flavor-char';
    span.textContent = ch;
    container.appendChild(span);

    if (ch !== ' ') {
      chars.push({
        el: span,
        orig: ch,
        delay: Math.random() * BURN_STAGGER_MS,
        dur: BURN_CHAR_MS + (Math.random() - 0.5) * 120,
        floatY: -(14 + Math.random() * 18),
        driftX: (Math.random() - 0.5) * 8,
        progress: 0,
      });
    }
  }

  const start = performance.now();

  function tick(now) {
    const elapsed = now - start;
    let allDone = true;

    for (const c of chars) {
      const t = Math.max(0, elapsed - c.delay);
      c.progress = Math.min(1, t / c.dur);

      if (c.progress < 1) allDone = false;
      if (c.progress === 0) continue;

      const burnIdx = Math.max(0, Math.round((BURN_CHARS.length - 1) * (1 - c.progress)));
      const burnChar = c.progress > 0.08 ? BURN_CHARS[burnIdx] : c.orig;
      if (c.el.textContent !== burnChar) c.el.textContent = burnChar;

      const p = c.progress;
      c.el.style.transform = `translateY(${c.floatY * p}px) translateX(${c.driftX * p}px)`;
      c.el.style.opacity = (1 - p * p).toFixed(2);
    }

    if (allDone) {
      flavorBurnFrame = null;
      showNextFlavor(container, false);
    } else {
      flavorBurnFrame = requestAnimationFrame(tick);
    }
  }

  flavorBurnFrame = requestAnimationFrame(tick);
}

// ═══════════════════════════════════════════════════════════════
// UI HELPERS
// ═══════════════════════════════════════════════════════════════
function setProgress(pct) {
  document.getElementById('progress-fill').style.width = `${pct}%`;
  const track = document.getElementById('progress-track');
  if (track) track.setAttribute('aria-valuenow', String(Math.round(pct)));
}

function setStatus(msg) {
  const el = document.getElementById('progress-text');
  if (el) el.textContent = msg;
}

function showScreen(name) {
  document.getElementById('setup-screen').style.display = name === 'setup' ? '' : 'none';
  document.getElementById('progress-section').style.display = name === 'progress' ? '' : 'none';
  document.getElementById('results-section').style.display = name === 'results' ? '' : 'none';
  const printerBar = document.getElementById('printer-bar');
  if (printerBar) printerBar.style.display = name === 'results' ? '' : 'none';
  const addCardsBar = document.getElementById('add-cards-bar');
  if (addCardsBar && name !== 'results') addCardsBar.style.display = 'none';
  if (name === 'progress') startFlavorCycle(); else stopFlavorCycle();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function openHelpModal() {
  const overlay = document.getElementById('help-overlay');
  const btn = document.getElementById('help-btn');
  const closeBtn = document.getElementById('help-modal-close');
  overlay.classList.add('visible');
  overlay.setAttribute('aria-hidden', 'false');
  btn.setAttribute('aria-expanded', 'true');
  closeBtn.focus();
}

function closeHelpModal() {
  const overlay = document.getElementById('help-overlay');
  const btn = document.getElementById('help-btn');
  overlay.classList.remove('visible');
  overlay.setAttribute('aria-hidden', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.focus();
}

function rarityColor(r) {
  return { C: 'C', U: 'U', R: 'R', M: 'M' }[r] || 'C';
}

/** 1×1 transparent GIF — real Scryfall URLs live in data-lazy-src until the pack is expanded. */
const LAZY_CARD_IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function setCardImgLazy(img, uri) {
  if (!img) return;
  img.loading = 'lazy';
  if (!uri) {
    img.removeAttribute('src');
    delete img.dataset.lazySrc;
    return;
  }
  img.dataset.lazySrc = uri;
  img.src = LAZY_CARD_IMG_PLACEHOLDER;
  img.onerror = () => { img.style.display = 'none'; };
}

function hydrateLazyCardImg(img) {
  if (!img?.dataset.lazySrc) return Promise.resolve();
  const uri = img.dataset.lazySrc;
  return new Promise((resolve) => {
    const finish = () => {
      delete img.dataset.lazySrc;
      resolve();
    };
    img.onload = finish;
    img.onerror = () => {
      img.style.display = 'none';
      finish();
    };
    img.src = uri;
  });
}

function hydrateCardItemImages(item) {
  const imgs = item.querySelectorAll('img[data-lazy-src]');
  return Promise.all([...imgs].map(hydrateLazyCardImg));
}

async function hydratePackBlockImages(block) {
  const items = block.querySelectorAll('.card-item');
  await Promise.all([...items].map(hydrateCardItemImages));
}

function resetCardItemImagesToLazy(item) {
  const faces = item._faces;
  if (!faces) return;
  item.classList.remove('flipped');
  const front = item.querySelector('.card-front');
  const back = item.querySelector('.card-back');
  if (front) setCardImgLazy(front, faces[0]?.imageUri || '');
  if (back && faces[1]) setCardImgLazy(back, faces[1].imageUri || '');
}

function resetBlockImagesToLazy(block) {
  for (const item of block.querySelectorAll('.card-item')) resetCardItemImagesToLazy(item);
}

async function applyThermalPreviewToCardItems(items) {
  let n = 0;
  for (const item of items) {
    const faces = item._faces;
    if (!faces) continue;
    const frontImg = item.querySelector('.card-front');
    const backImg = item.querySelector('.card-back');
    if (frontImg && faces[0]) {
      try {
        const canvas = await renderCardToCanvas(faces[0]);
        frontImg.src = canvas.toDataURL('image/png');
        delete frontImg.dataset.lazySrc;
      } catch { /* keep placeholder or prior src */ }
    }
    if (backImg && faces[1]) {
      try {
        const canvas = await renderCardToCanvas(faces[1]);
        backImg.src = canvas.toDataURL('image/png');
        delete backImg.dataset.lazySrc;
      } catch { /* keep */ }
    }
    n++;
    if (n % 12 === 0) await sleep(0);
  }
}

async function applyThermalPreviewToScope(scopeEl) {
  await applyThermalPreviewToCardItems(scopeEl.querySelectorAll('.card-item'));
}

async function onPackSectionExpanded(block, isExpanded) {
  if (!block) return;
  if (isExpanded) {
    if (state.thermalPreview) await applyThermalPreviewToScope(block);
    else await hydratePackBlockImages(block);
  } else {
    resetBlockImagesToLazy(block);
  }
}

function buildCardElement(face) {
  const item = document.createElement('div');
  item.className = 'card-item';
  item._faces = [face];
  item.title = `${face.name}${face.manaCost ? '  ' + face.manaCost : ''}`;

  const img = document.createElement('img');
  img.className = 'card-front';
  img.alt = face.name;
  setCardImgLazy(img, face.imageUri || '');
  item.appendChild(img);

  const gem = document.createElement('div');
  gem.className = `rarity-gem ${rarityColor(face.rarity)}`;
  gem.textContent = face.rarity;
  item.appendChild(gem);

  return item;
}

function buildDFCElement(frontFace, backFace) {
  const item = document.createElement('div');
  item.className = 'card-item';
  item._faces = [frontFace, backFace];
  item.title = `${frontFace.name} // ${backFace.name}`;

  const frontImg = document.createElement('img');
  frontImg.className = 'card-front';
  frontImg.alt = frontFace.name;
  setCardImgLazy(frontImg, frontFace.imageUri || '');
  item.appendChild(frontImg);

  const backImg = document.createElement('img');
  backImg.className = 'card-back';
  backImg.alt = backFace.name;
  setCardImgLazy(backImg, backFace.imageUri || '');
  item.appendChild(backImg);

  const gem = document.createElement('div');
  gem.className = `rarity-gem ${rarityColor(frontFace.rarity)}`;
  gem.textContent = frontFace.rarity;
  item.appendChild(gem);

  const flipBtn = document.createElement('button');
  flipBtn.className = 'flip-btn';
  flipBtn.textContent = '↔';
  flipBtn.title = 'Flip card';
  flipBtn.setAttribute('aria-label', `Flip ${frontFace.name}`);
  flipBtn.addEventListener('click', e => {
    e.stopPropagation();
    item.classList.toggle('flipped');
  });
  item.appendChild(flipBtn);

  return item;
}

function renderPackBlock(header, cards) {
  const block = document.createElement('div');
  block.className = 'pack-block';

  state.allPackFaces.push(cards);
  state.allPackHeaders.push(header);

  const ph = document.createElement('div');
  ph.className = 'pack-header';
  ph.innerHTML = `
    <span class="pack-chevron">►</span>
    <span class="pack-title">${escHtml(header.title)}</span>
    <span class="pack-meta">${escHtml(header.setName)}</span>
    <span class="pack-badge">${escHtml(header.type)}</span>
    <span class="pack-badge">${cards.length} cards</span>
  `;

  ph.setAttribute('tabindex', '0');
  ph.setAttribute('role', 'button');
  ph.setAttribute('aria-expanded', 'false');
  const togglePack = () => {
    block.classList.toggle('expanded');
    const isExpanded = block.classList.contains('expanded');
    ph.setAttribute('aria-expanded', String(isExpanded));
    const chevron = ph.querySelector('.pack-chevron');
    if (chevron) chevron.textContent = isExpanded ? '▼' : '►';
      onPackSectionExpanded(block, isExpanded).catch(err => console.error(err));
  };
  ph.addEventListener('click', (e) => {
    if (e.target.closest('.pack-print-btn')) return;
    togglePack();
  });
  ph.addEventListener('keydown', (e) => {
    if (e.target.closest('.pack-print-btn')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePack(); }
  });

  const printBtn = document.createElement('button');
  printBtn.className = 'pack-print-btn';
  printBtn.textContent = 'Print Pack';
  printBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    printPack(cards, header, printBtn);
  });
  ph.appendChild(printBtn);

  block.appendChild(ph);

  const grid = document.createElement('div');
  grid.className = 'card-grid';

  const packIdx = state.allPackFaces.length - 1;
  groupDFCFaces(cards).forEach((group, cardGroupIdx) => {
    const el = group.length > 1
      ? buildDFCElement(group[0], group[1])
      : buildCardElement(group[0]);
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
    const capturedIdx = cardGroupIdx;
    const capturedPack = packIdx;
    const openCard = (e) => {
      if (e.target.closest('.flip-btn')) return;
      openLightbox(capturedPack, capturedIdx);
    };
    el.addEventListener('click', openCard);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(e); }
    });
    grid.appendChild(el);
  });

  block.appendChild(grid);
  return block;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════════
// TOKEN DETECTION
// ═══════════════════════════════════════════════════════════════
async function collectTokens(packCardsList, tokenCache) {
  const newTokens = {};
  for (const card of packCardsList) {
    for (const part of (card.all_parts || [])) {
      if (part.component !== 'token') continue;
      if (part.id === card.id) continue;
      const uri = part.uri;
      if (!uri) continue;
      if (!tokenCache[uri]) {
        const data = await fetchTokenData(uri);
        if (data) tokenCache[uri] = data;
      }
      if (tokenCache[uri]) newTokens[uri] = tokenCache[uri];
    }
  }
  return newTokens;
}

// ═══════════════════════════════════════════════════════════════
// MAIN DRAFT GENERATOR
// ═══════════════════════════════════════════════════════════════
async function generateDraft() {
  // Read UI state
  state.numPacks = parseInt(document.getElementById('num-packs').value) || 1;
  state.numDrafters = parseInt(document.getElementById('num-drafters')?.value) || 8;
  state.includeTokens = document.getElementById('include-tokens').checked;
  state.cubePackSize = parseInt(document.getElementById('cube-pack-size')?.value) || 15;

  const genBtn = document.getElementById('generate-btn');
  genBtn.disabled = true;

  showScreen('progress');
  setProgress(0);
  setStatus('Preparing draft...');

  const packsContainer = document.getElementById('packs-container');
  const tokensContainer = document.getElementById('tokens-container');
  packsContainer.innerHTML = '';
  tokensContainer.innerHTML = '';
  document.getElementById('tokens-section').style.display = 'none';
  document.getElementById('error-banner').innerHTML = '';
  state.allPackFaces = [];
  state.allPackHeaders = [];
  state.isPrintingCanceled = false;
  document.getElementById('cancel-print-btn').style.display = 'none';
  document.getElementById('print-all-btn').style.display = 'none';

  const poolCache = {};
  const tokenCache = {};
  const globalTokens = {};
  let draftSequence = [];
  let cubeList = [];
  let cubeIndex = 0;
  let validChaosSets = [];
  let titleStr = 'Draft Complete';

  try {
    // ── Build draft sequence ──
    if (state.mode === 'block') {
      const blockSets = HISTORICAL_BLOCKS[state.selectedBlock];
      if (!blockSets) {
        showError('Please select a block first.');
        showScreen('setup');
        genBtn.disabled = false;
        return;
      }
      draftSequence = [];
      for (let d = 0; d < state.numDrafters; d++) {
        draftSequence.push(...blockSets);
      }
      titleStr = `${titleCapital(state.selectedBlock)} Block Draft`;

    } else if (state.mode === 'cube') {
      const pasteEl = document.getElementById('cube-paste');
      const pastedText = pasteEl?.value.trim();
      let cubeEntries = [];

      if (pastedText) {
        cubeEntries = parseCardList(pastedText);
      } else {
        let cId = (document.getElementById('cube-id-input')?.value || '').trim();
        const urlMatch = cId.match(/cube\/(?:list|overview|playtest)\/([^/?&]+)/i);
        if (urlMatch) cId = urlMatch[1];
        state.cubeId = cId;
        const rawNames = await getCubeList(cId);
        if (rawNames) {
          cubeEntries = rawNames.map(name => ({ qty: 1, name, set: null, collectorNumber: null }));
        }
      }

      if (!cubeEntries.length) {
        showError('Could not fetch cube list from CubeCobra. Check the cube ID and try again. You can also paste a card list directly into the text area below the cube ID field.');
        showScreen('setup');
        genBtn.disabled = false;
        return;
      }

      // Expand entries into individual slots preserving identity
      const cubeSlots = [];
      for (const entry of cubeEntries) {
        for (let c = 0; c < entry.qty; c++) {
          cubeSlots.push({ name: entry.name, set: entry.set, collectorNumber: entry.collectorNumber });
        }
      }

      shuffleArray(cubeSlots);

      // Only keep the cards we actually need for the requested packs
      const cardsNeeded = state.numPacks * state.cubePackSize;
      const slotsToFetch = cubeSlots.slice(0, cardsNeeded);

      setStatus('Fetching cube cards...');
      setProgress(5);

      const { lookup: cardLookup } = await batchFetchCardLookup(slotsToFetch);

      setProgress(25);

      const cubePool = [];
      for (const slot of slotsToFetch) {
        const card = cardLookup[entryLookupKey(slot)];
        if (card) cubePool.push(card);
      }

      if (!cubePool.length) {
        showError('No cards could be fetched for this cube. Check your list or cube ID.');
        showScreen('setup');
        genBtn.disabled = false;
        return;
      }

      setProgress(30);
      cubeList = cubePool;
      cubeIndex = 0;
      draftSequence = Array(state.numPacks).fill('cube');
      titleStr = `Cube Draft -- ${state.cubeId || 'Pasted List'}`;

    } else if (state.mode === 'chaos') {
      validChaosSets = await getAllChaosSets();
      if (!validChaosSets.length) {
        showError('Failed to fetch set list for Chaos Draft.');
        showScreen('setup');
        genBtn.disabled = false;
        return;
      }
      // Independent random picks (same set may appear more than once)
      draftSequence = Array.from({ length: state.numPacks }, () =>
        validChaosSets[Math.floor(Math.random() * validChaosSets.length)]
      );
      titleStr = 'Chaos Draft';

    } else {
      // Standard set
      const rawCode = document.getElementById('set-code-input')?.value.trim().toLowerCase() || '';
      if (!rawCode) { showScreen('setup'); genBtn.disabled = false; return; }

      if (typeof SCRYFALL_SETS !== 'undefined' && !SCRYFALL_SETS[rawCode]) {
        showError(`"${rawCode}" is not a valid set code. Check scryfall.com/sets for codes.`);
        showScreen('setup');
        genBtn.disabled = false;
        return;
      }

      state.setCode = rawCode || 'dft';
      draftSequence = Array(state.numPacks).fill(state.setCode);
      titleStr = `Set Draft`;
    }

    const total = draftSequence.length;
    let done = 0;
    const pendingPacks = [];
    const chaosPoolBuildFailed = new Set();
    let chaosReplaceAttempts = 0;

    // ── Fetch all pools and roll all packs on the progress screen ──
    for (let packIdx = 0; packIdx < draftSequence.length; packIdx++) {
      const currentCode = draftSequence[packIdx];
      let packCards = [];
      let header = {};

      if (currentCode === 'cube') {
        header = { title: `Pack ${packIdx + 1}`, setName: `Cube: ${state.cubeId || 'Pasted List'}`, type: 'Cube Pack' };
        setStatus(`Drawing cube pack ${packIdx + 1} of ${total}...`);

        if (cubeIndex >= cubeList.length) {
          setStatus(`Cube pool exhausted — not enough cards for ${total} packs.`);
          break;
        }

        while (packCards.length < state.cubePackSize && cubeIndex < cubeList.length) {
          packCards.push(cubeList[cubeIndex++]);
        }

        if (!packCards.length) break;

      } else {
        // Standard set / chaos / block
        if (!poolCache[currentCode]) {
          setStatus(`Building pool for ${currentCode.toUpperCase()}... (${packIdx + 1}/${total})`);
          const result = await buildPools(currentCode);
          if (!result) {
            if (state.mode === 'chaos') {
              chaosPoolBuildFailed.add(currentCode);
              setStatus(`Skipping ${currentCode} — pool build failed, picking another set...`);

              let candidates = validChaosSets.filter(s => !chaosPoolBuildFailed.has(s));
              if (!candidates.length) {
                candidates = validChaosSets.filter(s => s !== currentCode);
              }
              if (!candidates.length) {
                showError('Chaos draft: no other sets left in this format pool. Try fewer packs or a wider pool (e.g. Full chaos).');
                break;
              }

              chaosReplaceAttempts++;
              if (chaosReplaceAttempts > Math.max(validChaosSets.length * 3, 40)) {
                showError('Chaos draft: too many pool build failures in a row. Check your connection or try again.');
                break;
              }

              draftSequence[packIdx] = candidates[Math.floor(Math.random() * candidates.length)];
              packIdx--;
              continue;
            }
            showError(`Failed to build pool for set: ${currentCode}.`);
            break;
          }
          poolCache[currentCode] = result;
          chaosReplaceAttempts = 0;
        } else if (state.mode === 'chaos') {
          chaosReplaceAttempts = 0;
        }

        const { pools, isPlayBooster, setName, releaseDate } = poolCache[currentCode];
        const boosterType = getBoosterLabel(currentCode, isPlayBooster);

        let packTitle, packMeta;
        if (state.mode === 'block') {
          const drafterNum = Math.floor(packIdx / HISTORICAL_BLOCKS[state.selectedBlock].length) + 1;
          const packNum = (packIdx % HISTORICAL_BLOCKS[state.selectedBlock].length) + 1;
          packTitle = `Drafter ${drafterNum} -- Pack ${packNum}`;
          packMeta = setName;
        } else {
          packTitle = `Pack ${packIdx + 1} of ${total}`;
          packMeta = setName;
        }

        header = { title: packTitle, setName: packMeta, type: boosterType };

        setStatus(`Rolling ${packMeta} pack ${packIdx + 1} of ${total}...`);
        packCards = rollPack(pools, isPlayBooster, currentCode, releaseDate);
      }

      // Parse faces and stash for rendering after progress completes
      const allFaces = [];
      for (const card of packCards) {
        allFaces.push(...parseScryfallCard(card));
      }
      pendingPacks.push({ header, allFaces, packCards });

      // Token collection
      if (state.includeTokens) {
        setStatus(`Collecting tokens for pack ${packIdx + 1}...`);
        const newToks = await collectTokens(packCards, tokenCache);
        Object.assign(globalTokens, newToks);
      }

      done++;
      setProgress(Math.round((done / total) * 100));
      await sleep(0);
    }

    // ── All data ready — transition to results ──
    setProgress(100);
    setStatus('Rendering packs...');
    await sleep(0);

    showScreen('results');
    document.getElementById('results-title').textContent = titleStr;

    for (const { header, allFaces } of pendingPacks) {
      const packBlock = renderPackBlock(header, allFaces);
      packsContainer.appendChild(packBlock);
    }

    // Render tokens (collapsed by default, like packs)
    if (state.includeTokens && Object.keys(globalTokens).length) {
      const tSection = document.getElementById('tokens-section');
      tSection.style.display = '';
      tSection.classList.remove('expanded');
      const tHeader = document.getElementById('tokens-header');
      if (tHeader) tHeader.setAttribute('aria-expanded', 'false');
      const tChevron = tSection.querySelector('.pack-chevron');
      if (tChevron) tChevron.textContent = '►';
      let tokenCount = 0;
      for (const tokenData of Object.values(globalTokens)) {
        const faces = parseScryfallCard(tokenData);
        if (faces[0]) {
          tokensContainer.appendChild(buildCardElement(faces[0]));
          tokenCount++;
        }
      }
      const countBadge = document.getElementById('tokens-count');
      if (countBadge) countBadge.textContent = `${tokenCount} tokens`;
    }

    updatePrinterUI();

  } catch (err) {
    showError(`Draft generation error: ${err.message}`);
    console.error(err);
  }

  genBtn.disabled = false;
}

// ═══════════════════════════════════════════════════════════════
// SETUP UI RENDERERS
// ═══════════════════════════════════════════════════════════════
function renderModeInputs(mode) {
  const container = document.getElementById('mode-inputs');
  const draftersGroup = document.getElementById('drafters-group');
  const packsGroup = document.getElementById('packs-group');
  container.innerHTML = '';
  draftersGroup.style.display = 'none';
  packsGroup.style.display = '';

  if (mode === 'set') {
    container.innerHTML = `
      <div class="form-group">
        <label for="set-code-input">Set Code</label>
        <input type="text" id="set-code-input" placeholder="e.g. dsk, lci, ktk, mh3" maxlength="8" spellcheck="false" autocomplete="off">
        <p class="hint">Find set codes on <a href="https://scryfall.com/sets" target="_blank">Scryfall Sets</a>.</p>
      </div>`;
    document.getElementById('packs-group').querySelector('label').textContent = 'Number of Packs';
    const setInput = document.getElementById('set-code-input');
    const genBtn = document.getElementById('generate-btn');
    setInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('num-packs').focus(); }
    });
    setInput.addEventListener('input', () => {
      if (typeof SCRYFALL_SETS === 'undefined') return;
      const code = setInput.value.trim().toLowerCase();
      genBtn.disabled = code.length > 0 && !SCRYFALL_SETS[code];
    });

  } else if (mode === 'chaos') {
    container.innerHTML = `
      <div class="form-group">
        <p class="hint" style="font-size:0.9rem;color:var(--text2)">Each pack is a random draftable set; the same set can show up more than once.</p>
      </div>
      <div class="form-group" style="margin-top:8px">
        <label style="font-size:0.85rem;color:var(--text);font-weight:600">Format pool</label>
        <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
          <label class="toggle-row" style="font-size:0.84rem">
            <input type="radio" name="chaos-format" value="full" checked style="accent-color:var(--accent)">
            <span style="color:var(--text2)">Full chaos (all paper draftable sets)</span>
          </label>
          <label class="toggle-row" style="font-size:0.84rem">
            <input type="radio" name="chaos-format" value="standard" style="accent-color:var(--accent)">
            <span style="color:var(--text2)">Standard (sets with Standard-legal cards)</span>
          </label>
          <label class="toggle-row" style="font-size:0.84rem">
            <input type="radio" name="chaos-format" value="modern" style="accent-color:var(--accent)">
            <span style="color:var(--text2)">Modern (8th Edition through today)</span>
          </label>
          <label class="toggle-row" style="font-size:0.84rem">
            <input type="radio" name="chaos-format" value="pioneer" style="accent-color:var(--accent)">
            <span style="color:var(--text2)">Pioneer (Return to Ravnica through today)</span>
          </label>
        </div>
      </div>`;
    const savedFmt = state.chaosFormat || 'full';
    const radio = container.querySelector(`input[name="chaos-format"][value="${savedFmt}"]`);
    if (radio) radio.checked = true;
    container.querySelectorAll('input[name="chaos-format"]').forEach(r => {
      r.addEventListener('change', () => { state.chaosFormat = r.value; saveSettings(); });
    });

  } else if (mode === 'block') {
    const blockNames = Object.keys(HISTORICAL_BLOCKS);
    const listHtml = blockNames.map(b =>
      `<div class="block-item" data-block="${escHtml(b)}">${titleCapital(b)}</div>`
    ).join('');

    container.innerHTML = `
      <div class="form-group">
        <label id="block-list-label">Select Block</label>
        <div class="block-list" role="listbox" aria-labelledby="block-list-label">${listHtml}</div>
        <p class="hint" style="margin-top:6px">Each drafter receives 3 packs (one per set in block order).</p>
      </div>`;

    draftersGroup.style.display = '';
    packsGroup.style.display = 'none';

    container.querySelectorAll('.block-item').forEach(el => {
      el.setAttribute('role', 'option');
      el.setAttribute('aria-selected', 'false');
      el.setAttribute('tabindex', '0');
      const selectBlock = () => {
        container.querySelectorAll('.block-item').forEach(e => {
          e.classList.remove('selected');
          e.setAttribute('aria-selected', 'false');
        });
        el.classList.add('selected');
        el.setAttribute('aria-selected', 'true');
        state.selectedBlock = el.dataset.block;
      };
      el.addEventListener('click', selectBlock);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectBlock(); }
      });
    });

  } else if (mode === 'cube') {
    container.innerHTML = `
      <div class="form-group">
        <label for="cube-id-input">CubeCobra Cube ID or URL</label>
        <input type="text" id="cube-id-input" placeholder="e.g.  vintage_cube  or full URL" spellcheck="false" autocomplete="off">
        <p class="hint">Paste the cube ID or a CubeCobra URL.</p>
      </div>
      <div class="form-group">
        <label>-- or paste card list directly --</label>
        <textarea id="cube-paste" placeholder="One card name per line (optional -- overrides Cube ID)"></textarea>
      </div>
      <div class="form-group">
        <label for="cube-pack-size">Cards per Pack</label>
        <input type="number" id="cube-pack-size" min="1" max="50" value="${state.cubePackSize}">
      </div>`;

    const cubeInput = document.getElementById('cube-id-input');
    cubeInput.addEventListener('input', () => { state.cubeId = cubeInput.value.trim(); });
    cubeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cube-pack-size').focus(); }
    });
    document.getElementById('cube-pack-size').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('num-packs').focus(); }
    });
    document.getElementById('cube-pack-size').addEventListener('change', () => saveSettings());
  }
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  el.innerHTML = `<div class="banner error">${escHtml(msg)}</div>`;
}

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function titleCapital(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

// ═══════════════════════════════════════════════════════════════
// PRINT ALL PACKS
// ═══════════════════════════════════════════════════════════════
async function printAllPacks() {
  if (!state.allPackFaces.length) return;
  if (!(await ensurePrinterConnected())) return;

  state.isPrintingCanceled = false;
  state.isPrinting = true;
  const cancelBtn = document.getElementById('cancel-print-btn');
  const printAllBtn = document.getElementById('print-all-btn');
  cancelBtn.style.display = '';
  printAllBtn.disabled = true;
  printAllBtn.textContent = 'Printing All...';

  try {
    for (let p = 0; p < state.allPackFaces.length; p++) {
      if (state.isPrintingCanceled) break;
      setPrintingIndicator(`Printing pack ${p + 1} of ${state.allPackFaces.length}...`);
      await printPack(state.allPackFaces[p], state.allPackHeaders[p], null);
    }

    if (!state.isPrintingCanceled) {
      setPrintingIndicator('All packs printed successfully!');
      setTimeout(() => setPrintingIndicator(''), 4000);
    }
  } catch (err) {
    if (!state.isPrintingCanceled) {
      setPrintingIndicator(`Print error: ${err.message}`);
      console.error(err);
    }
  } finally {
    state.isPrinting = false;
    cancelBtn.style.display = 'none';
    printAllBtn.disabled = false;
    printAllBtn.textContent = 'Print All Packs';
  }
}

function cancelPrint() {
  state.isPrintingCanceled = true;
  setPrintingIndicator('Print canceled by user.');
  document.getElementById('cancel-print-btn').style.display = 'none';
  setTimeout(() => {
    if (!state.isPrinting) setPrintingIndicator('');
  }, 3000);
}

// ═══════════════════════════════════════════════════════════════
// THERMAL PRINT PREVIEW
// ═══════════════════════════════════════════════════════════════
async function toggleThermalPreview(enabled) {
  state.thermalPreview = enabled;
  const allItems = document.querySelectorAll('#packs-container .card-item, #tokens-container .card-item');
  if (!allItems.length) return;

  if (enabled) {
    const blocks = [...document.querySelectorAll('#packs-container .pack-block.expanded')];
    const tokSec = document.getElementById('tokens-section');
    if (tokSec?.classList.contains('expanded')) blocks.push(tokSec);
    if (!blocks.length) {
      setPrintingIndicator('Thermal preview: expand a pack to render (or Expand All).');
      setTimeout(() => setPrintingIndicator(''), 4500);
      return;
    }
    setPrintingIndicator('Rendering thermal previews…');
    for (const block of blocks) await applyThermalPreviewToScope(block);
    setPrintingIndicator('');
    return;
  }

  setPrintingIndicator('Restoring card images…');
  let processed = 0;
  for (const item of allItems) {
    resetCardItemImagesToLazy(item);
    processed++;
    if (processed % 30 === 0) {
      setPrintingIndicator(`Restoring card images… ${processed}/${allItems.length}`);
      await sleep(0);
    }
  }
  const expandedBlocks = [...document.querySelectorAll('#packs-container .pack-block.expanded')];
  const tokSec2 = document.getElementById('tokens-section');
  if (tokSec2?.classList.contains('expanded')) expandedBlocks.push(tokSec2);
  for (const block of expandedBlocks) await hydratePackBlockImages(block);
  setPrintingIndicator('');
}

// ═══════════════════════════════════════════════════════════════
// QUICK PRINT (Single Card)
// ═══════════════════════════════════════════════════════════════

let _quickPrintBusy = false;

function parseSetCollector(input) {
  if (/\s/.test(input) || input.length < 4) return null;
  for (const len of [3, 4, 5, 2]) {
    if (len >= input.length) continue;
    const set = input.slice(0, len);
    const num = input.slice(len);
    if (/^[a-z0-9]+$/i.test(set) && /^\d+[a-z]?$/i.test(num)) {
      return { set: set.toLowerCase(), collectorNumber: num };
    }
  }
  return null;
}

async function quickPrintFrom(inputId) {
  if (_quickPrintBusy) return;
  const input = document.getElementById(inputId);
  const raw = (input?.value || '').trim();
  if (!raw) return;
  if (!(await ensurePrinterConnected())) return;

  _quickPrintBusy = true;

  const statusMsg = (msg) => {
    setPrintingIndicator(msg);
    const sStatus = document.getElementById('setup-printer-status');
    if (sStatus) sStatus.textContent = msg;
  };

  try {
    let qty = 1;
    let rest = raw;
    const qtyMatch = raw.match(/^(\d+)\s+(.+)$/);
    if (qtyMatch) {
      qty = Math.max(1, parseInt(qtyMatch[1], 10));
      rest = qtyMatch[2].trim();
    }
    rest = resolveNickname(rest);

    let card = null;
    const sc = parseSetCollector(rest);
    if (sc) {
      statusMsg(`Fetching ${sc.set.toUpperCase()} #${sc.collectorNumber} from Scryfall...`);
      card = await fetchCardBySetCollector(sc.set, sc.collectorNumber);
      if (!card) {
        statusMsg(`Set/collector not found, trying as card name...`);
        card = await fetchCardByName(rest);
      }
    } else {
      statusMsg(`Fetching "${rest}" from Scryfall...`);
      card = await fetchCardByName(rest);
    }

    if (!card) {
      statusMsg(`Card not found: "${rest}"`);
      setTimeout(() => statusMsg(''), 4000);
      return;
    }

    const faces = parseScryfallCard(card);
    state.isPrintingCanceled = false;

    const groups = groupDFCFaces(faces);

    await printerSend(new Uint8Array([0x1B, 0x40]));

    for (let copy = 0; copy < qty; copy++) {
      if (state.isPrintingCanceled) break;
      for (const group of groups) {
        if (state.isPrintingCanceled) break;
        for (let fi = 0; fi < group.length; fi++) {
          if (state.isPrintingCanceled) break;
          await printCardFace(group[fi], fi === group.length - 1, true);
        }
      }
    }

    if (!state.isPrintingCanceled) {
      statusMsg(`Printed${qty > 1 ? ` ${qty}x` : ''}: ${card.name}`);
      setTimeout(() => statusMsg(''), 3000);
    }
    input.value = '';
  } catch (err) {
    statusMsg(`Print error: ${err.message}`);
    console.error('Quick print error:', err);
    setTimeout(() => statusMsg(''), 5000);
  } finally {
    _quickPrintBusy = false;
  }
}

async function quickPrint() { return quickPrintFrom('quick-print-input'); }

// ═══════════════════════════════════════════════════════════════
// LIST PRINT (Setup Screen)
// ═══════════════════════════════════════════════════════════════

function parseCardList(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const entries = [];
  const reFull = /^(\d+)\s+(.+?)\s+\(([^)]+)\)\s+(\S+)$/;
  const reQtyName = /^(\d+)\s+(.+)$/;
  for (const line of lines) {
    const mFull = line.match(reFull);
    if (mFull) {
      entries.push({
        qty: parseInt(mFull[1], 10),
        name: mFull[2].trim(),
        set: mFull[3].trim().toLowerCase(),
        collectorNumber: mFull[4].trim(),
      });
    } else {
      const mQty = line.match(reQtyName);
      if (mQty) {
        entries.push({
          qty: parseInt(mQty[1], 10),
          name: resolveNickname(mQty[2].trim()),
          set: null,
          collectorNumber: null,
        });
      } else {
        entries.push({
          qty: 1,
          name: resolveNickname(line),
          set: null,
          collectorNumber: null,
        });
      }
    }
  }
  return entries;
}

const _cardBySetCollectorCache = {};
async function fetchCardBySetCollector(setCode, collectorNumber) {
  const cacheKey = `${setCode}/${collectorNumber}`;
  if (_cardBySetCollectorCache[cacheKey]) return _cardBySetCollectorCache[cacheKey];
  const url = `https://api.scryfall.com/cards/${encodeURIComponent(setCode)}/${encodeURIComponent(collectorNumber)}`;
  const res = await rateLimitedGet(url);
  if (res && res.status === 200) {
    const data = await res.json();
    _cardBySetCollectorCache[cacheKey] = data;
    return data;
  }
  return null;
}

async function resolveCardEntries(entries) {
  const { lookup: cardLookup } = await batchFetchCardLookup(entries);
  const faces = [];
  const skipped = [];
  for (const entry of entries) {
    const card = cardLookup[entryLookupKey(entry)];
    if (!card) {
      skipped.push(entry.set ? `${entry.name} (${entry.set.toUpperCase()}) ${entry.collectorNumber}` : entry.name);
    } else {
      const parsed = parseScryfallCard(card);
      for (let c = 0; c < entry.qty; c++) faces.push(...parsed);
    }
  }
  return { faces, skipped };
}

function renderExpandedPackBlock(container, header, faces) {
  const block = renderPackBlock(header, faces);
  block.classList.add('expanded');
  const ph = block.querySelector('.pack-header');
  if (ph) ph.setAttribute('aria-expanded', 'true');
  const chevron = block.querySelector('.pack-chevron');
  if (chevron) chevron.textContent = '▼';
  container.appendChild(block);
  onPackSectionExpanded(block, true).catch(err => console.error(err));
  return block;
}

function showSkippedWarning(skipped, append) {
  if (!skipped.length) return;
  const el = document.getElementById('error-banner');
  const prefix = append ? el.innerHTML : '';
  el.innerHTML = prefix + `<div class="banner warn">Skipped ${skipped.length} card(s) not found: ${escHtml(skipped.join(', '))}</div>`;
}

async function loadCardList() {
  const textarea = document.getElementById('print-list-input');
  const statusEl = document.getElementById('print-list-status');
  const rawText = (textarea?.value || '').trim();
  if (!rawText) return;

  const entries = parseCardList(rawText);
  if (!entries.length) {
    if (statusEl) statusEl.textContent = 'No valid lines found.';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
    return;
  }

  const btn = document.getElementById('print-list-btn');
  if (btn) btn.disabled = true;

  showScreen('progress');
  setProgress(0);
  setStatus('Fetching card list...');

  const packsContainer = document.getElementById('packs-container');
  const tokensContainer = document.getElementById('tokens-container');
  packsContainer.innerHTML = '';
  tokensContainer.innerHTML = '';
  document.getElementById('tokens-section').style.display = 'none';
  document.getElementById('error-banner').innerHTML = '';
  state.allPackFaces = [];
  state.allPackHeaders = [];
  state.isPrintingCanceled = false;
  document.getElementById('cancel-print-btn').style.display = 'none';
  document.getElementById('print-all-btn').style.display = 'none';

  try {
    setStatus('Fetching cards...');
    setProgress(10);
    const { faces, skipped } = await resolveCardEntries(entries);
    setProgress(90);

    showScreen('results');
    document.getElementById('results-title').textContent = 'Card List';

    showSkippedWarning(skipped, false);

    if (faces.length) {
      const header = { title: 'Card List', setName: `${faces.length} card(s)`, type: 'List' };
      renderExpandedPackBlock(packsContainer, header, faces);
    }

    setProgress(100);
    updatePrinterUI();
    document.getElementById('add-cards-bar').style.display = '';
  } catch (err) {
    showError(`List loading error: ${err.message}`);
    console.error(err);
  }

  if (btn) btn.disabled = false;
}

async function addMoreCards() {
  const textarea = document.getElementById('add-cards-input');
  const statusEl = document.getElementById('add-cards-status');
  const rawText = (textarea?.value || '').trim();
  if (!rawText) return;

  const entries = parseCardList(rawText);
  if (!entries.length) {
    if (statusEl) statusEl.textContent = 'No valid lines found.';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
    return;
  }

  const addBtn = document.getElementById('add-cards-btn');
  if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Loading...'; }
  if (statusEl) statusEl.textContent = 'Fetching cards...';

  try {
    const { faces: newFaces, skipped } = await resolveCardEntries(entries);

    if (!newFaces.length) {
      if (statusEl) statusEl.textContent = 'No cards found.';
      setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
      return;
    }

    let existingBlock = document.querySelector('#packs-container .pack-block');

    if (!existingBlock) {
      const header = { title: 'Card List', setName: `${newFaces.length} card(s)`, type: 'List' };
      renderExpandedPackBlock(document.getElementById('packs-container'), header, newFaces);
    } else {
      const grid = existingBlock.querySelector('.card-grid');
      const packIdx = 0;
      const existingFaces = state.allPackFaces[packIdx] || [];

      let cardGroupIdx = groupDFCFaces(existingFaces).length;

      existingFaces.push(...newFaces);

      const newCardItems = [];
      const newGroups = groupDFCFaces(newFaces);
      newGroups.forEach((group) => {
        const el = group.length > 1
          ? buildDFCElement(group[0], group[1])
          : buildCardElement(group[0]);
        el.setAttribute('tabindex', '0');
        el.setAttribute('role', 'button');
        const capturedIdx = cardGroupIdx;
        const openCard = (e) => {
          if (e.target.closest('.flip-btn')) return;
          openLightbox(packIdx, capturedIdx);
        };
        el.addEventListener('click', openCard);
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCard(e); }
        });
        grid.appendChild(el);
        newCardItems.push(el);
        cardGroupIdx++;
      });

      if (existingBlock.classList.contains('expanded') && newCardItems.length) {
        (async () => {
          try {
            if (state.thermalPreview) await applyThermalPreviewToCardItems(newCardItems);
            else await Promise.all(newCardItems.map(hydrateCardItemImages));
          } catch (err) { console.error(err); }
        })();
      }

      const badges = existingBlock.querySelectorAll('.pack-badge');
      const lastBadge = badges[badges.length - 1];
      if (lastBadge) lastBadge.textContent = `${existingFaces.length} cards`;
      const header = state.allPackHeaders[packIdx];
      if (header) header.setName = `${existingFaces.length} card(s)`;
      const metaEl = existingBlock.querySelector('.pack-meta');
      if (metaEl) metaEl.textContent = `${existingFaces.length} card(s)`;
    }

    showSkippedWarning(skipped, true);

    textarea.value = '';
    if (statusEl) statusEl.textContent = `Added ${newFaces.length} card(s).`;
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 4000);
    updatePrinterUI();
  } catch (err) {
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
    console.error(err);
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = 'Add to List'; }
  }
}

// ═══════════════════════════════════════════════════════════════
// LOCAL STORAGE PERSISTENCE
// ═══════════════════════════════════════════════════════════════
const LS_KEY = 'mtg_draft_settings';

function saveSettings() {
  const clChk = document.getElementById('include-checklist-headers-toggle');
  if (clChk) state.includeChecklistHeaders = clChk.checked;

  const data = {
    mode: state.mode,
    numPacks: state.numPacks,
    numDrafters: state.numDrafters,
    includeTokens: state.includeTokens,
    gangPrinting: document.getElementById('gang-print-toggle')?.checked || false,
    includeChecklistHeaders: state.includeChecklistHeaders,
    setCode: document.getElementById('set-code-input')?.value || '',
    cubeId: document.getElementById('cube-id-input')?.value || '',
    cubePackSize: parseInt(document.getElementById('cube-pack-size')?.value) || 15,
    chaosFormat: state.chaosFormat,
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch {}
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);

    if (data.mode) {
      state.mode = data.mode;
      document.querySelectorAll('.mode-btn').forEach(b => {
        const isActive = b.dataset.mode === data.mode;
        b.classList.toggle('active', isActive);
        b.setAttribute('aria-pressed', String(isActive));
      });
      renderModeInputs(data.mode);
    }
    if (data.numPacks) {
      state.numPacks = data.numPacks;
      const el = document.getElementById('num-packs');
      if (el) el.value = data.numPacks;
    }
    if (data.numDrafters) {
      state.numDrafters = data.numDrafters;
      const el = document.getElementById('num-drafters');
      if (el) el.value = data.numDrafters;
    }
    if (data.includeTokens != null) {
      state.includeTokens = data.includeTokens;
      const el = document.getElementById('include-tokens');
      if (el) el.checked = data.includeTokens;
    }
    if (data.gangPrinting != null) {
      const el = document.getElementById('gang-print-toggle');
      if (el) el.checked = data.gangPrinting;
    }
    if (data.includeChecklistHeaders != null) {
      state.includeChecklistHeaders = data.includeChecklistHeaders;
      const cl = document.getElementById('include-checklist-headers-toggle');
      if (cl) cl.checked = data.includeChecklistHeaders;
    }
    if (data.chaosFormat) {
      state.chaosFormat = data.chaosFormat;
    } else if (data.chaosEra) {
      const m = { all: 'full', 'modern-frame': 'modern', 'modern-era': 'pioneer' };
      state.chaosFormat = m[data.chaosEra] || 'full';
    }
    // Set code / cube ID are restored when their mode panel renders
    if (data.setCode && data.mode === 'set') {
      setTimeout(() => {
        const el = document.getElementById('set-code-input');
        if (el) { el.value = data.setCode; el.dispatchEvent(new Event('input')); }
      }, 50);
    }
    if (data.cubeId && data.mode === 'cube') {
      setTimeout(() => {
        const el = document.getElementById('cube-id-input');
        if (el) el.value = data.cubeId;
      }, 50);
    }
    if (data.cubePackSize && data.mode === 'cube') {
      state.cubePackSize = data.cubePackSize;
      setTimeout(() => {
        const el = document.getElementById('cube-pack-size');
        if (el) el.value = data.cubePackSize;
      }, 50);
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// KONAMI CODE EASTER EGG (↑↑↓↓←→←→)
// ═══════════════════════════════════════════════════════════════
function setupKonamiCode() {
  const sequence = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight'];
  const buffer = [];

  document.addEventListener('keydown', (e) => {
    buffer.push(e.key);
    if (buffer.length > sequence.length) buffer.shift();

    if (buffer.length === sequence.length && buffer.every((k, i) => k === sequence[i])) {
      buffer.length = 0;
      state.retroMode = !state.retroMode;
      document.body.classList.toggle('retro', state.retroMode);

      if (state.thermalPreview) {
        toggleThermalPreview(true);
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════
// EVENT WIRING & INIT
// ═══════════════════════════════════════════════════════════════
function init() {
  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('active');
      btn.setAttribute('aria-pressed', 'true');
      state.mode = btn.dataset.mode;
      renderModeInputs(state.mode);
      saveSettings();
    });
  });

  // Generate button
  document.getElementById('generate-btn').addEventListener('click', async () => {
    saveSettings();
    await generateDraft();
  });

  // Copy Pool as Text
  document.getElementById('copy-pool-btn').addEventListener('click', async () => {
    const lines = [];
    for (let p = 0; p < state.allPackFaces.length; p++) {
      const hdr = state.allPackHeaders[p];
      lines.push(`// ${hdr.title} — ${hdr.setName} [${hdr.type}]`);
      const seen = new Set();
      for (const face of state.allPackFaces[p]) {
        if (face.isDFC && face.dfcSide === 'back') continue;
        const name = face.name || 'Unknown';
        if (!seen.has(name)) { lines.push(name); seen.add(name); }
      }
      lines.push('');
    }
    const text = lines.join('\n').trim();
    const btn = document.getElementById('copy-pool-btn');
    const orig = btn.textContent;
    const flashCopied = () => {
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    };
    try {
      await navigator.clipboard.writeText(text);
      flashCopied();
    } catch (err) {
      console.error(err);
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) flashCopied();
        else console.warn('Clipboard copy failed (no permission or unsupported)');
      } catch (e2) {
        console.error(e2);
      }
    }
  });

  // Expand / Collapse All
  const expandAllBtn = document.getElementById('expand-all-btn');
  expandAllBtn.addEventListener('click', () => {
    const blocksArr = [...document.querySelectorAll('#packs-container .pack-block, #tokens-section.pack-block')];
    const wasExpanded = blocksArr.map(b => b.classList.contains('expanded'));
    const allExpanded = wasExpanded.every(Boolean);
    const nextExpanded = !allExpanded;
    blocksArr.forEach(b => {
      b.classList.toggle('expanded', nextExpanded);
      const ph = b.querySelector('.pack-header');
      if (ph) {
        ph.setAttribute('aria-expanded', String(nextExpanded));
        const chevron = ph.querySelector('.pack-chevron');
        if (chevron) chevron.textContent = nextExpanded ? '▼' : '►';
      }
    });
    expandAllBtn.textContent = allExpanded ? '▼ Expand All' : '► Collapse All';
    (async () => {
      try {
        for (let i = 0; i < blocksArr.length; i++) {
          if (wasExpanded[i] !== nextExpanded) await onPackSectionExpanded(blocksArr[i], nextExpanded);
        }
      } catch (err) { console.error(err); }
    })();
  });

  // New draft button
  document.getElementById('new-draft-btn').addEventListener('click', () => {
    showScreen('setup');
    document.getElementById('generate-btn').disabled = false;
    expandAllBtn.textContent = '▼ Expand All';
  });

  // Printer connect/disconnect toggle
  document.getElementById('connect-printer-btn').addEventListener('click', async () => {
    if (printerState.connected) {
      await disconnectPrinter();
    } else {
      await connectPrinter();
    }
  });

  // Print All Packs
  document.getElementById('print-all-btn').addEventListener('click', () => printAllPacks());

  // Cancel Print
  document.getElementById('cancel-print-btn').addEventListener('click', () => cancelPrint());

  // Thermal Preview toggle
  document.getElementById('thermal-preview-toggle').addEventListener('change', (e) => {
    toggleThermalPreview(e.target.checked);
  });

  document.getElementById('include-checklist-headers-toggle').addEventListener('change', (e) => {
    state.includeChecklistHeaders = e.target.checked;
    saveSettings();
  });

  // Gang Print checkbox → save settings
  document.getElementById('gang-print-toggle').addEventListener('change', () => saveSettings());

  // Quick Print (results screen)
  document.getElementById('quick-print-btn').addEventListener('click', () => quickPrintFrom('quick-print-input'));
  document.getElementById('quick-print-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); quickPrintFrom('quick-print-input'); }
  });

  // Quick Print (setup screen)
  document.getElementById('setup-quick-print-btn').addEventListener('click', () => quickPrintFrom('setup-quick-print-input'));
  document.getElementById('setup-quick-print-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); quickPrintFrom('setup-quick-print-input'); }
  });
  document.getElementById('setup-printer-connect-btn').addEventListener('click', async () => {
    if (printerState.connected) await disconnectPrinter();
    else await connectPrinter();
  });

  // Print List (setup screen) — loads into results view
  document.getElementById('print-list-btn').addEventListener('click', () => loadCardList());

  // Add More Cards (results screen, card list mode)
  document.getElementById('add-cards-btn').addEventListener('click', () => addMoreCards());

  // Tokens section collapse/expand
  const tokensHeader = document.getElementById('tokens-header');
  const tokensSection = document.getElementById('tokens-section');
  const toggleTokens = () => {
    tokensSection.classList.toggle('expanded');
    const isExpanded = tokensSection.classList.contains('expanded');
    tokensHeader.setAttribute('aria-expanded', String(isExpanded));
    const chevron = tokensHeader.querySelector('.pack-chevron');
    if (chevron) chevron.textContent = isExpanded ? '▼' : '►';
    onPackSectionExpanded(tokensSection, isExpanded).catch(err => console.error(err));
  };
  tokensHeader.addEventListener('click', toggleTokens);
  tokensHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTokens(); }
  });

  // Enter on num-packs / num-drafters triggers generate
  document.getElementById('num-packs').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSettings(); generateDraft(); }
  });
  document.getElementById('num-drafters').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveSettings(); generateDraft(); }
  });

  // Persist settings on form changes
  document.getElementById('num-packs').addEventListener('change', () => saveSettings());
  document.getElementById('num-drafters').addEventListener('change', () => saveSettings());
  document.getElementById('include-tokens').addEventListener('change', () => saveSettings());

  // Help modal with focus trap (WCAG 2.4.7, 1.3.2)
  const helpBtn = document.getElementById('help-btn');
  const helpOverlay = document.getElementById('help-overlay');
  const helpClose = document.getElementById('help-modal-close');

  helpBtn.addEventListener('click', openHelpModal);
  helpClose.addEventListener('click', closeHelpModal);
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) closeHelpModal();
  });
  helpOverlay.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      const focusable = helpOverlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Konami Code easter egg
  setupKonamiCode();

  // Card lightbox keyboard navigation
  setupLightboxKeys();

  // Restore saved settings then render mode inputs
  renderModeInputs('set');
  loadSettings();
  showScreen('setup');
}

// ═══════════════════════════════════════════════════════════════
// PRINTER SUBSYSTEM -- WebUSB + ESC/POS
// Mirrors the Python script's print pipeline using Canvas 2D for
// card rendering, Floyd-Steinberg dithering, and WebUSB for transport.
// ═══════════════════════════════════════════════════════════════

// ── PRINTER STATE ──
const printerState = {
  device: null,
  endpointNumber: 1,
  connected: false,
};

const PRINT_CARD_W = 600;   // matches Python WIDTH
const PRINT_CARD_H = 938;   // matches Python HEIGHT
const PRINTER_WIDTH_PX = 576; // 80mm thermal roll

// ── IMAGE HELPERS ──

function loadImageForCanvas(uri) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${uri}`));
    img.src = uri;
  });
}

/** Word-wrap text for canvas using measureText -- mirrors Python wrap_text */
function wrapTextForPrint(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    const words = paragraph.split(' ');
    let current = words[0] || '';
    for (const word of words.slice(1)) {
      const test = current + ' ' + word;
      if (ctx.measureText(test).width <= maxWidth) {
        current = test;
      } else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Matches Python ImageEnhance.Brightness(factor) */
function applyBrightness(imageData, factor) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = Math.min(255, d[i]   * factor);
    d[i+1] = Math.min(255, d[i+1] * factor);
    d[i+2] = Math.min(255, d[i+2] * factor);
  }
}

/** Matches Python ImageEnhance.Contrast(factor) */
function applyContrast(imageData, factor) {
  const d = imageData.data;
  const intercept = 128 * (1 - factor);
  for (let i = 0; i < d.length; i += 4) {
    d[i]   = Math.min(255, Math.max(0, d[i]   * factor + intercept));
    d[i+1] = Math.min(255, Math.max(0, d[i+1] * factor + intercept));
    d[i+2] = Math.min(255, Math.max(0, d[i+2] * factor + intercept));
  }
}

/**
 * Floyd-Steinberg dithering -- mirrors Pillow's native C-backend dither used
 * by Python's fast_dither(). Returns Uint8Array where 0=black, 1=white.
 * Reuses typed-array buffers across calls to avoid GC pressure during print jobs.
 */
const _ditherBuf = { gray: null, result: null, size: 0 };

function floydSteinbergDither(imageData) {
  const { width, height, data } = imageData;
  const pixels = width * height;

  if (pixels > _ditherBuf.size) {
    _ditherBuf.gray = new Float32Array(pixels);
    _ditherBuf.result = new Uint8Array(pixels);
    _ditherBuf.size = pixels;
  }
  const gray = _ditherBuf.gray;
  const result = _ditherBuf.result;

  for (let i = 0; i < pixels; i++) {
    gray[i] = 0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2];
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const old = gray[idx];
      const neu = old < 128 ? 0 : 255;
      result[idx] = neu === 255 ? 1 : 0;
      const err = old - neu;
      if (x + 1 < width)                gray[idx + 1]         += err * 7 / 16;
      if (y + 1 < height) {
        if (x > 0)                       gray[idx + width - 1] += err * 3 / 16;
                                          gray[idx + width]     += err * 5 / 16;
        if (x + 1 < width)               gray[idx + width + 1] += err * 1 / 16;
      }
    }
  }
  return result.subarray(0, pixels);
}

// ── CARD RENDERER ──

/**
 * Port of Python's generate_card_image().
 * Returns an offscreen 600×938 canvas with the full thermal card layout.
 * Uses M (margin) to prevent printer edge clipping.
 * Reuses a single canvas for sequential render calls.
 */
let _renderCanvas = null;
async function renderCardToCanvas(face) {
  const W = PRINT_CARD_W, H = PRINT_CARD_H;
  const M = 8;
  const UW = W - M * 2;

  if (!_renderCanvas) {
    _renderCanvas = document.createElement('canvas');
    _renderCanvas.width = W; _renderCanvas.height = H;
  }
  const canvas = _renderCanvas;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = 'black';

  let y = M;

  // ── 1. Name + Mana Cost ──
  let titleSize = 32;
  ctx.font = `bold ${titleSize}px monospace`;
  const mana = face.manaCost || '';
  let manaW = ctx.measureText(mana).width;

  const dfcStr = face.dfcSide === 'front' ? (state.retroMode ? '[^]' : '\u25b2') : face.dfcSide === 'back' ? (state.retroMode ? '[v]' : '\u25bc') : '';
  let dfcW = dfcStr ? ctx.measureText(dfcStr).width + 8 : 0;

  while (ctx.measureText(face.name).width + manaW + dfcW + 10 > UW && titleSize > 10) {
    titleSize--;
    ctx.font = `bold ${titleSize}px monospace`;
    manaW = ctx.measureText(mana).width;
    if (dfcStr) dfcW = ctx.measureText(dfcStr).width + 8;
  }

  let titleX = M;
  if (dfcStr) {
    ctx.fillText(dfcStr, titleX, y + titleSize);
    titleX += ctx.measureText(dfcStr).width + 8;
  }
  ctx.fillText(face.name, titleX, y + titleSize);
  if (mana) ctx.fillText(mana, W - M - manaW, y + titleSize);
  y += titleSize + 6;

  // ── 2. Calculate layout dimensions (matches Python remaining_height logic) ──
  const typeSize = 26;
  ctx.font = `bold ${typeSize}px monospace`;

  const ptHeight = (face.power != null && face.toughness != null) ? 40
                 : (face.loyalty != null)                         ? 48 : 0;

  const remaining = H - (y + typeSize + 15 + ptHeight + M);

  // Text sizing: start at 47px to match Python, shrink dynamically
  let textSize = 47;
  const lineSpacing = 4;
  let wrappedLines = [];
  let textHeight = 0;

  if (face.text) {
    ctx.font = `${textSize}px monospace`;
    wrappedLines = wrapTextForPrint(ctx, face.text, UW);
    textHeight = wrappedLines.length * (textSize + lineSpacing);
    const textMax = Math.floor(remaining * 0.5);
    while (textHeight > textMax && textSize >= 16) {
      textSize -= 2;
      ctx.font = `${textSize}px monospace`;
      wrappedLines = wrapTextForPrint(ctx, face.text, UW);
      textHeight = wrappedLines.length * (textSize + lineSpacing);
    }
    if (textHeight > textMax) textHeight = textMax;
  }

  const artH = Math.max(0, remaining - textHeight - 10);

  // ── 3. Draw Art ──
  if (face.artCropUri && artH > 10) {
    try {
      const artImg = await loadImageForCanvas(face.artCropUri);

      if (state.retroMode) {
        const asciiChars = ['@', '#', '8', '&', 'o', ':', '*', '.', ' '];
        const asciFontSize = 14;
        ctx.font = `${asciFontSize}px monospace`;
        const charW = ctx.measureText('A').width || 8;
        const charH = asciFontSize;
        const cols = Math.floor(UW / charW);
        const rows = Math.floor(artH / charH);

        if (cols > 0 && rows > 0) {
          const sampleCanvas = document.createElement('canvas');
          sampleCanvas.width = cols; sampleCanvas.height = rows;
          const sCtx = sampleCanvas.getContext('2d');

          const artRatio = artImg.naturalWidth / artImg.naturalHeight;
          const targetRatio = cols / rows;
          let sx, sy, sw, sh;
          if (artRatio > targetRatio) {
            sh = artImg.naturalHeight; sw = sh * targetRatio;
            sy = 0; sx = (artImg.naturalWidth - sw) / 2;
          } else {
            sw = artImg.naturalWidth; sh = sw / targetRatio;
            sx = 0; sy = (artImg.naturalHeight - sh) / 2;
          }
          sCtx.drawImage(artImg, sx, sy, sw, sh, 0, 0, cols, rows);

          const sData = sCtx.getImageData(0, 0, cols, rows);
          applyBrightness(sData, 1.4);
          applyContrast(sData, 1.6);

          ctx.fillStyle = 'black';
          ctx.fillText('-'.repeat(cols), M, y + asciFontSize);
          let artY = y + charH;
          for (let row = 0; row < rows; row++) {
            let line = '';
            for (let col = 0; col < cols; col++) {
              const idx = (row * cols + col) * 4;
              const gray = 0.299 * sData.data[idx] + 0.587 * sData.data[idx+1] + 0.114 * sData.data[idx+2];
              const charIdx = Math.min(asciiChars.length - 1, Math.floor((gray / 255) * (asciiChars.length - 1)));
              line += asciiChars[charIdx];
            }
            ctx.fillText(line, M, artY + asciFontSize);
            artY += charH;
          }
          ctx.fillText('-'.repeat(cols), M, artY + asciFontSize);
        }
      } else {
        const artW = UW;
        const artRatio = artImg.naturalWidth / artImg.naturalHeight;
        const targetRatio = artW / artH;
        let sx, sy, sw, sh;
        if (artRatio > targetRatio) {
          sh = artImg.naturalHeight; sw = sh * targetRatio;
          sy = 0; sx = (artImg.naturalWidth - sw) / 2;
        } else {
          sw = artImg.naturalWidth; sh = sw / targetRatio;
          sx = 0; sy = (artImg.naturalHeight - sh) / 2;
        }

        const artCanvas = document.createElement('canvas');
        artCanvas.width = artW; artCanvas.height = artH;
        const artCtx = artCanvas.getContext('2d');
        artCtx.drawImage(artImg, sx, sy, sw, sh, 0, 0, artW, artH);

        const artData = artCtx.getImageData(0, 0, artW, artH);
        applyBrightness(artData, 1.2);
        applyContrast(artData, 1.1);

        const dithered = floydSteinbergDither(artData);
        const outData = artCtx.createImageData(artW, artH);
        for (let i = 0; i < dithered.length; i++) {
          const v = dithered[i] ? 255 : 0;
          outData.data[i*4] = v; outData.data[i*4+1] = v;
          outData.data[i*4+2] = v; outData.data[i*4+3] = 255;
        }
        artCtx.putImageData(outData, 0, 0);
        ctx.drawImage(artCanvas, M, y);

        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.strokeRect(M, y, artW, artH);
      }
    } catch {
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 1;
      ctx.strokeRect(M, y, UW, artH);
      ctx.font = '18px monospace';
      ctx.fillStyle = 'black';
      ctx.fillText('[Art Unavailable]', M + 10, y + artH / 2);
    }
  }
  y += artH + 8;

  // ── 4. Type Line + Rarity ──
  ctx.font = `bold ${typeSize}px monospace`;
  ctx.fillStyle = 'black';
  ctx.fillText(face.typeLine, M, y + typeSize);
  const rarityStr = face.rarity || 'C';
  const rarityW = ctx.measureText(rarityStr).width;
  ctx.fillText(rarityStr, W - M - rarityW, y + typeSize);
  y += typeSize + 10;

  // ── 5. Oracle Text ──
  if (wrappedLines.length) {
    ctx.font = `${textSize}px monospace`;
    ctx.fillStyle = 'black';
    for (const line of wrappedLines) {
      if (y + textSize > H - ptHeight - M) break;
      ctx.fillText(line, M, y + textSize);
      y += textSize + lineSpacing;
    }
  }

  // ── 6. P/T Box ──
  if (face.power != null && face.toughness != null) {
    ctx.font = 'bold 30px monospace';
    if (state.retroMode) {
      const ptStr = `[ ${face.power} / ${face.toughness} ]`;
      const ptW = ctx.measureText(ptStr).width;
      ctx.fillStyle = 'black';
      ctx.fillText(ptStr, W - M - ptW, H - M - 10);
    } else {
      const ptStr = `${face.power} / ${face.toughness}`;
      const ptW = ctx.measureText(ptStr).width;
      ctx.fillStyle = 'white';
      ctx.fillRect(W - M - ptW - 16, H - 48, ptW + 16, 48);
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.strokeRect(W - M - ptW - 16, H - 48, ptW + 16, 48);
      ctx.fillStyle = 'black';
      ctx.fillText(ptStr, W - M - ptW - 8, H - 10);
    }
  }

  // ── 7. Loyalty ──
  if (face.loyalty != null) {
    ctx.font = 'bold 30px monospace';
    if (state.retroMode) {
      const loyStr = `{ ${face.loyalty} }`;
      const loyW = ctx.measureText(loyStr).width;
      let x0 = W - M - loyW;
      if (face.power != null && face.toughness != null) {
        const ptStr = `[ ${face.power} / ${face.toughness} ]`;
        x0 -= (ctx.measureText(ptStr).width + 16);
      }
      ctx.fillStyle = 'black';
      ctx.fillText(loyStr, x0, H - M - 10);
    } else {
      const loyStr = String(face.loyalty);
      const loyW = ctx.measureText(loyStr).width;
      const boxW = Math.max(loyW + 24, 48);
      const boxH = 48;

      let x0 = W - M - boxW;
      if (face.power != null && face.toughness != null) {
        const ptW = ctx.measureText(`${face.power} / ${face.toughness}`).width;
        x0 -= (ptW + 24);
      }
      const y0 = H - boxH;

      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0 + boxW, y0);
      ctx.lineTo(x0 + boxW, H - 16);
      ctx.lineTo(x0 + boxW / 2, H);
      ctx.lineTo(x0, H - 16);
      ctx.closePath();
      ctx.fillStyle = 'white';
      ctx.fill();
      ctx.strokeStyle = 'black';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = 'black';
      ctx.fillText(loyStr, x0 + (boxW - loyW) / 2, y0 + 6 + 30);
    }
  }

  return canvas;
}

// ── PRINT PIPELINE ──

/**
 * Port of Python process_for_print():
 * Rotate 90° clockwise then resize to PRINTER_WIDTH_PX wide.
 */
let _rotCanvas = null;
let _finalCanvas = null;

function processForPrint(cardCanvas) {
  const rotW = cardCanvas.height;
  const rotH = cardCanvas.width;

  if (!_rotCanvas) _rotCanvas = document.createElement('canvas');
  _rotCanvas.width  = rotW;
  _rotCanvas.height = rotH;
  const rotCtx = _rotCanvas.getContext('2d');
  rotCtx.setTransform(1, 0, 0, 1, 0, 0);
  rotCtx.translate(rotW, 0);
  rotCtx.rotate(Math.PI / 2);
  rotCtx.drawImage(cardCanvas, 0, 0);

  const ratio = PRINTER_WIDTH_PX / rotW;
  const targetH = Math.round(rotH * ratio);

  if (!_finalCanvas) _finalCanvas = document.createElement('canvas');
  _finalCanvas.width  = PRINTER_WIDTH_PX;
  _finalCanvas.height = targetH;
  _finalCanvas.getContext('2d').drawImage(_rotCanvas, 0, 0, PRINTER_WIDTH_PX, targetH);
  return _finalCanvas;
}

/**
 * Convert a canvas (already B&W) to ESC/POS GS v 0 raster command bytes.
 * ESC/POS bit=1 means print dot (black); dithered 0=black maps to bit=1.
 */
function canvasToEscPosRaster(canvas) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, width, height);
  const dithered = floydSteinbergDither(imgData); // 0=black, 1=white

  const bytesPerRow = Math.ceil(width / 8);
  const rasterData = new Uint8Array(bytesPerRow * height);

  for (let row = 0; row < height; row++) {
    for (let byteX = 0; byteX < bytesPerRow; byteX++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const x = byteX * 8 + bit;
        if (x < width && dithered[row * width + x] === 0) {
          // 0=black → set bit (ESC/POS: 1 = print dot)
          byte |= (0x80 >> bit);
        }
      }
      rasterData[row * bytesPerRow + byteX] = byte;
    }
  }

  // GS v 0 -- raster bit image command
  const cmd = new Uint8Array(8 + rasterData.length);
  cmd[0] = 0x1D; cmd[1] = 0x76; cmd[2] = 0x30; cmd[3] = 0x00; // GS v 0 normal
  cmd[4] = bytesPerRow & 0xFF;         // xL
  cmd[5] = (bytesPerRow >> 8) & 0xFF;  // xH
  cmd[6] = height & 0xFF;              // yL
  cmd[7] = (height >> 8) & 0xFF;       // yH
  cmd.set(rasterData, 8);
  return cmd;
}

/** Send raw bytes to the printer in 16KB chunks via WebUSB transferOut */
async function printerSend(data) {
  if (!printerState.device) throw new Error('Printer not connected');
  const CHUNK = 16384;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    await printerState.device.transferOut(
      printerState.endpointNumber,
      data.slice(offset, offset + CHUNK),
    );
  }
}

// ── PRINTER MANAGEMENT ──

/** If disconnected, opens the browser WebUSB device picker (same as Connect Printer). */
async function ensurePrinterConnected() {
  if (printerState.connected) return true;
  await connectPrinter();
  return printerState.connected;
}

async function connectPrinter() {
  if (!navigator.usb) {
    setPrinterStatus('WebUSB not supported -- use Chrome or Edge.', false);
    return;
  }
  try {
    // No vendor filter -- lets the user pick any ESC/POS printer
    const device = await navigator.usb.requestDevice({ filters: [] });
    await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);

    // Prefer USB Printer class (0x07), fall back to interface 0
    let ifaceNum = 0;
    for (const iface of device.configuration.interfaces) {
      if (iface.alternates.some(a => a.interfaceClass === 7)) {
        ifaceNum = iface.interfaceNumber;
        break;
      }
    }
    await device.claimInterface(ifaceNum);

    // Find the OUT bulk endpoint
    let epNum = 1;
    const iface = device.configuration.interfaces.find(i => i.interfaceNumber === ifaceNum);
    if (iface) {
      for (const ep of iface.alternates[0].endpoints) {
        if (ep.direction === 'out') { epNum = ep.endpointNumber; break; }
      }
    }

    printerState.device = device;
    printerState.endpointNumber = epNum;
    printerState.connected = true;

    // Initialize printer -- speed + density commands from original Python
    await printerSend(new Uint8Array([0x1B, 0x40]));         // ESC @ -- reset
    await printerSend(new Uint8Array([0x1f,0x1b,0x1f,0x01])); // Speed 2
    await printerSend(new Uint8Array([0x1f,0x1b,0x1f,0x0a])); // Density 10

    updatePrinterUI();
    setPrinterStatus(`Connected: ${device.productName || 'Printer'}`, true);
  } catch (err) {
    if (err.name !== 'NotFoundError') { // user cancelled = silent
      setPrinterStatus(`Connection failed: ${err.message}`, false);
      console.error(err);
    }
  }
}

async function disconnectPrinter() {
  if (!printerState.device) return;
  try {
    await printerState.device.releaseInterface(
      printerState.device.configuration.interfaces.find(i =>
        i.claimed
      )?.interfaceNumber ?? 0
    );
    await printerState.device.close();
  } catch { /* ignore */ }
  printerState.device = null;
  printerState.connected = false;
  updatePrinterUI();
  setPrinterStatus('Printer disconnected', false);
}

function setPrinterStatus(msg, connected) {
  const dot   = document.getElementById('printer-dot');
  const label = document.getElementById('printer-label');
  const status = document.getElementById('printer-status-text');
  const btn   = document.getElementById('connect-printer-btn');
  if (!dot) return;

  if (connected) {
    dot.className = 'printer-dot connected';
    label.textContent = 'Printer ready';
    btn.textContent = 'Disconnect';
    btn.classList.add('connected');
  } else {
    dot.className = 'printer-dot';
    label.textContent = 'No printer connected';
    btn.textContent = 'Connect Printer';
    btn.classList.remove('connected');
  }
  if (status) status.textContent = msg;

  // Mirror status to setup-screen printer indicators
  const sDot = document.getElementById('setup-printer-dot');
  const sLabel = document.getElementById('setup-printer-label');
  const sStatus = document.getElementById('setup-printer-status');
  const sBtn = document.getElementById('setup-printer-connect-btn');
  if (sDot) sDot.className = connected ? 'printer-dot connected' : 'printer-dot';
  if (sLabel) sLabel.textContent = connected ? 'Printer ready' : 'No printer connected';
  if (sStatus) sStatus.textContent = msg;
  if (sBtn) {
    sBtn.textContent = connected ? 'Disconnect' : 'Connect Printer';
    if (connected) sBtn.classList.add('connected'); else sBtn.classList.remove('connected');
  }
}

function setPrintingIndicator(msg) {
  const dot    = document.getElementById('printer-dot');
  const status = document.getElementById('printer-status-text');
  if (dot)    dot.className = msg ? 'printer-dot printing' : 'printer-dot connected';
  if (status) status.textContent = msg;
}

/** Re-syncs pack print / Print All visibility; print actions call ensurePrinterConnected() if needed */
function updatePrinterUI() {
  document.querySelectorAll('.pack-print-btn').forEach(btn => {
    btn.disabled = false;
  });
  const printAllBtn = document.getElementById('print-all-btn');
  if (printAllBtn) {
    printAllBtn.style.display = state.allPackFaces.length > 0 ? '' : 'none';
    printAllBtn.disabled = false;
  }
}

// ── PRINT JOBS ──

/**
 * Render one card face, convert to ESC/POS, send to printer.
 * isLastFace=true triggers a full paper cut; false feeds a spacer (between DFC faces).
 */
async function printCardFace(face, isLastFace, isLastCardInPack = true) {
  if (state.isPrintingCanceled) return;

  setPrintingIndicator(`Rendering ${face.name}...`);
  const cardCanvas  = await renderCardToCanvas(face);
  const printCanvas = processForPrint(cardCanvas);
  const escposData  = canvasToEscPosRaster(printCanvas);

  if (state.isPrintingCanceled) return;

  setPrintingIndicator(`Sending ${face.name} to printer...`);
  await printerSend(escposData);

  if (isLastFace) {
    const gangPrint = document.getElementById('gang-print-toggle')?.checked;
    if (gangPrint && !isLastCardInPack) {
      // Gang mode: feed spacer instead of cutting between cards
      await printerSend(new Uint8Array([0x1B, 0x4A, 0x14]));
      await sleep(300);
    } else {
      await printerSend(new Uint8Array([0x1D, 0x56, 0x42, 0x00]));
      await sleep(1500);
    }
  } else {
    // Small feed between DFC faces (ESC d n = print and feed n lines)
    await printerSend(new Uint8Array([0x1B, 0x64, 0x01]));
    await sleep(1000);
  }
}

/**
 * Full print job for one pack.
 * Prints text header → cut → each card face in order → cut after each card.
 * Mirrors Python's print_card_list() and the pack header block in main().
 */
async function printPack(faces, header, triggerBtn) {
  if (!(await ensurePrinterConnected())) return;

  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.classList.add('printing');
    triggerBtn.textContent = 'Printing...';
  }

  try {
    if (state.isPrintingCanceled) return;
    const enc = new TextEncoder();

    await printerSend(new Uint8Array([0x1B, 0x40]));
    await printerSend(new Uint8Array([0x1f,0x1b,0x1f,0x01]));
    await printerSend(new Uint8Array([0x1f,0x1b,0x1f,0x0a]));
    await printerSend(new Uint8Array([0x1B, 0x61, 0x01]));
    await printerSend(enc.encode('\n================================\n'));
    await printerSend(new Uint8Array([0x1B, 0x45, 0x01]));
    await printerSend(enc.encode(`--- ${header.title}: ${header.setName} ---\n`));
    await printerSend(new Uint8Array([0x1B, 0x45, 0x00]));
    await printerSend(enc.encode('================================\n'));

    if (state.includeChecklistHeaders) {
      const listLines = checklistLinesFromCardNames(cardDisplayNamesFromFaces(faces));
      await printerSend(new Uint8Array([0x1B, 0x61, 0x00]));
      for (const line of listLines) {
        await printerSend(enc.encode(line + '\n'));
      }
      await printerSend(enc.encode('\n'));
    }

    await printerSend(new Uint8Array([0x1B, 0x61, 0x01]));
    await printerSend(enc.encode('\n'));
    await printerSend(new Uint8Array([0x1D, 0x56, 0x42, 0x00]));
    await sleep(1000);

    const groups = groupDFCFaces(faces);

    for (let gi = 0; gi < groups.length; gi++) {
      if (state.isPrintingCanceled) break;
      const group = groups[gi];
      const isLastCard = gi === groups.length - 1;
      for (let fi = 0; fi < group.length; fi++) {
        if (state.isPrintingCanceled) break;
        await printCardFace(group[fi], fi === group.length - 1, isLastCard);
      }
    }

    if (!state.isPrintingCanceled) {
      setPrintingIndicator('Pack printed successfully!');
      setTimeout(() => setPrintingIndicator(''), 3000);
    }
  } catch (err) {
    if (!state.isPrintingCanceled) {
      setPrintingIndicator(`Print error: ${err.message}`);
      console.error(err);
    }
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.classList.remove('printing');
      triggerBtn.textContent = 'Print Pack';
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// CARD LIGHTBOX -- enlarged card view with arrow-key / swipe nav
// ═══════════════════════════════════════════════════════════════
const lightbox = {
  el: null,
  inner: null,
  caption: null,
  index: [],       // flat list of {faces: [face,...], packIdx, label}
  current: -1,
  touchStartX: 0,
  touchStartY: 0,
};

function buildLightboxIndex() {
  lightbox.index = [];
  for (let p = 0; p < state.allPackFaces.length; p++) {
    const faces = state.allPackFaces[p];
    const hdr = state.allPackHeaders[p];
    const label = `${hdr.title} · ${hdr.setName}`;
    for (const group of groupDFCFaces(faces)) {
      lightbox.index.push({ faces: group, packIdx: p, label });
    }
  }
}

function openLightbox(packIdx, cardIdxInPack) {
  buildLightboxIndex();
  if (!lightbox.index.length) return;

  let globalIdx = 0;
  let count = 0;
  for (let i = 0; i < lightbox.index.length; i++) {
    if (lightbox.index[i].packIdx === packIdx) {
      if (count === cardIdxInPack) { globalIdx = i; break; }
      count++;
    }
  }

  if (!lightbox.el) createLightboxDOM();
  lightbox._previousFocus = document.activeElement;
  document.body.appendChild(lightbox.el);
  showLightboxCard(globalIdx);
  requestAnimationFrame(() => {
    lightbox.el.classList.add('visible');
    const closeBtn = lightbox.el.querySelector('.card-lightbox-close');
    if (closeBtn) closeBtn.focus();
  });
}

function closeLightbox() {
  if (!lightbox.el) return;
  lightbox.el.classList.remove('visible');
  setTimeout(() => { if (lightbox.el?.parentNode) lightbox.el.parentNode.removeChild(lightbox.el); }, 200);
  lightbox.current = -1;
  if (lightbox._previousFocus) {
    lightbox._previousFocus.focus();
    lightbox._previousFocus = null;
  }
}

async function showLightboxCard(idx) {
  if (idx < 0 || idx >= lightbox.index.length) return;
  lightbox.current = idx;
  const entry = lightbox.index[idx];

  if (!lightbox.inner) return;
  lightbox.inner.innerHTML = '';
  lightbox.inner.classList.remove('flipped');

  const frontImg = document.createElement('img');
  frontImg.className = 'card-front';
  frontImg.src = entry.faces[0].imageUri || '';
  frontImg.alt = entry.faces[0].name;
  frontImg.draggable = false;
  lightbox.inner.appendChild(frontImg);

  if (entry.faces.length > 1) {
    const backImg = document.createElement('img');
    backImg.className = 'card-back';
    backImg.src = entry.faces[1].imageUri || '';
    backImg.alt = entry.faces[1].name;
    backImg.draggable = false;
    lightbox.inner.appendChild(backImg);

    const flipBtn = document.createElement('button');
    flipBtn.className = 'card-lightbox-flip';
    flipBtn.textContent = '↔';
    flipBtn.title = 'Flip card';
    flipBtn.setAttribute('aria-label', 'Flip card');
    flipBtn.addEventListener('click', (e) => { e.stopPropagation(); lightbox.inner.classList.toggle('flipped'); });
    lightbox.inner.appendChild(flipBtn);
  }

  if (state.thermalPreview) {
    try {
      const frontCanvas = await renderCardToCanvas(entry.faces[0]);
      if (lightbox.current === idx) frontImg.src = frontCanvas.toDataURL('image/png');
    } catch { /* keep original */ }

    if (entry.faces.length > 1) {
      try {
        const backCanvas = await renderCardToCanvas(entry.faces[1]);
        const backEl = lightbox.inner.querySelector('.card-back');
        if (lightbox.current === idx && backEl) backEl.src = backCanvas.toDataURL('image/png');
      } catch { /* keep original */ }
    }
  }

  if (lightbox.caption) {
    const cardName = entry.faces[0].name + (entry.faces.length > 1 ? ' // ' + entry.faces[1].name : '');
    lightbox.caption.textContent = `${cardName}  ·  ${entry.label}`;
  }
}

function lightboxNav(delta) {
  if (lightbox.current < 0) return;
  let next = lightbox.current + delta;
  if (next >= lightbox.index.length) next = 0;
  if (next < 0) next = lightbox.index.length - 1;
  showLightboxCard(next);
}

function createLightboxDOM() {
  const overlay = document.createElement('div');
  overlay.className = 'card-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Card viewer');
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target === wrap) closeLightbox();
  });

  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;';
  overlay.appendChild(wrap);

  const prevBtn = document.createElement('button');
  prevBtn.className = 'card-lightbox-nav prev';
  prevBtn.textContent = '‹';
  prevBtn.setAttribute('aria-label', 'Previous card');
  prevBtn.addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(-1); });
  wrap.appendChild(prevBtn);

  const inner = document.createElement('div');
  inner.className = 'card-lightbox-inner';
  wrap.appendChild(inner);
  lightbox.inner = inner;

  const nextBtn = document.createElement('button');
  nextBtn.className = 'card-lightbox-nav next';
  nextBtn.textContent = '›';
  nextBtn.setAttribute('aria-label', 'Next card');
  nextBtn.addEventListener('click', (e) => { e.stopPropagation(); lightboxNav(1); });
  wrap.appendChild(nextBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'card-lightbox-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Close card viewer');
  closeBtn.addEventListener('click', closeLightbox);
  overlay.appendChild(closeBtn);

  const caption = document.createElement('div');
  caption.className = 'card-lightbox-caption';
  overlay.appendChild(caption);
  lightbox.caption = caption;

  // Touch swipe handling
  overlay.addEventListener('touchstart', (e) => {
    lightbox.touchStartX = e.changedTouches[0].clientX;
    lightbox.touchStartY = e.changedTouches[0].clientY;
  }, { passive: true });

  overlay.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - lightbox.touchStartX;
    const dy = e.changedTouches[0].clientY - lightbox.touchStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      lightboxNav(dx < 0 ? 1 : -1);
    }
  }, { passive: true });

  lightbox.el = overlay;
}

function setupLightboxKeys() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const helpOverlay = document.getElementById('help-overlay');
      if (helpOverlay?.classList.contains('visible')) {
        closeHelpModal();
        e.preventDefault();
        return;
      }
      if (lightbox.current >= 0) { closeLightbox(); e.preventDefault(); }
      return;
    }
    if (lightbox.current < 0) return;
    if (e.key === 'ArrowRight') { lightboxNav(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft') { lightboxNav(-1); e.preventDefault(); }
  });
}

document.addEventListener('DOMContentLoaded', init);
