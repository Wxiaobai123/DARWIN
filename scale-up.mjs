import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const file = resolve(process.cwd(), 'dashboard.html');
let html = readFileSync(file, 'utf8');

// ─── Safe replacement using regex with property-scoped matching ───
// Instead of blind replaceAll which cascades, we use regex to match
// "property:value" or "property: value" and replace in one pass per property.

function scaleProperty(prop, map) {
  // Sort keys by length descending to avoid partial matches (e.g., 12px before 2px)
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  // Build regex: property:\s*VALUE (where VALUE is one of our keys)
  const pattern = new RegExp(
    `(${prop}:\\s*)(${keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?=[;}"'\\s,])`,
    'g'
  );
  html = html.replace(pattern, (match, prefix, val) => prefix + map[val]);
}

// For two-value padding patterns: padding: Xpx Ypx
function scalePaddingPairs(pairs) {
  for (const [from, to] of pairs) {
    // Use markers to prevent cascading - replace with a unique temp that won't match
    const marker = `padding:⟦${to}⟧`;
    const marker2 = `padding: ⟦${to}⟧`;
    html = html.replaceAll(`padding:${from}`, marker);
    html = html.replaceAll(`padding: ${from}`, marker2);
  }
  // Now replace all markers back to real values
  html = html.replace(/padding:(?: )?⟦([^⟧]+)⟧/g, (m, val) => {
    return m.includes(': ⟦') ? `padding: ${val}` : `padding:${val}`;
  });
}

// For three-value padding patterns like "padding: 24px 20px 20px"
function scalePaddingTriples(triples) {
  for (const [from, to] of triples) {
    html = html.replaceAll(`padding: ${from}`, `padding: ${to}`);
    html = html.replaceAll(`padding:${from}`, `padding:${to}`);
  }
}

// ─── Font-size mapping ───
const fontMap = {
  '7px': '9px', '8px': '10px', '9px': '11px', '10px': '13px',
  '11px': '14px', '12px': '15px', '13px': '16px', '14px': '17px',
  '15px': '19px', '16px': '20px', '17px': '21px', '18px': '22px',
  '20px': '25px', '22px': '27px', '24px': '30px', '26px': '32px',
  '28px': '35px', '32px': '40px', '42px': '52px', '52px': '64px',
  '56px': '68px',
};
scaleProperty('font-size', fontMap);

// ─── Sidebar width ───
html = html.replaceAll('--sidebar-w: 220px', '--sidebar-w: 260px');
html = html.replaceAll('--sidebar-w:220px', '--sidebar-w:260px');

// ─── Padding pairs (two-value) ───
const padPairs = [
  ['24px 30px', '28px 36px'],
  ['24px 28px', '28px 34px'],
  ['24px 20px 20px', '28px 24px 24px'], // sidebar-header triple
  ['20px 24px', '24px 28px'],
  ['20px 20px', '24px 24px'],
  ['18px 24px', '22px 28px'],
  ['18px 22px', '22px 26px'],
  ['16px 24px', '20px 28px'],
  ['16px 20px', '20px 24px'],
  ['16px 18px', '20px 22px'],
  ['16px 16px', '20px 20px'],
  ['14px 24px', '18px 28px'],
  ['14px 22px', '18px 26px'],
  ['14px 20px', '18px 24px'],
  ['14px 18px', '18px 22px'],
  ['14px 16px', '18px 20px'],
  ['14px 14px', '18px 18px'],
  ['12px 20px', '15px 24px'],
  ['12px 18px', '15px 22px'],
  ['12px 16px', '15px 20px'],
  ['12px 14px', '15px 18px'],
  ['12px 12px', '15px 15px'],
  ['10px 16px', '12px 20px'],
  ['10px 14px', '12px 18px'],
  ['10px 12px', '12px 15px'],
  ['10px 10px', '12px 12px'],
  ['8px 16px', '10px 20px'],
  ['8px 14px', '10px 18px'],
  ['8px 12px', '10px 15px'],
  ['8px 10px', '10px 12px'],
  ['8px 8px', '10px 10px'],
  ['6px 12px', '8px 15px'],
  ['6px 10px', '8px 12px'],
  ['6px 8px', '8px 10px'],
  ['6px 6px', '8px 8px'],
  ['5px 11px', '6px 14px'],
  ['5px 10px', '6px 12px'],
  ['5px 8px', '6px 10px'],
  ['5px 6px', '6px 8px'],
  ['5px 5px', '6px 6px'],
  ['4px 10px', '5px 12px'],
  ['4px 8px', '5px 10px'],
  ['4px 6px', '5px 8px'],
  ['4px 4px', '5px 5px'],
  ['3px 10px', '4px 12px'],
  ['3px 8px', '4px 10px'],
  ['3px 6px', '4px 8px'],
  ['3px 5px', '4px 6px'],
  ['2px 8px', '3px 10px'],
  ['2px 6px', '3px 8px'],
  ['2px 5px', '3px 6px'],
  ['1px 5px', '2px 6px'],
  ['1px 4px', '2px 5px'],
];
scalePaddingPairs(padPairs);

// ─── Gap scaling ───
const gapMap = {
  '3px': '4px', '4px': '5px', '5px': '6px', '6px': '8px',
  '8px': '10px', '10px': '12px', '12px': '15px', '14px': '18px',
  '16px': '20px',
};
scaleProperty('gap', gapMap);

// ─── Border-radius scaling ───
const radiusMap = {
  '3px': '4px', '4px': '5px', '5px': '6px', '6px': '8px', '7px': '9px',
  '8px': '10px', '9px': '11px', '10px': '12px', '12px': '14px', '14px': '18px', '16px': '20px',
};
scaleProperty('border-radius', radiusMap);

// ─── margin-bottom scaling ───
const mbMap = {
  '3px': '4px', '4px': '5px', '6px': '8px', '8px': '10px',
  '10px': '12px', '12px': '15px', '14px': '18px', '16px': '20px',
  '20px': '24px', '24px': '28px',
};
scaleProperty('margin-bottom', mbMap);

// ─── Specific CSS class overrides ───
// .card padding + radius
html = html.replace(
  '.card {\n  background: var(--card); border: 1px solid var(--border);\n  border-radius: 12px; padding: 20px;',
  '.card {\n  background: var(--card); border: 1px solid var(--border);\n  border-radius: 14px; padding: 24px;'
);

// .main padding
html = html.replace(
  '.main { margin-left: var(--sidebar-w); flex: 1; padding: 20px 24px; min-height: 100vh; }',
  '.main { margin-left: var(--sidebar-w); flex: 1; padding: 24px 28px; min-height: 100vh; }'
);

// topbar padding
html = html.replace(
  'padding: 16px 20px; background: var(--card)',
  'padding: 20px 24px; background: var(--card)'
);

// ─── Width/height for specific elements ───
// Scaling inline width/height values for icons, dots, etc. using regex approach
const whMap = {
  '6px': '8px', '8px': '10px', '10px': '12px', '12px': '15px',
  '14px': '18px', '16px': '20px', '18px': '22px', '20px': '24px',
  '24px': '28px', '28px': '34px', '32px': '38px',
};
scaleProperty('width', whMap);
scaleProperty('height', whMap);

// ─── SVG architecture diagram ───
html = html.replace('r="40" fill="var(--card-solid)"', 'r="48" fill="var(--card-solid)"');
html = html.replaceAll('r="40" fill="none"', 'r="48" fill="none"');
html = html.replace('values="40;52;40"', 'values="48;62;48"');
html = html.replace('viewBox="0 0 510 400"', 'viewBox="0 0 560 440"');
html = html.replace('r = 44', 'r = 52');

// SVG node positions
html = html.replace("x:110, y:70", "x:120, y:75");
html = html.replace("x:400, y:70", "x:440, y:75");
html = html.replace("x:255, y:190", "x:280, y:210");
html = html.replace("x:125, y:320", "x:135, y:355");
html = html.replace("x:385, y:320", "x:425, y:355");

// background-size for body dots
html = html.replace('background-size: 24px 24px', 'background-size: 28px 28px');

writeFileSync(file, html, 'utf8');
console.log('Done! Scaled up dashboard.html (cascade-safe)');
