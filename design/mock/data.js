// MOCK data for the design mockups. Shape is illustrative, not the API contract.
// Trait names live ONLY in MOCK.traits so the layout never hard-codes them.
(function () {
  let s = 20261116;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const gauss = () => { let u = 0; for (let i = 0; i < 6; i++) u += rnd(); return (u - 3) / 1.2; };
  const clamp = (v) => Math.max(0.02, Math.min(0.98, v));

  const traits = [
    { key: 't1', name: 'Openness', short: 'Open' },
    { key: 't2', name: 'Conscientiousness', short: 'Consc' },
    { key: 't3', name: 'Extraversion', short: 'Extra' },
    { key: 't4', name: 'Agreeableness', short: 'Agree' },
    { key: 't5', name: 'Neuroticism', short: 'Neuro' },
  ];

  const lineages = [
    { id: 1, name: 'HOPE', founder: 'EVE HOPE', founded: '00:00', extinct: false, color: 'var(--lin-1)', hex: '#c4573a', shape: 'circle', hair: 'Hope curls' },
    { id: 2, name: 'ASHGROVE', founder: 'EVE ASHGROVE', founded: '00:00', extinct: false, color: 'var(--lin-2)', hex: '#0e88a8', shape: 'square', hair: 'Ashgrove long' },
    { id: 3, name: 'KETTLE', founder: 'EVE KETTLE', founded: '04:10', extinct: true, extinctAt: '39:30', color: 'var(--lin-3)', hex: '#a07a1c', shape: 'triangle', hair: 'Kettle coils' },
    { id: 4, name: 'MOSS', founder: 'EVE MOSS', founded: '09:45', extinct: false, color: 'var(--lin-4)', hex: '#6b5aa6', shape: 'diamond', hair: 'Moss waves' },
  ];

  // lineage trait centres, so the cloud shows (mock) family resemblance
  const centre = {
    1: [0.42, 0.62, 0.55, 0.78, 0.40],
    2: [0.70, 0.72, 0.38, 0.50, 0.35],
    3: [0.50, 0.30, 0.45, 0.48, 0.70],
    4: [0.80, 0.40, 0.30, 0.42, 0.55],
  };

  // [first, lineage, sex, gen, age, alive, cause, mother, hairHex, role]
  const rows = [
    ['EVE', 1, 'F', 1, 51, true, null, null, '#4a9a50', 'forage'],
    ['JOY', 1, 'F', 2, 24, true, null, 'EVE HOPE', '#c8302a', 'care'],
    ['TOMAS', 1, 'M', 2, 19, true, null, 'EVE HOPE', '#d8b030', 'social'],
    ['ROWAN', 1, 'M', 2, 16, false, 'cold', 'EVE HOPE', '#2a9a9a', 'explore'],
    ['LARK', 1, 'F', 2, 0.4, false, 'starvation', 'EVE HOPE', '#d06090', null],
    ['TESS', 1, 'F', 2, 7, false, 'cold', 'EVE HOPE', '#c8302a', 'explore'],
    ['ABEL', 1, 'M', 3, 3, false, 'starvation', 'JOY HOPE', '#8a4ac0', null],
    ['FAITH', 1, 'F', 3, 0.6, true, null, 'JOY HOPE', '#3a5bd0', null],
    ['EVE', 2, 'F', 1, 44, true, null, null, '#2a9a9a', 'craft'],
    ['BRAM', 2, 'M', 2, 22, true, null, 'EVE ASHGROVE', '#8a4ac0', 'craft'],
    ['WREN', 2, 'F', 2, 6, true, null, 'EVE ASHGROVE', '#d06090', 'forage'],
    ['HAL', 2, 'M', 2, 12, false, 'starvation', 'EVE ASHGROVE', '#d8b030', 'explore'],
    ['BO', 2, 'M', 2, 27, false, 'cold', 'EVE ASHGROVE', '#3a5bd0', 'craft'],
    ['MIRA', 2, 'F', 2, 0.5, false, 'starvation', 'EVE ASHGROVE', '#4a9a50', null],
    ['KIT', 2, 'F', 2, 0.3, false, 'starvation', 'EVE ASHGROVE', '#c8302a', null],
    ['EVE', 3, 'F', 1, 31, false, 'cold', null, '#d8b030', 'explore'],
    ['PIP', 3, 'M', 2, 2, false, 'starvation', 'EVE KETTLE', '#c8302a', null],
    ['JUNO', 3, 'F', 2, 0.5, false, 'starvation', 'EVE KETTLE', '#8a4ac0', null],
    ['EVE', 4, 'F', 1, 28, true, null, null, '#d06090', 'explore'],
    ['ODO', 4, 'M', 2, 14, true, null, 'EVE MOSS', '#3a5bd0', 'explore'],
    ['IDA', 4, 'F', 2, 9, false, 'cold', 'EVE MOSS', '#4a9a50', 'forage'],
    ['SELA', 4, 'F', 2, 1, false, 'starvation', 'EVE MOSS', '#d8b030', null],
    ['NED', 4, 'M', 2, 0.4, false, 'starvation', 'EVE MOSS', '#2a9a9a', null],
  ];

  const people = rows.map((r, i) => {
    const [first, lin, sex, gen, age, alive, cause, mother, hair, role] = r;
    const L = lineages[lin - 1];
    const name = `${first} ${L.name}`;
    const t = {};
    traits.forEach((tr, k) => { t[tr.key] = +clamp(centre[lin][k] + gauss() * 0.11).toFixed(2); });
    return {
      id: 1000 + i, first, name, lineage: lin, sex, gen, age, alive, cause, mother, hair, role,
      slug: name.toLowerCase().replace(' ', '-'),
      img: `assets/people/${name.toLowerCase().replace(' ', '-')}-head.png`,
      body: `assets/people/${name.toLowerCase().replace(' ', '-')}-body.png`,
      traits: t,
    };
  });

  window.MOCK = { traits, lineages, people, rnd, gauss };
})();
