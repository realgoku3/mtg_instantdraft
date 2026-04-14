// Pure data constants — kept separate from app.js for readability.
// Loaded via <script> before app.js.

const BONUS_SHEETS = {
  sos: ['soa', 'spg'],
  stx: ['sta'],
  bro: ['brr'],
  mom: ['mul'],
  woe: ['wot'],
  mkm: ['spg'],
  otj: ['big', 'otp', 'spg'],
  blb: ['spg'],
  dsk: ['spg'],
  fdn: ['spg'],
};

// Two-set blocks intentionally repeat the large set so each drafter gets
// 2 packs of the large set + 1 of the small set (historical draft format).
const HISTORICAL_BLOCKS = {
  'ice age':              ['ice', 'all', 'csp'],
  'mirage':               ['mir', 'vis', 'wth'],
  'tempest':              ['tmp', 'sth', 'exo'],
  "urza's":               ['usg', 'ulg', 'uds'],
  'masques':              ['mmq', 'nem', 'pcy'],
  'invasion':             ['inv', 'pls', 'apc'],
  'odyssey':              ['ody', 'tor', 'jud'],
  'onslaught':            ['ons', 'lgn', 'scg'],
  'mirrodin':             ['mrd', 'dst', '5dn'],
  'kamigawa':             ['chk', 'bok', 'sok'],
  'ravnica':              ['rav', 'gpt', 'dis'],
  'time spiral':          ['tsp', 'plc', 'fut'],
  'lorwyn':               ['lrw', 'lrw', 'mor'],
  'shadowmoor':           ['shm', 'shm', 'eve'],
  'alara':                ['ala', 'con', 'arb'],
  'zendikar':             ['zen', 'wwk', 'roe'],
  'scars of mirrodin':    ['som', 'mbs', 'nph'],
  'innistrad':            ['isd', 'dka', 'avr'],
  'return to ravnica':    ['rtr', 'gtc', 'dgm'],
  'theros':               ['ths', 'bng', 'jou'],
  'khans of tarkir':      ['ktk', 'frf', 'dtk'],
  'battle for zendikar':  ['bfz', 'bfz', 'ogw'],
  'shadows over innistrad':['soi', 'soi', 'emn'],
  'kaladesh':             ['kld', 'kld', 'aer'],
  'amonkhet':             ['akh', 'akh', 'hou'],
  'ixalan':               ['xln', 'xln', 'rix'],
};

const CHAOS_EXCLUDED_SETS = new Set([
  'plst',  // The List — reprints inserted in other boosters, not a standalone product
  'ren',   // Renaissance — reprint product for European markets
  'rin',   // Rinascimento — Italian Renaissance
  'chr',   // Chronicles — all-reprint packs, not designed for draft
  'mat',   // March of the Machine: The Aftermath — 5-card Epilogue Boosters only
  'dbl',   // Innistrad: Double Feature — combined reprint set
  'jmp',   // Jumpstart — theme packs, not draft boosters
  'j22',   // Jumpstart 2022
]);

const FLAVOR_TEXTS_FALLBACK = [
  { text: '"Greatness, at any cost."', source: 'Dark Confidant' },
  { text: 'My Abattoir Ghoul deck is unstoppable. Wait, 1996 World Champion?', source: '—Johnny, to Spike' },
  { text: 'Who wants to see a picture of a big hairy ass?', source: 'Assquatch' },
  { text: 'Come, friends. Let us see if this world remembers us.', source: 'Abuelo, Ancestral Echo' },
];

const BURN_CHARS = [' ', '.', ',', ':', ';', '=', '+', '*', '?', '%', '#', '@'];
const BURN_CYCLE_MS = 6000;
const BURN_STAGGER_MS = 400;
const BURN_CHAR_MS = 350;
