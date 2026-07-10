// Inline SVG "doodle" background used by the chat scroll area.
//
// Kept as a data-URL so we don't ship a static image asset. WhatsApp's
// classic light-theme doodle vibe: sparse, low-contrast icons scattered
// across a warm off-white base. Tiles at 240px so a large screen shows
// enough variety without repeat-fatigue.
//
// Colour: `#e2ddd2` on `#f7f4ef` — same base as the rest of the pane.

const SVG = `
<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'>
  <g fill='none' stroke='#e2ddd2' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round' opacity='0.9'>
    <!-- envelope -->
    <rect x='16' y='24' width='28' height='18' rx='2'/>
    <path d='M16 26 L30 36 L44 26'/>
    <!-- coffee cup -->
    <path d='M180 22 h20 v10 a8 8 0 0 1 -8 8 h-4 a8 8 0 0 1 -8 -8z'/>
    <path d='M200 24 h6 a4 4 0 0 1 0 8 h-6'/>
    <!-- chat bubble -->
    <path d='M96 44 a10 10 0 0 1 10 -10 h14 a10 10 0 0 1 10 10 v6 a10 10 0 0 1 -10 10 h-8 l-8 6 v-6 a10 10 0 0 1 -8 -10z'/>
    <!-- flower -->
    <circle cx='60' cy='96' r='3'/>
    <circle cx='54' cy='92' r='3'/><circle cx='66' cy='92' r='3'/>
    <circle cx='54' cy='100' r='3'/><circle cx='66' cy='100' r='3'/>
    <!-- gift -->
    <rect x='140' y='90' width='22' height='20' rx='2'/>
    <path d='M140 96 h22'/><path d='M151 90 v20'/>
    <path d='M151 90 c-4 -6 2 -10 4 -4 c2 -6 8 -2 4 4'/>
    <!-- book -->
    <path d='M20 150 h24 v18 h-24 z'/>
    <path d='M32 150 v18'/>
    <!-- headphones -->
    <path d='M100 156 a12 12 0 0 1 24 0'/>
    <rect x='96' y='154' width='6' height='12' rx='2'/>
    <rect x='122' y='154' width='6' height='12' rx='2'/>
    <!-- clock -->
    <circle cx='190' cy='160' r='10'/>
    <path d='M190 154 v6 l4 3'/>
    <!-- paperclip -->
    <path d='M40 210 l14 -14 a5 5 0 0 1 7 7 l-14 14 a3 3 0 0 1 -4 -4 l12 -12'/>
    <!-- balloon -->
    <ellipse cx='140' cy='208' rx='8' ry='10'/>
    <path d='M140 218 v10'/>
    <!-- star -->
    <path d='M204 208 l2 5 l6 0 l-5 4 l2 6 l-5 -4 l-5 4 l2 -6 l-5 -4 l6 0z'/>
    <!-- musical note -->
    <path d='M80 214 v-16 l10 -2 v14'/>
    <circle cx='78' cy='214' r='3'/><circle cx='88' cy='210' r='3'/>
  </g>
</svg>`;

/** Data-URL background suitable for Tailwind's arbitrary `bg-[url(...)]`. */
export const CHAT_BG_DATA_URL = `url("data:image/svg+xml;utf8,${encodeURIComponent(SVG.trim())}")`;
