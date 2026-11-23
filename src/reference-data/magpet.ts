export const municipalOffices = ([
  ['1011', 'Office of the Municipal Mayor (OMM)'],
  ['1011 (1)', 'OMM – Tourism Unit', '1011'],
  ['1011 (2)', 'OMM – Market Operations Unit', '1011'],
  ['1011 (3)', 'OMM – Business Permits and Licensing Office (BPLO)', '1011'],
  ['1011 (4)', 'OMM – Local Economic Development and Investment Promotion Office (LEDIPO)', '1011'],
  ['1011 (5)', 'OMM – Tribal Affairs Unit', '1011'],
  ['1021', 'Sangguniang Bayan – Legislative Office'],
  ['1022', 'Sangguniang Bayan Secretariat'],
  ['1031', 'Human Resource Management Office (HRMO)'],
  ['1041', 'Municipal Planning and Development Office (MPDO)'],
  ['1051', 'Office of the Municipal Civil Registrar (MCR)'],
  ['1061', 'Municipal General Services Office (MGSO)'],
  ['1071', 'Municipal Budget Office (MBO)'],
  ['1081', 'Municipal Accounting Office'],
  ['1091', "Municipal Treasurer's Office (MTO)"],
  ['1101', 'Office of the Municipal Assessor'],
  ['4411', 'Municipal Health Office (MHO)'],
  ['5999', 'Public Employment Service Office (PESO)'],
  ['7611', 'Municipal Social Welfare and Development Office (MSWDO)'],
  ['7999', 'Persons with Disability Affairs Office (PDAO)'],
  ['8711', 'Office of the Municipal Agricultural Services (OMAS)'],
  ['8731', 'Municipal Environment and Natural Resources Office (MENRO)'],
  ['8751', 'Municipal Engineering Office (MEO)'],
  ['9991', 'Municipal Disaster Risk Reduction and Management Office (MDRRMO)'],
] as const).map(([code, name, parentCode]) => ({ code, name, parentCode: parentCode ?? null }));

export const baselineFunds = [
  { code: '100', name: 'General Fund' },
  { code: '200', name: 'Special Education Fund' },
  { code: '300', name: 'Trust Fund' },
];

export const baselineExpenditureClassifications = [
  { code: 'PS', name: 'Personal Services', kind: 'class' },
  { code: 'MOOE', name: 'Maintenance and Other Operating Expenses', kind: 'class' },
  { code: 'CO', name: 'Capital Outlay', kind: 'class' },
  { code: 'FE', name: 'Financial Expenses', kind: 'class' },
  { code: 'SPA', name: 'Special Purpose Appropriations', kind: 'grouping' },
] as const;
